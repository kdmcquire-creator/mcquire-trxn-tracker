// electron/services/plaid-ipc.ts
//
// IPC handlers for all Phase 2 Plaid operations.
// Add to your existing IPC setup in electron/services/ipc.ts (or similar).
//
// Call registerPlaidIpcHandlers(ipcMain, db, plaid, scheduler) once during app init.

import { ipcMain } from 'electron'
import type { CompatDb } from './database'
import { PlaidService } from './plaid.service'
import { openPlaidLink } from './plaid-link.service'
import { SyncScheduler } from './sync-scheduler.service'
import { IPC } from '../../src/shared/plaid.types'
import { reclassifyPendingAfterRuleChange } from './classification-engine'

export function registerPlaidIpcHandlers(
  db: CompatDb,
  plaid: PlaidService,
  scheduler: SyncScheduler
): void {

  // ─── Plaid Link ───────────────────────────────────────────────────────────────

  // Step 1: Create a link token (called before opening Link)
  ipcMain.handle(IPC.PLAID_CREATE_LINK_TOKEN, async () => {
    try {
      const linkToken = await plaid.createLinkToken()
      return { success: true, data: linkToken }
    } catch (err: any) {
      // Extract Plaid's actual error body (error_code + error_message) instead of
      // the generic Axios "Request failed with status code 400" message.
      const plaidBody = err?.response?.data
      const detail = plaidBody
        ? `${plaidBody.error_code}: ${plaidBody.error_message}`
        : err.message
      console.error('[Plaid] createLinkToken failed:', detail, plaidBody)
      return { success: false, error: detail }
    }
  })

  // Step 2: Open the Plaid Link window (renderer triggers this)
  ipcMain.handle(IPC.PLAID_OPEN_LINK, async (_event, linkToken: string) => {
    try {
      const result = await openPlaidLink(linkToken)
      return { success: true, data: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Step 3: Exchange public token + save accounts
  ipcMain.handle(
    IPC.PLAID_EXCHANGE_TOKEN,
    async (
      _event,
      payload: {
        public_token: string
        institution_id: string
        institution_name: string
        accounts: Array<{
          plaid_account_id: string
          account_name: string
          account_mask: string
          account_type: string
          entity: string
          default_bucket: string
        }>
      }
    ) => {
      try {
        const itemId = await plaid.exchangePublicToken(
          payload.public_token,
          payload.institution_id,
          payload.institution_name,
          payload.accounts
        )
        return { success: true, data: itemId }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  // Re-authenticate an existing item (ITEM_LOGIN_REQUIRED)
  ipcMain.handle(IPC.PLAID_REAUTH, async (_event, plaidItemId: string) => {
    try {
      const accessToken = plaid.getAccessToken(plaidItemId)
      if (!accessToken) throw new Error('Access token not found for this item.')

      const linkToken = await plaid.createReauthLinkToken(accessToken)
      const item = db
        .prepare('SELECT institution_name FROM plaid_items WHERE plaid_item_id = ?')
        .get(plaidItemId) as { institution_name: string } | undefined

      // Open Link in reauth mode
      await openPlaidLink(linkToken, item?.institution_name)

      // After reauth, Plaid doesn't issue a new access token — just update status
      db.prepare("UPDATE plaid_items SET status = 'active', error_code = NULL WHERE plaid_item_id = ?")
        .run(plaidItemId)

      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── Sync ─────────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.PLAID_SYNC_ALL, async () => {
    try {
      if (scheduler.syncInProgress) {
        return { success: false, error: 'Sync already in progress.' }
      }
      const results = await scheduler.syncNow()
      // Re-run rules against all pending_review transactions (catches newly imported + any
      // previously imported before rules were last updated)
      const { resolved } = reclassifyPendingAfterRuleChange(db)
      console.log(`[Sync] reclassify pass resolved ${resolved} pending transactions`)
      // Convert Map to plain object for IPC serialization
      const serialized: Record<string, any> = {}
      if (results && typeof results.forEach === 'function') {
        results.forEach((v, k) => { serialized[k] = v })
      }
      return { success: true, data: serialized }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.PLAID_SYNC_ACCOUNT, async (_event, plaidItemId: string) => {
    try {
      const result = await plaid.syncItem(plaidItemId)
      // Re-run rules against pending transactions after single-account sync
      const { resolved } = reclassifyPendingAfterRuleChange(db)
      console.log(`[Sync] reclassify pass resolved ${resolved} pending transactions`)
      return { success: true, data: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.PLAID_GET_SYNC_STATUS, async () => {
    try {
      const accounts = plaid.getAccountsWithSyncStatus()
      const reauthItems = plaid.getItemsNeedingReauth()
      const syncInProgress = scheduler.syncInProgress
      return { success: true, data: { accounts, reauthItems, syncInProgress } }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── Accounts ─────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.ACCOUNTS_LIST, async () => {
    try {
      const accounts = db
        .prepare(
          `SELECT a.*, pi.status as plaid_status, pi.institution_id,
                  pi.last_successful_sync, pi.error_code
           FROM accounts a
           LEFT JOIN plaid_items pi ON a.plaid_item_id = pi.plaid_item_id
           ORDER BY a.is_active DESC, a.institution, a.account_name`
        )
        .all()
      return { success: true, data: accounts }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.ACCOUNTS_UPDATE, async (_event, account: any) => {
    try {
      db.prepare(
        `UPDATE accounts SET
           account_name = ?, entity = ?, default_bucket = ?,
           notes = ?
         WHERE id = ?`
      ).run(account.account_name, account.entity, account.default_bucket, account.notes, account.id)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.ACCOUNTS_DISABLE, async (_event, accountId: string) => {
    try {
      db.prepare("UPDATE accounts SET is_active = 0 WHERE id = ?").run(accountId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.ACCOUNTS_DELETE, async (_event, accountId: string) => {
    try {
      db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── Plaid Items ──────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.PLAID_ITEMS_LIST, async () => {
    try {
      const items = db.prepare('SELECT * FROM plaid_items ORDER BY created_at DESC').all()
      return { success: true, data: items }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.PLAID_ITEMS_DELETE, async (_event, plaidItemId: string) => {
    try {
      plaid.deleteItem(plaidItemId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── Sync Log ─────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SYNC_LOG_LIST, async (_event, limit = 50) => {
    try {
      const logs = plaid.getRecentSyncLogs(limit)
      return { success: true, data: logs }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── Settings ─────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SETTINGS_GET_PLAID_CONFIG, async () => {
    try {
      const clientId = plaid.getStoredClientId()
      const env = db
        .prepare("SELECT value FROM settings WHERE key = 'plaid_env'")
        .get() as { value: string } | undefined
      return {
        success: true,
        data: {
          configured: plaid.isConfigured(),
          client_id: clientId ? clientId.slice(0, 8) + '…' : null, // mask for display
          env: env?.value || 'development',
        },
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(
    IPC.SETTINGS_SAVE_PLAID_CONFIG,
    async (_event, config: { client_id: string; secret: string; env: string }) => {
      try {
        plaid.savePlaidCredentials(config.client_id, config.secret)
        db.prepare(
          "INSERT INTO settings (key, value) VALUES ('plaid_env', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run(config.env)
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  ipcMain.handle(IPC.SETTINGS_GET_SYNC_SCHEDULE, async () => {
    try {
      const getVal = (key: string) =>
        (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
      return {
        success: true,
        data: {
          enabled: getVal('auto_sync_enabled') === '1',
          cron: getVal('auto_sync_cron') || '0 2 * * *',
          last_sync: getVal('last_auto_sync_at') || null,
        },
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(
    IPC.SETTINGS_SAVE_SYNC_SCHEDULE,
    async (_event, config: { enabled: boolean; cron: string }) => {
      try {
        scheduler.updateSchedule(config.enabled, config.cron)
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )
}
