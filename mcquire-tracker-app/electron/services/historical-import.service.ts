// electron/services/historical-import.service.ts
//
// Phase 4 — Historical Data Import Wizard (backend)
// Handles importing the Monarch CSV export and optionally seeding from
// the existing McQuire_Tracker_v3.xlsx into SQLite.
//
// This is a one-time operation on first setup. The wizard walks Kyle through:
//   Step 1: Select Monarch CSV → preview → map columns → classify → import
//   Step 2: (Optional) Select existing Excel workbook → extract already-classified
//           transactions → merge into DB (skip duplicates)

import * as Papa from 'papaparse'
import * as fs from 'fs'
import * as crypto from 'crypto'
import type { CompatDb } from './database'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain, dialog } from 'electron'
import { normalizeMerchant, hashRow, classifyTransaction, loadActiveRules } from './classification-engine'

// ─── Monarch CSV column mapping ───────────────────────────────────────────────
// Monarch export columns: Date, Merchant, Category, Account, Original Statement,
// Notes, Amount, Tags, Owner, Business Entity


// Account name → mask lookup (from workflow doc)
const ACCOUNT_NAME_TO_MASK: Record<string, string> = {
  'K. MCQUIRE':          '5829',
  'K. McQuire':          '5829',
  'CREDIT CARD':         '9007',  // will need context to disambiguate 9007 vs 2419
  'BUS COMPLETE CHK':    '2255',
  'Main Checking':       '8178',
  'USAA':                '8178',
}

// Always-exclude Monarch categories
const EXCLUDE_CATEGORIES = new Set([
  'Credit Card Payment',
  'Transfer',
  'Transfers',
  'Payment',
])

export interface ImportPreview {
  total_rows: number
  date_range: { start: string; end: string }
  accounts_found: string[]
  excluded_count: number
  already_imported_count: number
  new_count: number
  columns_detected: string[]
  column_mapping_valid: boolean
  errors: string[]
}

export interface ImportProgress {
  stage: 'parsing' | 'deduplicating' | 'classifying' | 'inserting' | 'done' | 'error'
  current: number
  total: number
  message: string
  classified: number
  queued: number
  excluded: number
  duplicates: number
  errors: string[]
}

export class HistoricalImportService {
  private static instance: HistoricalImportService | null = null
  private db: CompatDb

  private constructor(db: CompatDb) {
    this.db = db
  }

  static getInstance(db: CompatDb): HistoricalImportService {
    if (!HistoricalImportService.instance) {
      HistoricalImportService.instance = new HistoricalImportService(db)
    }
    return HistoricalImportService.instance
  }

  // ─── Detect CSV format from headers ──────────────────────────────────────────

  private detectFormat(columns: string[]): 'monarch' | 'apple_card' | 'usaa' | 'unknown' {
    const cols = columns.map(c => c.trim())
    if (cols.includes('Transaction Date') && cols.includes('Clearing Date') && cols.includes('Purchased By')) return 'apple_card'
    if (cols.includes('Original Description') || (cols.includes('Date') && cols.includes('Status'))) return 'usaa'
    if (cols.includes('Date') && cols.includes('Merchant') && cols.includes('Amount') && cols.includes('Account')) return 'monarch'
    return 'unknown'
  }

  private getDateColumn(format: string): string {
    return format === 'apple_card' ? 'Transaction Date' : 'Date'
  }

  private getAmountColumn(format: string): string {
    return format === 'apple_card' ? 'Amount (USD)' : 'Amount'
  }

  private getAccountColumn(format: string): string {
    return format === 'apple_card' ? '' : 'Account'
  }

  // ─── Preview CSV before committing ───────────────────────────────────────────

  async previewCSV(filePath: string): Promise<ImportPreview> {
    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = Papa.parse(content, { header: true, skipEmptyLines: true })

    const errors: string[] = []
    if (parsed.errors.length > 0) {
      errors.push(...parsed.errors.slice(0, 5).map((e) => e.message))
    }

    const rows = parsed.data as Record<string, string>[]
    const columns = parsed.meta.fields || []

    const format = this.detectFormat(columns)
    const dateCol = this.getDateColumn(format)

    // Validate columns based on detected format
    let missingCols: string[] = []
    if (format === 'unknown') {
      missingCols = ['Could not detect CSV format (expected Monarch, Apple Card, or USAA)']
    } else if (format === 'apple_card') {
      const required = ['Transaction Date', 'Merchant', 'Amount (USD)']
      missingCols = required.filter(c => !columns.includes(c))
    } else if (format === 'usaa') {
      const required = ['Date', 'Description']
      missingCols = required.filter(c => !columns.includes(c))
    } else {
      const required = ['Date', 'Merchant', 'Amount', 'Account']
      missingCols = required.filter(c => !columns.includes(c))
    }
    if (missingCols.length > 0) {
      errors.push(`Missing required columns: ${missingCols.join(', ')}`)
    }

    const dates = rows
      .map((r) => r[dateCol])
      .filter(Boolean)
      .sort()

    const accountCol = this.getAccountColumn(format)
    const accountsFound = Array.from(new Set(rows.map((r) => (accountCol ? r[accountCol] : 'Apple Card')).filter(Boolean)))

    let excludedCount = 0
    let alreadyImported = 0
    let newCount = 0

    for (const row of rows) {
      const category = row['Category'] || ''
      if (EXCLUDE_CATEGORIES.has(category)) {
        excludedCount++
        continue
      }

      const hash = this.rowHash(row)
      const exists = this.db
        .prepare('SELECT id FROM transactions WHERE source_row_hash = ?')
        .get(hash)
      if (exists) {
        alreadyImported++
      } else {
        newCount++
      }
    }

    return {
      total_rows: rows.length,
      date_range: {
        start: dates[0] || '',
        end: dates[dates.length - 1] || '',
      },
      accounts_found: accountsFound,
      excluded_count: excludedCount,
      already_imported_count: alreadyImported,
      new_count: newCount,
      columns_detected: columns,
      column_mapping_valid: missingCols.length === 0,
      errors,
    }
  }

  // ─── Run the import ───────────────────────────────────────────────────────────

  async importCSV(
    filePath: string,
    onProgress: (progress: ImportProgress) => void
  ): Promise<{ imported: number; classified: number; queued: number; errors: string[] }> {
    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = Papa.parse(content, { header: true, skipEmptyLines: true })
    const rows = parsed.data as Record<string, string>[]
    const columns = parsed.meta.fields || []
    const format = this.detectFormat(columns)
    const dateCol = this.getDateColumn(format)
    const amountCol = this.getAmountColumn(format)
    const accountCol = this.getAccountColumn(format)

    const progress: ImportProgress = {
      stage: 'parsing',
      current: 0,
      total: rows.length,
      message: 'Parsing CSV…',
      classified: 0,
      queued: 0,
      excluded: 0,
      duplicates: 0,
      errors: [],
    }
    onProgress({ ...progress })

    let imported = 0
    let classified = 0
    let queued = 0
    const errors: string[] = []

    // Process in batches of 100 to allow progress updates
    const BATCH = 100
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH)
      progress.stage = i === 0 ? 'deduplicating' : 'classifying'
      progress.current = i
      progress.message = `Processing rows ${i}–${Math.min(i + BATCH, rows.length)} of ${rows.length}…`
      onProgress({ ...progress })

      const insertBatch = this.db.transaction((txRows: any[]) => {
        for (const txRow of txRows) {
          try {
            this.db
              .prepare(
                `INSERT OR IGNORE INTO transactions
                  (id, account_id, plaid_transaction_id, source_row_hash,
                   transaction_date, posting_date, description_raw, merchant_name,
                   amount, category_source, bucket, p10_category, llc_category,
                   description_notes, rule_id, review_status, flag_reason,
                   split_parent_id, is_split_child, period_label, expense_report_id,
                   created_at, updated_at)
                 VALUES
                  (?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, NULL,
                   datetime('now'), datetime('now'))`
              )
              .run(
                txRow.id, txRow.account_id, txRow.hash,
                txRow.transaction_date, txRow.description_raw, txRow.merchant_name,
                txRow.amount, txRow.category_source, txRow.bucket, txRow.p10_category,
                txRow.llc_category, txRow.description_notes, txRow.rule_id,
                txRow.review_status, txRow.flag_reason, txRow.period_label
              )
          } catch (err: any) {
            errors.push(`Row ${txRow.transaction_date} ${txRow.merchant_name}: ${err.message}`)
          }
        }
      })

      const processedBatch: any[] = []

      for (const row of batch) {
        const category = row['Category'] || ''
        if (EXCLUDE_CATEGORIES.has(category)) {
          progress.excluded++
          continue
        }

        // Resolve account FIRST so we can include account_mask in the hash
        // (must match the Plaid import path's hash format for cross-source dedup)
        const accountName = accountCol ? (row[accountCol] || '') : 'Apple Card'
        const accountResult = this.findOrCreateAccount(accountName)
        if (!accountResult) continue
        const { id: accountId, mask: accountMask } = accountResult

        const hash = this.rowHash(row, format, accountMask)
        const exists = this.db
          .prepare('SELECT id FROM transactions WHERE source_row_hash = ?')
          .get(hash)
        if (exists) {
          progress.duplicates++
          continue
        }

        // Cross-account dedup: same merchant + amount + date on a different account
        // means this charge already exists (e.g., DoorDash appearing on two cards).
        const merchantNorm = normalizeMerchant(
          row['Merchant'] || row['Original Statement'] || row['Description'] || ''
        )
        const txDate = this.normalizeDate(row[dateCol] || '')
        const txAmount = this.parseAmount(row[amountCol] || '0')
        const crossAcct = this.db
          .prepare(
            `SELECT COUNT(*) as n FROM transactions
             WHERE account_id != ?
               AND merchant_name = ?
               AND amount = ?
               AND transaction_date = ?
               AND bucket != 'Exclude'`
          )
          .get(accountId, merchantNorm, txAmount, txDate) as { n: number }
        if (crossAcct.n === 1) {
          // Insert as Exclude so the hash is recorded and we don't re-process
          this.db.prepare(
            `INSERT OR IGNORE INTO transactions
              (id, account_id, source_row_hash, transaction_date,
               description_raw, merchant_name, amount, category_source, bucket,
               review_status, flag_reason, is_split_child, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Exclude', 'auto_classified',
                     'Cross-account duplicate', 0, datetime('now'), datetime('now'))`
          ).run(
            uuidv4(), accountId, hash, txDate,
            row['Original Statement'] || row['Merchant'] || row['Description'] || '',
            merchantNorm, txAmount, row['Category'] || null
          )
          progress.duplicates++
          continue
        }

        const amount = this.parseAmount(row[amountCol] || '0')
        const merchantName = this.cleanMerchant(
          row['Merchant'] || row['Original Statement'] || row['Description'] || ''
        )

        const rawTx = {
          id: uuidv4(),
          account_id: accountId,
          account_mask: accountMask,
          hash,
          transaction_date: this.normalizeDate(row[dateCol] || ''),
          description_raw: row['Original Statement'] || row['Merchant'] || row['Description'] || '',
          merchant_name: merchantName,
          amount,
          category_source: category,
          bucket: null as string | null,
          p10_category: null as string | null,
          llc_category: null as string | null,
          description_notes: row['Notes'] || null,
          rule_id: null as string | null,
          review_status: 'pending_review',
          flag_reason: null as string | null,
          period_label: null as string | null,
        }

        // Run classification engine
        try {
          // classifyTransaction and loadActiveRules imported at top of file
          const rules = loadActiveRules(this.db)
          const result = classifyTransaction(rawTx, rules, this.db)
          Object.assign(rawTx, result)
          if (rawTx.bucket && rawTx.bucket !== 'Exclude') classified++
          else if (!rawTx.bucket) queued++
        } catch {
          queued++
        }

        processedBatch.push(rawTx)
      }

      if (processedBatch.length > 0) {
        insertBatch(processedBatch)
        imported += processedBatch.length
      }

      progress.classified = classified
      progress.queued = queued
      onProgress({ ...progress })
    }

    progress.stage = 'done'
    progress.current = rows.length
    progress.message = `Import complete. ${imported} transactions imported.`
    onProgress({ ...progress })

    return { imported, classified, queued, errors }
  }

  // ─── Helper methods ───────────────────────────────────────────────────────────

  /**
   * Compute a dedup hash that matches the Plaid import path.
   * Uses the same hashRow() format: JSON.stringify({date, amount, merchant, account_mask})
   * where merchant is normalized and account_mask is the 4-digit mask (not CSV account name).
   *
   * Falls back to a legacy pipe-delimited hash when account_mask isn't available
   * (e.g., during preview before account resolution).
   */
  private rowHash(row: Record<string, string>, format?: string, accountMask?: string): string {
    let date: string
    let merchant: string
    let amount: string

    if (format === 'apple_card') {
      date = row['Transaction Date'] || ''
      merchant = row['Merchant'] || ''
      amount = row['Amount (USD)'] || ''
    } else if (format === 'usaa') {
      date = row['Date'] || ''
      merchant = row['Description'] || ''
      amount = row['Amount'] || ''
    } else {
      date = row['Date'] || ''
      merchant = row['Merchant'] || ''
      amount = row['Amount'] || ''
    }

    // Normalize merchant the same way Plaid does
    const merchantNorm = normalizeMerchant(merchant)

    // Parse amount to a number the same way Plaid stores it (positive = expense)
    const amountNum = -(parseFloat(amount.replace(/[$,\s]/g, '')) || 0)

    // Normalize date to YYYY-MM-DD
    let dateNorm = date
    if (date.includes('/')) {
      const [month, day, year] = date.split('/')
      dateNorm = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    }

    if (accountMask) {
      // Match Plaid's hashRow format exactly
      return hashRow({ date: dateNorm, amount: amountNum, merchant: merchantNorm, account_mask: accountMask })
    }

    // Fallback for preview (no account resolved yet) — use legacy format
    const accountCol = format === 'apple_card' ? '' : (row['Account'] || '')
    const key = `${dateNorm}|${merchantNorm}|${amountNum}|${accountCol}`
    return crypto.createHash('sha256').update(key).digest('hex')
  }

  private findOrCreateAccount(accountName: string): { id: string; mask: string } | null {
    // Try to find existing account by name match
    const normalizedName = accountName.trim()

    // Try mask lookup first for known account names
    const mask = ACCOUNT_NAME_TO_MASK[normalizedName] ||
      Object.entries(ACCOUNT_NAME_TO_MASK).find(([k]) =>
        normalizedName.toLowerCase().includes(k.toLowerCase())
      )?.[1]

    if (mask) {
      const account = this.db
        .prepare("SELECT id, account_mask FROM accounts WHERE account_mask = ? AND is_active = 1 LIMIT 1")
        .get(mask) as { id: string; account_mask: string } | undefined
      if (account) return { id: account.id, mask: account.account_mask }
    }

    // Direct match by account_name
    const accountByName = this.db
      .prepare("SELECT id, account_mask FROM accounts WHERE account_name LIKE ? AND is_active = 1 LIMIT 1")
      .get(`%${normalizedName.slice(0, 12)}%`) as { id: string; account_mask: string } | undefined

    if (accountByName) return { id: accountByName.id, mask: accountByName.account_mask }

    // Create a placeholder account if none found
    const id = uuidv4()
    const derivedMask = mask || normalizedName.slice(-4)
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO accounts
            (id, institution, account_name, account_mask, account_type, entity,
             default_bucket, import_method, is_active, created_at)
           VALUES (?, 'Unknown', ?, ?, 'credit', 'Personal', 'Personal', 'watched_folder', 1, datetime('now'))`
        )
        .run(id, normalizedName, derivedMask)
      return { id, mask: derivedMask }
    } catch {
      return null
    }
  }

  private parseAmount(raw: string): number {
    // Monarch, USAA, and Apple Card CSVs all use bank-statement sign convention:
    // expenses (debits) are NEGATIVE, income/credits are POSITIVE.
    // Our convention (matching Plaid): positive = expense, negative = income/credit.
    // Negate to convert.
    const cleaned = raw.replace(/[$,\s]/g, '')
    return -(parseFloat(cleaned) || 0)
  }

  private normalizeDate(raw: string): string {
    // Handle MM/DD/YYYY or YYYY-MM-DD
    if (raw.includes('/')) {
      const [month, day, year] = raw.split('/')
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    }
    return raw
  }

  private cleanMerchant(raw: string): string {
    return raw
      .replace(/^(TST\*|SQ \*|PY \*|DoorDash\s+)/i, '')
      .replace(/\s+\d{3,}$/, '')
      .trim()
  }
}

// ─── IPC registration ─────────────────────────────────────────────────────────

export function registerHistoricalImportHandlers(
  db: CompatDb,
  getMainWindow: () => Electron.BrowserWindow | null
): void {
  const service = HistoricalImportService.getInstance(db)

  ipcMain.handle('import:select-file', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Select Monarch CSV Export',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      properties: ['openFile'],
    })
    if (result.canceled) return { success: false }
    return { success: true, data: result.filePaths[0] }
  })

  ipcMain.handle('import:preview', async (_event, filePath: string) => {
    try {
      const preview = await service.previewCSV(filePath)
      // Normalize to camelCase for renderer consistency
      return {
        success: true,
        data: {
          totalRows: preview.total_rows,
          newRows: preview.new_count,
          duplicates: preview.already_imported_count,
          dateRange: `${preview.date_range.start} – ${preview.date_range.end}`,
          accountsFound: preview.accounts_found,
          excludedCount: preview.excluded_count,
          columnMappingValid: preview.column_mapping_valid,
          // keep originals too for diagnostics
          ...preview,
        },
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('import:run', async (_event, filePath: string) => {
    try {
      const result = await service.importCSV(filePath, (progress) => {
        // Push progress to renderer
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('import:progress', progress)
        }
      })
      return { success: true, data: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
