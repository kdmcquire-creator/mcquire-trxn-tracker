// src/main/ipc-handlers.ts
// All app-level IPC handlers (setup wizard, transactions, rules, settings, etc.)

import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import * as path from 'path'
import type { CompatDb } from '../../electron/services/database'
import { reclassifyPendingAfterRuleChange, invalidateTripDateCache, learnFromClassification } from '../../electron/services/classification-engine'
import { saveClaudeApiKey, hasClaudeApiKey, deleteClaudeApiKey, suggestClassification, suggestBatch } from '../../electron/services/claude-classifier'
import { configureOllama, isOllamaEnabled, getOllamaModel, testOllamaConnection, classifyWithOllama, loadHistoricalDecisions } from '../../electron/services/ollama.service'
import { P10_CATEGORIES, LLC_CATEGORIES } from '../shared/types'

interface AppState {
  db: () => CompatDb | null
  mainWindow: () => BrowserWindow | null
  syncFolderPath: () => string
  setSyncFolderPath: (folder: string) => void
  saveSyncFolderPath: (folder: string) => void
  bootstrapServices: (folder: string) => Promise<void>
}

export function registerAppIpcHandlers(state: AppState): void {
  const { db: getDb, mainWindow: getMainWindow, syncFolderPath: getSyncFolder,
          setSyncFolderPath, saveSyncFolderPath, bootstrapServices } = state

  // ── Setup wizard: folder selection ─────────────────────────────────────────
  ipcMain.handle('app:select-folder', async () => {
    const win = getMainWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Sync Folder (inside Dropbox, OneDrive, or any folder)',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('app:get-sync-folder', () => getSyncFolder())

  ipcMain.handle('app:set-sync-folder', async (_event: Electron.IpcMainInvokeEvent, folder: string) => {
    setSyncFolderPath(folder)
    saveSyncFolderPath(folder)
    return { success: true }
  })

  ipcMain.handle('app:init-database', async (_event: Electron.IpcMainInvokeEvent, folder: string) => {
    const dbPath = path.join(folder, 'db', 'mcquire.db')
    const fs = require('fs')
    const isNew = !fs.existsSync(dbPath)

    if (folder !== getSyncFolder() || !getDb()) {
      setSyncFolderPath(folder)
      saveSyncFolderPath(folder)
      await bootstrapServices(folder)
    }

    return { isNew, success: true }
  })

  // ── General DB read/write helpers ──────────────────────────────────────────

  ipcMain.handle('db:get-setting', (_event: Electron.IpcMainInvokeEvent, key: string) => {
    const db = getDb()
    if (!db) return { success: false, error: 'DB not initialized' }
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return { success: true, data: row?.value ?? null }
  })

  ipcMain.handle('db:set-setting', (_event: Electron.IpcMainInvokeEvent, key: string, value: string) => {
    const db = getDb()
    if (!db) return { success: false, error: 'DB not initialized' }
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value)
    return { success: true }
  })

  ipcMain.handle('db:get-review-count', () => {
    const db = getDb()
    if (!db) return { success: true, data: 0 }
    const row = db
      .prepare("SELECT COUNT(*) as n FROM transactions WHERE review_status IN ('pending_review', 'flagged')")
      .get() as { n: number }
    return { success: true, data: row.n }
  })

  ipcMain.handle('db:get-bucket-totals', () => {
    const db = getDb()
    if (!db) return { success: true, data: {} }
    const rows = db
      .prepare(
        `SELECT t.bucket, SUM(ABS(t.amount)) as total, COUNT(*) as count
         FROM transactions t
         WHERE t.bucket != 'Exclude' AND t.bucket IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM transactions _sp WHERE _sp.split_parent_id = t.id)
         GROUP BY t.bucket`
      )
      .all() as Array<{ bucket: string; total: number; count: number }>
    const result: Record<string, { total: number; count: number }> = {}
    for (const r of rows) result[r.bucket] = { total: r.total, count: r.count }
    return { success: true, data: result }
  })

  // ── Transaction read/write ─────────────────────────────────────────────────

  ipcMain.handle('transactions:get-pending', () => {
    const db = getDb()
    if (!db) return { success: true, data: [] }
    const rows = db
      .prepare(
        `SELECT t.*, a.institution, a.account_name, a.account_mask
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.review_status IN ('pending_review', 'flagged')
           AND t.is_split_child = 0
         ORDER BY t.transaction_date DESC
         LIMIT 200`
      )
      .all()
    return { success: true, data: rows }
  })

  ipcMain.handle('transactions:classify', async (_event: Electron.IpcMainInvokeEvent, id: string, update: Record<string, any>) => {
    const db = getDb()
    if (!db) return { success: false, error: 'DB not initialized' }
    const allowed = ['bucket', 'p10_category', 'llc_category', 'description_notes', 'review_status', 'flag_reason', 'period_label']
    const fields = Object.keys(update).filter((k) => allowed.includes(k))
    if (fields.length === 0) return { success: false, error: 'No valid fields to update' }
    const set = fields.map((f) => `${f} = ?`).join(', ')
    db.prepare(`UPDATE transactions SET ${set}, updated_at = datetime('now') WHERE id = ?`)
      .run(...fields.map((f) => update[f]), id)

    // Learning engine: auto-generate rules from patterns, flag contradictions
    // Uses Ollama (if available) for multi-factor analysis
    let learned: { ruleCreated: boolean; ruleName?: string; requeuedCount: number } | undefined
    if (update.review_status === 'manually_classified') {
      try {
        learned = await learnFromClassification(db, id)
      } catch (err) {
        console.error('[Learning] Error:', err)
      }
    }

    return { success: true, learned }
  })

  ipcMain.handle('transactions:run-rules-all', () => {
    const db = getDb()
    if (!db) return { success: false, error: 'DB not initialized' }
    const result = reclassifyPendingAfterRuleChange(db)
    return { success: true, ...result }
  })

  ipcMain.handle('transactions:get-all', (_event: Electron.IpcMainInvokeEvent, filters: Record<string, any> = {}) => {
    const db = getDb()
    if (!db) return { success: true, data: [] }
    let sql = `
      SELECT t.*, a.institution, a.account_name, a.account_mask
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE (t.bucket != 'Exclude' OR t.bucket IS NULL)
      AND NOT EXISTS (SELECT 1 FROM transactions _sp WHERE _sp.split_parent_id = t.id)`
    const params: any[] = []
    if (filters.bucket) { sql += ' AND t.bucket = ?'; params.push(filters.bucket) }
    if (filters.startDate) { sql += ' AND t.transaction_date >= ?'; params.push(filters.startDate) }
    if (filters.endDate) { sql += ' AND t.transaction_date <= ?'; params.push(filters.endDate) }
    if (filters.search) { sql += ' AND t.merchant_name LIKE ?'; params.push(`%${filters.search}%`) }
    const limitVal = Math.max(1, Math.min(Math.floor(Number(filters.limit) || 2000), 10000))
    sql += ' ORDER BY t.transaction_date DESC LIMIT ?'
    params.push(limitVal)
    const rows = db.prepare(sql).all(...params)
    return { success: true, data: rows }
  })

  ipcMain.handle('transactions:split', (_event: Electron.IpcMainInvokeEvent, parentId: string, fragments: Array<{ bucket: string; amount: number; category: string; notes?: string }>) => {
    const db = getDb()
    if (!db) return { success: false, error: 'DB not initialized' }
    const { v4: uuidv4 } = require('uuid')
    const tx = db.transaction(() => {
      db.prepare("UPDATE transactions SET is_split_child = 0, review_status = 'manually_classified', updated_at = datetime('now') WHERE id = ?").run(parentId)
      for (const frag of fragments) {
        db.prepare(
          `INSERT INTO transactions
            (id, account_id, transaction_date, description_raw, merchant_name, amount,
             bucket, p10_category, llc_category, description_notes, review_status,
             split_parent_id, is_split_child, created_at, updated_at)
           SELECT ?, account_id, transaction_date, description_raw, merchant_name, ?,
             ?, ?, ?, ?, 'manually_classified', ?, 1, datetime('now'), datetime('now')
           FROM transactions WHERE id = ?`
        ).run(uuidv4(), frag.amount, frag.bucket, frag.bucket === 'Peak 10' ? frag.category : null, frag.bucket === 'Moonsmoke LLC' ? frag.category : null, frag.notes || null, parentId, parentId)
      }
    })
    tx()
    return { success: true }
  })

  // ── Notes history (for review queue suggestions) ──────────────────────────

  ipcMain.handle('transactions:get-recent-notes', (_event: Electron.IpcMainInvokeEvent, filters?: { category?: string; merchant?: string }) => {
    const db = getDb()
    if (!db) return { success: true, data: [] }
    try {
      const results: Array<{ note: string; use_count: number; last_used: string }> = []

      // Notes for the specific category (most relevant)
      if (filters?.category) {
        const catRows = db.prepare(`
          SELECT description_notes as note, COUNT(*) as use_count, MAX(updated_at) as last_used
          FROM transactions
          WHERE description_notes IS NOT NULL AND description_notes != ''
            AND review_status = 'manually_classified'
            AND (p10_category = ? OR llc_category = ?)
          GROUP BY description_notes
          ORDER BY use_count DESC, last_used DESC
          LIMIT 15
        `).all(filters.category, filters.category) as typeof results
        results.push(...catRows)
      }

      // Notes for this merchant (also relevant)
      if (filters?.merchant) {
        const merchRows = db.prepare(`
          SELECT description_notes as note, COUNT(*) as use_count, MAX(updated_at) as last_used
          FROM transactions
          WHERE description_notes IS NOT NULL AND description_notes != ''
            AND review_status = 'manually_classified'
            AND merchant_name LIKE ?
          GROUP BY description_notes
          ORDER BY use_count DESC, last_used DESC
          LIMIT 10
        `).all(`%${filters.merchant}%`) as typeof results
        for (const r of merchRows) {
          if (!results.some(x => x.note === r.note)) results.push(r)
        }
      }

      // If we still have few results, add globally popular notes
      if (results.length < 5) {
        const globalRows = db.prepare(`
          SELECT description_notes as note, COUNT(*) as use_count, MAX(updated_at) as last_used
          FROM transactions
          WHERE description_notes IS NOT NULL AND description_notes != ''
            AND review_status = 'manually_classified'
          GROUP BY description_notes
          ORDER BY use_count DESC, last_used DESC
          LIMIT 10
        `).all() as typeof results
        for (const r of globalRows) {
          if (!results.some(x => x.note === r.note)) results.push(r)
        }
      }

      return { success: true, data: results }
    } catch (err: any) {
      return { success: false, error: err.message, data: [] }
    }
  })

  // ── Rule CRUD ──────────────────────────────────────────────────────────────

  ipcMain.handle('rules:get-all', () => {
    const db = getDb()
    if (!db) return { success: true, data: [] }
    const rows = db.prepare('SELECT * FROM rules ORDER BY priority_order ASC').all()
    return { success: true, data: rows }
  })

  ipcMain.handle('rules:save', (_event: Electron.IpcMainInvokeEvent, rule: Record<string, any>) => {
    const db = getDb()
    if (!db) return { success: false, error: 'DB not initialized' }
    try {
      const { v4: uuidv4 } = require('uuid')
      const id = rule.id || uuidv4()
      db.prepare(`
        INSERT INTO rules
          (id, rule_name, section, match_type, match_value, account_mask_filter,
           amount_min, amount_max, day_of_week_filter, date_from_filter, date_to_filter,
           bucket, p10_category, llc_category, description_notes, flag_reason, action,
           priority_order, is_active, notes, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          rule_name=excluded.rule_name, section=excluded.section, match_type=excluded.match_type,
          match_value=excluded.match_value, account_mask_filter=excluded.account_mask_filter,
          amount_min=excluded.amount_min, amount_max=excluded.amount_max,
          day_of_week_filter=excluded.day_of_week_filter, date_from_filter=excluded.date_from_filter,
          date_to_filter=excluded.date_to_filter, bucket=excluded.bucket,
          p10_category=excluded.p10_category, llc_category=excluded.llc_category,
          description_notes=excluded.description_notes, flag_reason=excluded.flag_reason,
          action=excluded.action, priority_order=excluded.priority_order,
          is_active=excluded.is_active, notes=excluded.notes, updated_at=datetime('now')
      `).run(
        id, rule.rule_name, rule.section, rule.match_type, rule.match_value,
        rule.account_mask_filter ?? null, rule.amount_min ?? null, rule.amount_max ?? null,
        rule.day_of_week_filter ?? null, rule.date_from_filter ?? null, rule.date_to_filter ?? null,
        rule.bucket, rule.p10_category ?? null, rule.llc_category ?? null,
        rule.description_notes ?? null, rule.flag_reason ?? null, rule.action,
        rule.priority_order, rule.is_active ?? 1, rule.notes ?? null
      )
      const { resolved } = reclassifyPendingAfterRuleChange(db)
      console.log(`[rules:save] rule saved (${id}), reclassify resolved ${resolved} pending txs`)
      return { success: true, data: id }
    } catch (err: any) {
      console.error('[rules:save] failed:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('rules:delete', (_event: Electron.IpcMainInvokeEvent, id: string) => {
    const db = getDb()
    if (!db) return { success: false }
    db.prepare("UPDATE rules SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(id)
    return { success: true }
  })

  // ── Personal trip exclusion dates ──────────────────────────────────────────

  ipcMain.handle('trips:get-all', () => {
    const db = getDb()
    if (!db) return { success: true, data: [] }
    return { success: true, data: db.prepare('SELECT * FROM personal_trip_dates ORDER BY start_date').all() }
  })

  ipcMain.handle('trips:save', (_event: Electron.IpcMainInvokeEvent, trip: { id?: string; trip_name: string; start_date: string; end_date: string }) => {
    const db = getDb()
    if (!db) return { success: false }
    const { v4: uuidv4 } = require('uuid')
    const id = trip.id || uuidv4()
    db.prepare(
      'INSERT INTO personal_trip_dates (id, trip_name, start_date, end_date) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET trip_name=excluded.trip_name, start_date=excluded.start_date, end_date=excluded.end_date'
    ).run(id, trip.trip_name, trip.start_date, trip.end_date)
    invalidateTripDateCache()
    return { success: true, data: id }
  })

  ipcMain.handle('trips:delete', (_event: Electron.IpcMainInvokeEvent, id: string) => {
    const db = getDb()
    if (!db) return { success: false }
    db.prepare('DELETE FROM personal_trip_dates WHERE id = ?').run(id)
    invalidateTripDateCache()
    return { success: true }
  })

  // ── Shell: open file in Explorer ───────────────────────────────────────────

  ipcMain.handle('shell:open-path', (_event: Electron.IpcMainInvokeEvent, filePath: string) => {
    const syncFolder = getSyncFolder()
    const resolved = path.resolve(filePath)
    if (syncFolder && !resolved.startsWith(path.resolve(syncFolder))) {
      return { success: false, error: 'Path outside sync folder' }
    }
    shell.showItemInFolder(resolved)
    return { success: true }
  })

  // ── Settings helpers ───────────────────────────────────────────────────────

  ipcMain.handle('settings:getAll', () => {
    const db = getDb()
    if (!db) return { success: true, data: {} }
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
    return { success: true, data: Object.fromEntries(rows.map(r => [r.key, r.value])) }
  })

  ipcMain.handle('settings:set', (_event: Electron.IpcMainInvokeEvent, key: string, value: string) => {
    const db = getDb()
    if (!db) return { success: false, error: 'DB not initialized' }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
    return { success: true }
  })

  // ── Email / SMTP ───────────────────────────────────────────────────────────

  ipcMain.handle('settings:getSmtp', () => {
    const { loadSmtpConfig } = require('../../electron/services/email-service')
    const cfg = loadSmtpConfig()
    if (!cfg) return { success: true, data: null }
    return { success: true, data: { ...cfg, password: '••••••••' } }
  })

  ipcMain.handle('settings:saveSmtp', (_event: Electron.IpcMainInvokeEvent, config: any) => {
    const db = getDb()
    const { storeSmtpConfig } = require('../../electron/services/email-service')
    const smtpType: string = config.type ?? 'gmail'
    const host = config.host ?? (smtpType === 'gmail' ? 'smtp.gmail.com' : smtpType === 'outlook' ? 'smtp.office365.com' : 'smtp.gmail.com')
    const port = config.port ?? (smtpType === 'gmail' ? 465 : 587)
    const secure = config.secure ?? (smtpType === 'gmail')
    storeSmtpConfig({ host, port, secure, user: config.email ?? config.user ?? '', password: config.password ?? '' })
    const emailAddr = config.email ?? config.user ?? ''
    if (emailAddr && db) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('notification_email', emailAddr)
    }
    return { success: true }
  })

  ipcMain.handle('settings:testEmail', async (_event: Electron.IpcMainInvokeEvent, toEmail?: string) => {
    const db = getDb()
    const { sendTestEmail } = require('../../electron/services/email-service')
    const emailAddr = toEmail ?? (db?.prepare("SELECT value FROM settings WHERE key = 'notification_email'").get() as any)?.value
    if (!emailAddr) return { success: false, error: 'No email address configured' }
    return await sendTestEmail(emailAddr)
  })

  // Legacy channels used by the setup wizard email step
  ipcMain.handle('email:save-smtp', (_event: Electron.IpcMainInvokeEvent, config: any) => {
    const db = getDb()
    const { storeSmtpConfig } = require('../../electron/services/email-service')
    const smtpType: string = config.type ?? 'gmail'
    const host = config.host ?? (smtpType === 'gmail' ? 'smtp.gmail.com' : smtpType === 'outlook' ? 'smtp.office365.com' : 'smtp.gmail.com')
    const port = config.port ?? (smtpType === 'gmail' ? 465 : 587)
    const secure = config.secure ?? (smtpType === 'gmail')
    storeSmtpConfig({ host, port, secure, user: config.email ?? config.user ?? '', password: config.password ?? '' })
    const emailAddr = config.email ?? config.user ?? ''
    if (emailAddr && db) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('notification_email', emailAddr)
    }
    return { success: true }
  })

  ipcMain.handle('email:send-test', async () => {
    const db = getDb()
    const { sendTestEmail } = require('../../electron/services/email-service')
    const row = db?.prepare("SELECT value FROM settings WHERE key = 'notification_email'").get() as { value: string } | undefined
    if (!row?.value) return { success: false, error: 'No email configured. Save SMTP settings first.' }
    return await sendTestEmail(row.value)
  })

  // ── Claude AI Classification ───────────────────────────────────────────────

  ipcMain.handle('claude:has-key', () => {
    return { success: true, data: hasClaudeApiKey() }
  })

  ipcMain.handle('claude:save-key', (_event: Electron.IpcMainInvokeEvent, apiKey: string) => {
    try {
      saveClaudeApiKey(apiKey)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('claude:delete-key', () => {
    deleteClaudeApiKey()
    return { success: true }
  })

  ipcMain.handle('claude:suggest', async (_event: Electron.IpcMainInvokeEvent, tx: any) => {
    const db = getDb()
    if (!db) return { success: false, error: 'DB not initialized' }
    try {
      const suggestion = await suggestClassification(tx, db)
      return { success: true, data: suggestion }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('claude:suggest-batch', async (_event: Electron.IpcMainInvokeEvent, transactions: any[]) => {
    const db = getDb()
    if (!db) return { success: false, error: 'DB not initialized' }
    try {
      const suggestions = await suggestBatch(transactions, db)
      return { success: true, data: suggestions }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── Ollama Local AI ─────────────────────────────────────────────────────────

  ipcMain.handle('ollama:test-connection', async () => {
    return await testOllamaConnection()
  })

  ipcMain.handle('ollama:get-config', () => {
    return { enabled: isOllamaEnabled(), model: getOllamaModel() }
  })

  ipcMain.handle('ollama:set-config', (_event: Electron.IpcMainInvokeEvent, config: { enabled?: boolean; model?: string }) => {
    configureOllama(config)
    const db = getDb()
    if (db) {
      if (config.enabled !== undefined) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('ollama_enabled', config.enabled ? '1' : '0')
      }
      if (config.model !== undefined) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('ollama_model', config.model)
      }
    }
    return { success: true }
  })

  ipcMain.handle('ollama:suggest', async (_event: Electron.IpcMainInvokeEvent, tx: any) => {
    const db = getDb()
    if (!db) return { success: false, error: 'DB not initialized' }
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const txDay = dayNames[new Date(tx.transaction_date + 'T12:00:00').getDay()]

    const history = loadHistoricalDecisions(db, tx.merchant_name ?? tx.description_raw ?? '')
    const buckets = ['Peak 10', 'Moonsmoke LLC', 'Watersound Investments LLC', 'Personal', 'Exclude']

    const result = await classifyWithOllama(
      { ...tx, day_of_week: txDay },
      history,
      buckets,
      P10_CATEGORIES,
      LLC_CATEGORIES
    )

    if (result) return { success: true, data: result }
    return { success: false, error: 'Ollama classification returned no result' }
  })

  // Load Ollama config from DB on startup
  const db = getDb()
  if (db) {
    const enabledRow = db.prepare("SELECT value FROM settings WHERE key = 'ollama_enabled'").get() as { value: string } | undefined
    const modelRow = db.prepare("SELECT value FROM settings WHERE key = 'ollama_model'").get() as { value: string } | undefined
    configureOllama({
      enabled: enabledRow?.value === '1',
      model: modelRow?.value || undefined,
    })
  }
}
