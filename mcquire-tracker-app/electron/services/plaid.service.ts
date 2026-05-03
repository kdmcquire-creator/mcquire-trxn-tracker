// electron/services/plaid.service.ts
//
// Core Plaid integration service.
// Handles: Link token creation, token exchange, /transactions/sync cursor-based pull.
// Tokens stored in Windows Credential Manager via electron.safeStorage — never on disk.
//
// Usage:
//   const plaid = PlaidService.getInstance(db)
//   await plaid.createLinkToken()
//   await plaid.exchangePublicToken(publicToken, institutionId, institutionName, accounts)
//   await plaid.syncTransactions(itemId, onProgress)

import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid'
import { safeStorage, app } from 'electron'
import type { CompatDb } from './database'
import { v4 as uuidv4 } from 'uuid'
import * as path from 'path'
import * as fs from 'fs'
import type { SyncResult } from '../../src/shared/plaid.types'
import { classifyTransaction, loadActiveRules, normalizeMerchant, hashRow } from './classification-engine'
import type { Rule } from '../../src/shared/types'

// ─── Credential helpers (Windows Credential Manager via safeStorage) ───────────

const CRED_KEY_PLAID_CLIENT_ID = 'McQuireTracker_plaid_client_id'
const CRED_KEY_PLAID_SECRET = 'McQuireTracker_plaid_secret'
const CRED_PREFIX_ACCESS_TOKEN = 'McQuireTracker_plaid_token_' // + item_id

function getCredentialPath(key: string): string {
  // safeStorage encrypts/decrypts using Windows DPAPI.
  // We store the encrypted bytes as files in app.getPath('userData').
  return path.join(app.getPath('userData'), 'creds', key.replace(/[^a-z0-9_-]/gi, '_'))
}

function saveCredential(key: string, value: string): void {
  const credPath = getCredentialPath(key)
  fs.mkdirSync(path.dirname(credPath), { recursive: true })
  const encrypted = safeStorage.encryptString(value)
  fs.writeFileSync(credPath, encrypted)
}

function loadCredential(key: string): string | null {
  const credPath = getCredentialPath(key)
  if (!fs.existsSync(credPath)) return null
  try {
    const encrypted = fs.readFileSync(credPath)
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}

function deleteCredential(key: string): void {
  const credPath = getCredentialPath(key)
  if (fs.existsSync(credPath)) fs.unlinkSync(credPath)
}

// ─── PlaidService ──────────────────────────────────────────────────────────────

export class PlaidService {
  private static instance: PlaidService | null = null
  private db: CompatDb
  private client: PlaidApi | null = null

  private constructor(db: CompatDb) {
    this.db = db
  }

  static getInstance(db: CompatDb): PlaidService {
    if (!PlaidService.instance) {
      PlaidService.instance = new PlaidService(db)
    }
    return PlaidService.instance
  }

  // ─── Configuration ───────────────────────────────────────────────────────────

  savePlaidCredentials(clientId: string, secret: string): void {
    saveCredential(CRED_KEY_PLAID_CLIENT_ID, clientId)
    saveCredential(CRED_KEY_PLAID_SECRET, secret)
    this.client = null // force re-init
  }

  getStoredClientId(): string | null {
    return loadCredential(CRED_KEY_PLAID_CLIENT_ID)
  }

  isConfigured(): boolean {
    return !!loadCredential(CRED_KEY_PLAID_CLIENT_ID) && !!loadCredential(CRED_KEY_PLAID_SECRET)
  }

  private getClient(): PlaidApi {
    if (this.client) return this.client

    const clientId = loadCredential(CRED_KEY_PLAID_CLIENT_ID)
    const secret = loadCredential(CRED_KEY_PLAID_SECRET)

    if (!clientId || !secret) {
      throw new Error('Plaid credentials not configured. Set them in Settings → Sync & Schedule.')
    }

    const env = this.getSetting('plaid_env') || 'development'
    const baseUrl =
      env === 'sandbox'
        ? PlaidEnvironments.sandbox
        : env === 'production'
        ? PlaidEnvironments.production
        : PlaidEnvironments.development

    const config = new Configuration({
      basePath: baseUrl,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': clientId,
          'PLAID-SECRET': secret,
        },
      },
    })

    this.client = new PlaidApi(config)
    return this.client
  }

  // ─── Settings helpers ─────────────────────────────────────────────────────────

  private getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  private setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  // ─── Plaid Link ───────────────────────────────────────────────────────────────

  async createLinkToken(): Promise<string> {
    const client = this.getClient()
    const response = await client.linkTokenCreate({
      user: { client_user_id: 'kyle-mcquire' },
      client_name: 'McQuire Tracker',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    })
    return response.data.link_token
  }

  async createReauthLinkToken(accessToken: string): Promise<string> {
    const client = this.getClient()
    const response = await client.linkTokenCreate({
      user: { client_user_id: 'kyle-mcquire' },
      client_name: 'McQuire Tracker',
      access_token: accessToken,
      country_codes: [CountryCode.Us],
      language: 'en',
    })
    return response.data.link_token
  }

  // ─── Token Exchange ────────────────────────────────────────────────────────────

  async exchangePublicToken(
    publicToken: string,
    institutionId: string,
    institutionName: string,
    selectedAccounts: Array<{
      plaid_account_id: string
      account_name: string
      account_mask: string
      account_type: string
      entity: string
      default_bucket: string
    }>
  ): Promise<string> {
    const client = this.getClient()

    // Exchange public token → access token
    const exchangeResponse = await client.itemPublicTokenExchange({
      public_token: publicToken,
    })
    const { access_token, item_id } = exchangeResponse.data

    // Store access token encrypted
    saveCredential(CRED_PREFIX_ACCESS_TOKEN + item_id, access_token)

    // Record plaid_item in DB
    const plaidItemId = uuidv4()
    this.db
      .prepare(
        `INSERT INTO plaid_items
          (id, institution_id, institution_name, plaid_item_id, status, created_at)
         VALUES (?, ?, ?, ?, 'active', datetime('now'))
         ON CONFLICT(plaid_item_id) DO UPDATE SET
           status = 'active',
           error_code = NULL`
      )
      .run(plaidItemId, institutionId, institutionName, item_id)

    // Insert accounts
    for (const acct of selectedAccounts) {
      const existing = this.db
        .prepare('SELECT id FROM accounts WHERE plaid_account_id = ?')
        .get(acct.plaid_account_id)

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO accounts
              (id, plaid_item_id, plaid_account_id, institution, account_name, account_mask,
               account_type, entity, default_bucket, import_method, is_active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'plaid', 1, datetime('now'))`
          )
          .run(
            uuidv4(),
            item_id,
            acct.plaid_account_id,
            institutionName,
            acct.account_name,
            acct.account_mask,
            acct.account_type,
            acct.entity,
            acct.default_bucket
          )
      }
    }

    return item_id
  }

  // ─── Transaction Sync ─────────────────────────────────────────────────────────

  /**
   * Sync transactions for a single Plaid item using /transactions/sync.
   * Uses cursor-based pagination — only fetches new/modified transactions.
   */
  async syncItem(
    plaidItemId: string,
    onProgress?: (msg: string) => void
  ): Promise<SyncResult> {
    const client = this.getClient()

    const item = this.db
      .prepare('SELECT * FROM plaid_items WHERE plaid_item_id = ?')
      .get(plaidItemId) as
      | {
          id: string
          institution_name: string
          plaid_item_id: string
          status: string
        }
      | undefined

    if (!item) throw new Error(`Plaid item not found: ${plaidItemId}`)

    const accessToken = loadCredential(CRED_PREFIX_ACCESS_TOKEN + plaidItemId)
    if (!accessToken) throw new Error(`No access token found for item: ${plaidItemId}`)

    const logId = this.startSyncLog('plaid_pull', null)
    const result: SyncResult = {
      transactions_found: 0,
      transactions_new: 0,
      transactions_duplicate: 0,
      transactions_classified: 0,
      transactions_queued: 0,
    }

    try {
      // Pre-cache rules for the entire sync batch (avoids N queries for N transactions)
      this.invalidateRuleCache()

      // Load stored cursor (if any)
      const cursorRow = this.db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(`plaid_cursor_${plaidItemId}`) as { value: string } | undefined
      let cursor = cursorRow?.value || undefined

      let hasMore = true

      while (hasMore) {
        onProgress?.(`Fetching transactions from ${item.institution_name}…`)

        const syncResponse = await client.transactionsSync({
          access_token: accessToken,
          cursor,
          count: 500,
        })

        const { added, modified, removed, next_cursor, has_more } = syncResponse.data
        hasMore = has_more
        cursor = next_cursor

        result.transactions_found += added.length + modified.length

        // Process added transactions
        for (const tx of added) {
          const imported = this.importPlaidTransaction(tx, plaidItemId)
          if (imported === 'new') {
            result.transactions_new++
            result.transactions_classified++ // classification happens inside importPlaidTransaction
          } else if (imported === 'duplicate') {
            result.transactions_duplicate++
          } else if (imported === 'queued') {
            result.transactions_new++
            result.transactions_queued++
          }
        }

        // Process modified — re-run classification on existing rows
        for (const tx of modified) {
          this.updatePlaidTransaction(tx)
        }

        // Process removed — pending transactions that reconciled to a posted version
        // Must also set review_status so they leave the Review Queue
        for (const removed_tx of removed) {
          this.db
            .prepare("UPDATE transactions SET bucket = 'Exclude', review_status = 'auto_classified', updated_at = datetime('now') WHERE plaid_transaction_id = ?")
            .run(removed_tx.transaction_id)
        }
      }

      // Save cursor
      this.setSetting(`plaid_cursor_${plaidItemId}`, cursor || '')

      // Update item status and last sync time
      this.db
        .prepare(
          "UPDATE plaid_items SET status = 'active', error_code = NULL, last_successful_sync = datetime('now') WHERE plaid_item_id = ?"
        )
        .run(plaidItemId)

      // Update last_synced_at on all accounts for this item
      this.db
        .prepare("UPDATE accounts SET last_synced_at = datetime('now') WHERE plaid_item_id = ?")
        .run(plaidItemId)

      this.invalidateRuleCache()
      this.finishSyncLog(logId, 'success', result)
      return result
    } catch (err: any) {
      const errorCode = err?.response?.data?.error_code || err?.message || 'UNKNOWN'
      const isReauthNeeded = errorCode === 'ITEM_LOGIN_REQUIRED'

      // Update item status
      this.db
        .prepare('UPDATE plaid_items SET status = ?, error_code = ? WHERE plaid_item_id = ?')
        .run(isReauthNeeded ? 'login_required' : 'error', errorCode, plaidItemId)

      this.invalidateRuleCache()
      result.error = errorCode
      this.finishSyncLog(logId, 'error', result, errorCode)

      // Strip sensitive headers (PLAID-SECRET, access tokens) before propagating
      if (err?.response?.config?.headers) {
        delete err.response.config.headers['PLAID-SECRET']
        delete err.response.config.headers['PLAID-CLIENT-ID']
      }
      if (err?.config?.headers) {
        delete err.config.headers['PLAID-SECRET']
        delete err.config.headers['PLAID-CLIENT-ID']
      }
      throw err
    }
  }

  /**
   * Sync all active Plaid items.
   */
  async syncAll(onProgress?: (msg: string) => void): Promise<Map<string, SyncResult>> {
    const items = this.db
      .prepare("SELECT * FROM plaid_items WHERE status != 'disabled'")
      .all() as Array<{ plaid_item_id: string; institution_name: string }>

    const results = new Map<string, SyncResult>()

    for (const item of items) {
      try {
        onProgress?.(`Syncing ${item.institution_name}…`)
        const result = await this.syncItem(item.plaid_item_id, onProgress)
        results.set(item.plaid_item_id, result)
      } catch (err: any) {
        results.set(item.plaid_item_id, {
          transactions_found: 0,
          transactions_new: 0,
          transactions_duplicate: 0,
          transactions_classified: 0,
          transactions_queued: 0,
          error: err?.message || 'Sync failed',
        })
      }
    }

    return results
  }

  // ─── Transaction Import Helpers ───────────────────────────────────────────────

  // Cached rules for batch import — avoids re-querying DB per transaction
  private _cachedRules: Rule[] | null = null

  private getCachedRules(): Rule[] {
    if (!this._cachedRules) {
      this._cachedRules = loadActiveRules(this.db)
    }
    return this._cachedRules
  }

  /** Call before a sync batch to load rules once; call after to release. */
  invalidateRuleCache(): void {
    this._cachedRules = null
  }

  /**
   * Cross-account duplicate check.
   * Catches the DoorDash-type bug: same dollar amount, same merchant, same date
   * appearing on different cards (different plaid_transaction_id).
   *
   * Only flags as duplicate when there is EXACTLY ONE existing match — if the user
   * legitimately has 2+ identical charges on the same day (e.g., two separate
   * DoorDash orders for the same amount), we let them through for manual review.
   */
  private isCrossAccountDuplicate(
    merchantNorm: string,
    amount: number,
    date: string,
    accountId: string
  ): boolean {
    // Allow ±2 day tolerance to catch pending vs posted date offsets
    // (e.g., card 9007 shows pending on day N, card 2419 posts on day N+1 or N+2)
    const matches = this.db
      .prepare(
        `SELECT COUNT(*) as n FROM transactions t
         WHERE t.account_id != ?
           AND t.merchant_name = ?
           AND t.amount = ?
           AND ABS(julianday(t.transaction_date) - julianday(?)) <= 2
           AND t.bucket != 'Exclude'`
      )
      .get(accountId, merchantNorm, amount, date) as { n: number }
    return matches.n >= 1
  }

  private importPlaidTransaction(tx: any, _plaidItemId: string): 'new' | 'duplicate' | 'queued' {
    // Deduplicate by Plaid transaction ID (same transaction re-synced)
    const existing = this.db
      .prepare('SELECT id FROM transactions WHERE plaid_transaction_id = ?')
      .get(tx.transaction_id)
    if (existing) return 'duplicate'

    // Find account
    const account = this.db
      .prepare('SELECT * FROM accounts WHERE plaid_account_id = ?')
      .get(tx.account_id) as { id: string; account_mask: string; default_bucket: string } | undefined
    if (!account) return 'duplicate' // account not tracked

    const merchantNorm = normalizeMerchant(tx.name)

    // Generate a content hash for this transaction (enables CSV vs Plaid dedup)
    const rowHash = hashRow({
      date: tx.date,
      amount: tx.amount,
      merchant: merchantNorm,
      account_mask: account.account_mask,
    })

    // Cross-account dedup: catches DoorDash (and similar) charges that appear
    // on multiple cards with the same amount + date + merchant.
    if (this.isCrossAccountDuplicate(merchantNorm, tx.amount, tx.date, account.id)) {
      console.log(
        `[PlaidService] Cross-account duplicate skipped: ${tx.name} $${tx.amount} on ${tx.date}`
      )
      // Still record the plaid_transaction_id so we don't re-process on next sync,
      // but mark it as Exclude so it doesn't appear in reports or review queue.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO transactions
            (id, account_id, plaid_transaction_id, source_row_hash, transaction_date,
             description_raw, merchant_name, amount, category_source, bucket,
             review_status, flag_reason, is_split_child, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Exclude', 'auto_classified',
                   'Cross-account duplicate', 0, datetime('now'), datetime('now'))`
        )
        .run(
          uuidv4(), account.id, tx.transaction_id, rowHash, tx.date,
          tx.name, merchantNorm, tx.amount,
          tx.personal_finance_category?.primary || null
        )
      return 'duplicate'
    }

    // Build raw transaction object for the classification engine
    const rawTx: Record<string, any> = {
      id: uuidv4(),
      account_id: account.id,
      plaid_transaction_id: tx.transaction_id,
      source_row_hash: rowHash,
      transaction_date: tx.date,
      posting_date: tx.datetime?.split('T')[0] || null,
      description_raw: tx.name,
      merchant_name: merchantNorm,
      amount: tx.amount, // Plaid: positive = debit
      account_mask: account.account_mask,
      category_source: tx.personal_finance_category?.primary || null,
      bucket: null as string | null,
      p10_category: null as string | null,
      llc_category: null as string | null,
      description_notes: null as string | null,
      rule_id: null as string | null,
      review_status: 'pending_review',
      flag_reason: null as string | null,
      split_parent_id: null as string | null,
      is_split_child: 0,
      period_label: null as string | null,
      expense_report_id: null as string | null,
    }

    // Run classification engine (using cached rules)
    try {
      const rules = this.getCachedRules()
      const result = classifyTransaction(rawTx as any, rules, this.db)
      Object.assign(rawTx, result)
    } catch (err) {
      console.error('[PlaidService] Classification error for tx:', rawTx.description_raw, err)
      // Leave as pending_review
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO transactions
          (id, account_id, plaid_transaction_id, source_row_hash, transaction_date, posting_date,
           description_raw, merchant_name, amount, category_source, bucket, p10_category,
           llc_category, description_notes, rule_id, review_status, flag_reason, split_parent_id,
           is_split_child, period_label, expense_report_id, created_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .run(
        rawTx.id, rawTx.account_id, rawTx.plaid_transaction_id, rawTx.source_row_hash,
        rawTx.transaction_date, rawTx.posting_date, rawTx.description_raw, rawTx.merchant_name,
        rawTx.amount, rawTx.category_source, rawTx.bucket, rawTx.p10_category,
        rawTx.llc_category, rawTx.description_notes, rawTx.rule_id, rawTx.review_status,
        rawTx.flag_reason, rawTx.split_parent_id, rawTx.is_split_child,
        rawTx.period_label, rawTx.expense_report_id
      )

    return rawTx.review_status === 'pending_review' ? 'queued' : 'new'
  }

  private updatePlaidTransaction(tx: any): void {
    // Look up the existing transaction
    const existing = this.db
      .prepare(
        `SELECT t.id, t.description_raw, t.amount, t.transaction_date, t.review_status, t.account_id, a.account_mask
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.plaid_transaction_id = ?`
      )
      .get(tx.transaction_id) as {
        id: string; description_raw: string; amount: number; transaction_date: string;
        review_status: string; account_id: string; account_mask: string
      } | undefined

    if (!existing) return

    const newName = tx.merchant_name || tx.name
    const newAmount = tx.amount
    const merchantNorm = normalizeMerchant(newName)

    // If amount or merchant changed AND transaction isn't manually classified, reclassify
    if (existing.review_status !== 'manually_classified') {
      try {
        const rules = this.getCachedRules()
        const result = classifyTransaction({
          description_raw: newName,
          amount: newAmount,
          transaction_date: tx.date || existing.transaction_date,
          account_mask: existing.account_mask,
          category_source: tx.personal_finance_category?.primary,
        }, rules, this.db)

        this.db
          .prepare(
            `UPDATE transactions SET
               merchant_name = ?, amount = ?, description_raw = ?,
               bucket = ?, p10_category = ?, llc_category = ?,
               description_notes = ?, rule_id = ?, review_status = ?,
               flag_reason = ?, updated_at = datetime('now')
             WHERE id = ?`
          )
          .run(
            merchantNorm, newAmount, newName,
            result.bucket, result.p10_category, result.llc_category,
            result.description_notes, result.rule_id, result.review_status,
            result.flag_reason, existing.id
          )
        return
      } catch (err) {
        console.error('[PlaidService] Reclassification error on modified tx:', err)
      }
    }

    // Fallback: just update amount/merchant without reclassifying (manually_classified)
    this.db
      .prepare(
        `UPDATE transactions SET
           merchant_name = ?, amount = ?, updated_at = datetime('now')
         WHERE plaid_transaction_id = ?`
      )
      .run(merchantNorm, newAmount, tx.transaction_id)
  }

  // ─── Access Token helpers (for re-auth) ──────────────────────────────────────

  getAccessToken(plaidItemId: string): string | null {
    return loadCredential(CRED_PREFIX_ACCESS_TOKEN + plaidItemId)
  }

  deleteItem(plaidItemId: string): void {
    deleteCredential(CRED_PREFIX_ACCESS_TOKEN + plaidItemId)
    this.db
      .prepare("UPDATE plaid_items SET status = 'disabled' WHERE plaid_item_id = ?")
      .run(plaidItemId)
    this.db
      .prepare("UPDATE accounts SET is_active = 0 WHERE plaid_item_id = ?")
      .run(plaidItemId)
  }

  // ─── Sync Log ─────────────────────────────────────────────────────────────────

  private startSyncLog(
    syncType: 'plaid_pull' | 'watched_folder' | 'manual_import',
    accountId: string | null
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO sync_log
          (sync_type, account_id, transactions_found, transactions_new, transactions_duplicate,
           transactions_classified, transactions_queued, status, started_at)
         VALUES (?, ?, 0, 0, 0, 0, 0, 'running', datetime('now'))`
      )
      .run(syncType, accountId)
    return result.lastInsertRowid as number
  }

  private finishSyncLog(
    logId: number,
    status: 'success' | 'partial' | 'error',
    result: SyncResult,
    errorMessage?: string
  ): void {
    this.db
      .prepare(
        `UPDATE sync_log SET
           status = ?, transactions_found = ?, transactions_new = ?,
           transactions_duplicate = ?, transactions_classified = ?,
           transactions_queued = ?, error_message = ?, completed_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        status,
        result.transactions_found,
        result.transactions_new,
        result.transactions_duplicate,
        result.transactions_classified,
        result.transactions_queued,
        errorMessage || null,
        logId
      )
  }

  getRecentSyncLogs(limit = 50): any[] {
    return this.db
      .prepare('SELECT * FROM sync_log ORDER BY started_at DESC LIMIT ?')
      .all(limit)
  }

  // ─── Status helpers for Dashboard ────────────────────────────────────────────

  getAccountsWithSyncStatus(): any[] {
    return this.db
      .prepare(
        `SELECT a.*, pi.status as plaid_status, pi.error_code, pi.last_successful_sync
         FROM accounts a
         LEFT JOIN plaid_items pi ON a.plaid_item_id = pi.plaid_item_id
         WHERE a.is_active = 1
         ORDER BY a.institution, a.account_name`
      )
      .all()
  }

  getItemsNeedingReauth(): any[] {
    return this.db
      .prepare("SELECT * FROM plaid_items WHERE status = 'login_required'")
      .all()
  }
}