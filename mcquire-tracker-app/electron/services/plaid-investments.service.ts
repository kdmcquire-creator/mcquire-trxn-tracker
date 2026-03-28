// electron/services/plaid-investments.service.ts
//
// Phase 3 — Plaid Investments API
// Handles: /investments/holdings/get and /investments/transactions/get
// for Fidelity, Schwab, and Chase brokerage accounts.
//
// Important constraints (from tech spec):
//   - Fidelity requires re-auth ~every 90 days (ITEM_LOGIN_REQUIRED)
//   - Cost basis not always available from Fidelity — flag as ⚠️ CPA review
//   - Investment data is informational only — excluded from expense/P&L reports
//   - Holdings stored as daily snapshots; builds a history over time
//
// Usage:
//   const invService = PlaidInvestmentsService.getInstance(db, plaidService)
//   await invService.syncHoldings(plaidItemId)
//   await invService.syncTransactions(plaidItemId, startDate, endDate)

import { PlaidApi } from 'plaid'
import type { CompatDb } from './database'
import { v4 as uuidv4 } from 'uuid'
import { PlaidService } from './plaid.service'
import type {
  InvestmentHolding,
  InvestmentTransaction,
  PortfolioSummary,
  AccountSummary,
  HistoricalSnapshot,
} from '../../src/shared/investments.types'

export class PlaidInvestmentsService {
  private static instance: PlaidInvestmentsService | null = null
  private db: CompatDb
  private plaid: PlaidService

  private constructor(db: CompatDb, plaid: PlaidService) {
    this.db = db
    this.plaid = plaid
  }

  static getInstance(
    db: CompatDb,
    plaid: PlaidService
  ): PlaidInvestmentsService {
    if (!PlaidInvestmentsService.instance) {
      PlaidInvestmentsService.instance = new PlaidInvestmentsService(db, plaid)
    }
    return PlaidInvestmentsService.instance
  }

  // ─── Holdings sync ────────────────────────────────────────────────────────────

  /**
   * Sync holdings for one Plaid item.
   * Calls /investments/holdings/get and saves a snapshot for today.
   * Each call captures a full point-in-time picture — these accumulate to build history.
   */
  async syncHoldings(plaidItemId: string): Promise<{ holdings_synced: number; error?: string }> {
    const accessToken = this.plaid.getAccessToken(plaidItemId)
    if (!accessToken) {
      return { holdings_synced: 0, error: 'No access token for this item' }
    }

    try {
      const client = this.getClient()
      const response = await client.investmentsHoldingsGet({
        access_token: accessToken,
      })

      const { holdings, securities, accounts } = response.data
      const today = new Date().toISOString().split('T')[0]

      // Build a security lookup map
      const securityMap = new Map<string, { name: string; ticker_symbol: string | null }>()
      for (const sec of securities) {
        securityMap.set(sec.security_id, {
          name: sec.name || sec.unofficial_currency_code || '',
          ticker_symbol: sec.ticker_symbol || null,
        })
      }

      // Build account lookup
      const accountMap = new Map<string, string>() // plaid_account_id → internal account id
      for (const plaidAcct of accounts) {
        const row = this.db
          .prepare('SELECT id FROM accounts WHERE plaid_account_id = ?')
          .get(plaidAcct.account_id) as { id: string } | undefined
        if (row) accountMap.set(plaidAcct.account_id, row.id)
      }

      // Delete today's existing snapshots for this item (replace with fresh data)
      const itemAccounts = Array.from(accountMap.values())
      if (itemAccounts.length > 0) {
        const placeholders = itemAccounts.map(() => '?').join(',')
        this.db
          .prepare(
            `DELETE FROM investments
             WHERE record_type = 'holding'
             AND account_id IN (${placeholders})
             AND snapshot_date = ?`
          )
          .run(...itemAccounts, today)
      }

      // Insert new snapshot rows
      const insertHolding = this.db.prepare(
        `INSERT INTO investments
          (id, account_id, plaid_investment_transaction_id, record_type,
           security_name, ticker, quantity, price, market_value, cost_basis,
           snapshot_date, currency, created_at)
         VALUES (?, ?, NULL, 'holding', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )

      const insertMany = this.db.transaction((rows: any[]) => {
        for (const row of rows) {
          insertHolding.run(
            row.id, row.account_id, row.security_name, row.ticker,
            row.quantity, row.price, row.market_value, row.cost_basis,
            row.snapshot_date, row.currency
          )
        }
      })

      const rows = holdings
        .map((h) => {
          const accountId = accountMap.get(h.account_id)
          if (!accountId) return null
          const sec = securityMap.get(h.security_id)
          return {
            id: uuidv4(),
            account_id: accountId,
            security_name: sec?.name || null,
            ticker: sec?.ticker_symbol || null,
            quantity: h.quantity,
            price: h.institution_price ?? null,
            market_value: h.institution_value ?? null,
            cost_basis: h.cost_basis ?? null,
            snapshot_date: today,
            currency: h.unofficial_currency_code || 'USD',
          }
        })
        .filter(Boolean)

      insertMany(rows)

      return { holdings_synced: rows.length }
    } catch (err: any) {
      const errorCode = err?.response?.data?.error_code || err?.message || 'UNKNOWN'
      if (errorCode === 'ITEM_LOGIN_REQUIRED') {
        this.db
          .prepare("UPDATE plaid_items SET status = 'login_required', error_code = ? WHERE plaid_item_id = ?")
          .run(errorCode, plaidItemId)
      }
      return { holdings_synced: 0, error: errorCode }
    }
  }

  // ─── Investment transactions sync ─────────────────────────────────────────────

  /**
   * Sync investment transactions (buys, sells, dividends, etc.) for one Plaid item.
   * Uses /investments/transactions/get with date range.
   */
  async syncTransactions(
    plaidItemId: string,
    startDate?: string,
    endDate?: string
  ): Promise<{ transactions_synced: number; error?: string }> {
    const accessToken = this.plaid.getAccessToken(plaidItemId)
    if (!accessToken) {
      return { transactions_synced: 0, error: 'No access token for this item' }
    }

    // Default: last 30 days for routine sync, or full year on first sync
    const lastSyncRaw = (
      this.db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(`inv_tx_cursor_${plaidItemId}`) as { value: string } | undefined
    )?.value

    const defaultStart = lastSyncRaw
      ? new Date(new Date(lastSyncRaw).getTime() - 2 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0]  // 2-day overlap to catch late-settling transactions
      : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] // 1 year back

    const start = startDate || defaultStart
    const end = endDate || new Date().toISOString().split('T')[0]

    try {
      const client = this.getClient()

      let offset = 0
      let totalCount = 1
      let synced = 0

      const insertTx = this.db.prepare(
        `INSERT OR IGNORE INTO investments
          (id, account_id, plaid_investment_transaction_id, record_type,
           security_name, ticker, transaction_type, transaction_amount,
           quantity, price, transaction_date, currency, created_at)
         VALUES (?, ?, ?, 'transaction', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )

      while (offset < totalCount) {
        const response = await client.investmentsTransactionsGet({
          access_token: accessToken,
          start_date: start,
          end_date: end,
          options: { offset, count: 500 },
        })

        const { investment_transactions, securities, accounts, total_investment_transactions } =
          response.data
        totalCount = total_investment_transactions

        // Build lookups
        const secMap = new Map(
          securities.map((s) => [
            s.security_id,
            { name: s.name || '', ticker: s.ticker_symbol || null },
          ])
        )
        const acctMap = new Map<string, string>()
        for (const plaidAcct of accounts) {
          const row = this.db
            .prepare('SELECT id FROM accounts WHERE plaid_account_id = ?')
            .get(plaidAcct.account_id) as { id: string } | undefined
          if (row) acctMap.set(plaidAcct.account_id, row.id)
        }

        const insertBatch = this.db.transaction((txs: any[]) => {
          for (const t of txs) {
            insertTx.run(
              t.id, t.account_id, t.plaid_tx_id,
              t.security_name, t.ticker, t.type,
              t.amount, t.quantity, t.price, t.date, t.currency
            )
          }
        })

        const rows = investment_transactions
          .map((t) => {
            const accountId = acctMap.get(t.account_id)
            if (!accountId) return null
            const sec = secMap.get(t.security_id || '')
            return {
              id: uuidv4(),
              account_id: accountId,
              plaid_tx_id: t.investment_transaction_id,
              security_name: sec?.name || null,
              ticker: sec?.ticker || null,
              type: t.type,
              amount: t.amount,
              quantity: t.quantity ?? null,
              price: t.price ?? null,
              date: t.date,
              currency: t.unofficial_currency_code || 'USD',
            }
          })
          .filter(Boolean)

        insertBatch(rows)
        synced += rows.length
        offset += investment_transactions.length
      }

      // Save cursor date
      this.db
        .prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(`inv_tx_cursor_${plaidItemId}`, end)

      return { transactions_synced: synced }
    } catch (err: any) {
      const errorCode = err?.response?.data?.error_code || err?.message || 'UNKNOWN'
      return { transactions_synced: 0, error: errorCode }
    }
  }

  // ─── Sync all investment accounts ────────────────────────────────────────────

  async syncAll(): Promise<{
    holdings_synced: number
    transactions_synced: number
    errors: string[]
  }> {
    const items = this.db
      .prepare(
        `SELECT DISTINCT pi.plaid_item_id, pi.institution_name
         FROM plaid_items pi
         JOIN accounts a ON a.plaid_item_id = pi.plaid_item_id
         WHERE pi.status = 'active'
         AND a.account_type IN ('investment', 'brokerage')
         AND a.is_active = 1`
      )
      .all() as Array<{ plaid_item_id: string; institution_name: string }>

    let holdings_synced = 0
    let transactions_synced = 0
    const errors: string[] = []

    for (const item of items) {
      const [holdingsResult, txResult] = await Promise.all([
        this.syncHoldings(item.plaid_item_id),
        this.syncTransactions(item.plaid_item_id),
      ])

      holdings_synced += holdingsResult.holdings_synced
      transactions_synced += txResult.transactions_synced

      if (holdingsResult.error) errors.push(`${item.institution_name} holdings: ${holdingsResult.error}`)
      if (txResult.error) errors.push(`${item.institution_name} transactions: ${txResult.error}`)
    }

    return { holdings_synced, transactions_synced, errors }
  }

  // ─── Read queries ─────────────────────────────────────────────────────────────

  getPortfolioSummary(): PortfolioSummary {
    const today = new Date().toISOString().split('T')[0]

    // Get latest snapshot date with data
    const latestDate = (
      this.db
        .prepare(
          "SELECT MAX(snapshot_date) as d FROM investments WHERE record_type = 'holding'"
        )
        .get() as { d: string | null }
    )?.d || today

    const rows = this.db
      .prepare(
        `SELECT
           SUM(market_value) as total_mv,
           SUM(cost_basis) as total_cb,
           COUNT(*) as holding_count,
           COUNT(DISTINCT account_id) as account_count,
           SUM(CASE WHEN cost_basis IS NULL THEN 1 ELSE 0 END) as missing_basis
         FROM investments
         WHERE record_type = 'holding'
         AND snapshot_date = ?`
      )
      .get(latestDate) as any

    const totalMv = rows?.total_mv || 0
    const totalCb = rows?.total_cb || null
    const gainLoss = totalCb !== null ? totalMv - totalCb : null
    const gainLossPct = totalCb && totalCb > 0 ? (gainLoss! / totalCb) * 100 : null

    return {
      total_market_value: totalMv,
      total_cost_basis: totalCb,
      total_gain_loss: gainLoss,
      total_gain_loss_pct: gainLossPct,
      as_of_date: latestDate,
      account_count: rows?.account_count || 0,
      holdings_count: rows?.holding_count || 0,
      has_incomplete_cost_basis: (rows?.missing_basis || 0) > 0,
    }
  }

  getAccountSummaries(): AccountSummary[] {
    const latestDate = (
      this.db
        .prepare("SELECT MAX(snapshot_date) as d FROM investments WHERE record_type = 'holding'")
        .get() as { d: string | null }
    )?.d

    if (!latestDate) return []

    return this.db
      .prepare(
        `SELECT
           a.id as account_id,
           a.account_name,
           a.account_mask,
           a.institution,
           a.last_synced_at,
           SUM(i.market_value) as market_value,
           SUM(i.cost_basis) as cost_basis,
           COUNT(i.id) as holding_count
         FROM investments i
         JOIN accounts a ON a.id = i.account_id
         WHERE i.record_type = 'holding'
         AND i.snapshot_date = ?
         GROUP BY a.id
         ORDER BY market_value DESC`
      )
      .all(latestDate) as AccountSummary[]
  }

  getHoldings(accountId?: string): InvestmentHolding[] {
    const latestDate = (
      this.db
        .prepare("SELECT MAX(snapshot_date) as d FROM investments WHERE record_type = 'holding'")
        .get() as { d: string | null }
    )?.d

    if (!latestDate) return []

    const sql = accountId
      ? `SELECT i.*, a.account_name, a.account_mask, a.institution
         FROM investments i
         JOIN accounts a ON a.id = i.account_id
         WHERE i.record_type = 'holding'
         AND i.snapshot_date = ?
         AND i.account_id = ?
         ORDER BY i.market_value DESC`
      : `SELECT i.*, a.account_name, a.account_mask, a.institution
         FROM investments i
         JOIN accounts a ON a.id = i.account_id
         WHERE i.record_type = 'holding'
         AND i.snapshot_date = ?
         ORDER BY i.market_value DESC`

    const rows = accountId
      ? (this.db.prepare(sql).all(latestDate, accountId) as any[])
      : (this.db.prepare(sql).all(latestDate) as any[])

    return rows.map((r) => ({
      ...r,
      gain_loss:
        r.market_value != null && r.cost_basis != null
          ? r.market_value - r.cost_basis
          : null,
      gain_loss_pct:
        r.market_value != null && r.cost_basis != null && r.cost_basis > 0
          ? ((r.market_value - r.cost_basis) / r.cost_basis) * 100
          : null,
    }))
  }

  getTransactions(
    accountId?: string,
    startDate?: string,
    endDate?: string,
    txType?: string
  ): InvestmentTransaction[] {
    let sql = `SELECT i.*, a.account_name, a.account_mask, a.institution
               FROM investments i
               JOIN accounts a ON a.id = i.account_id
               WHERE i.record_type = 'transaction'`
    const params: any[] = []

    if (accountId) { sql += ' AND i.account_id = ?'; params.push(accountId) }
    if (startDate) { sql += ' AND i.transaction_date >= ?'; params.push(startDate) }
    if (endDate)   { sql += ' AND i.transaction_date <= ?'; params.push(endDate) }
    if (txType)    { sql += ' AND i.transaction_type = ?'; params.push(txType) }

    sql += ' ORDER BY i.transaction_date DESC LIMIT 500'

    return this.db.prepare(sql).all(...params) as InvestmentTransaction[]
  }

  getHistoricalSnapshots(accountId?: string, days = 365): HistoricalSnapshot[] {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

    const sql = accountId
      ? `SELECT snapshot_date, SUM(market_value) as total_value
         FROM investments
         WHERE record_type = 'holding'
         AND account_id = ?
         AND snapshot_date >= ?
         GROUP BY snapshot_date
         ORDER BY snapshot_date ASC`
      : `SELECT snapshot_date, SUM(market_value) as total_value
         FROM investments
         WHERE record_type = 'holding'
         AND snapshot_date >= ?
         GROUP BY snapshot_date
         ORDER BY snapshot_date ASC`

    const rows = accountId
      ? this.db.prepare(sql).all(accountId, since)
      : this.db.prepare(sql).all(since)

    return rows as HistoricalSnapshot[]
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private getClient(): PlaidApi {
    // Access the client via PlaidService's private method by calling a sync first
    // We use require here to avoid circular imports
    const { PlaidApi, Configuration, PlaidEnvironments } = require('plaid')
    const { app } = require('electron')
    const fs = require('fs')
    const path = require('path')

    const loadCred = (key: string): string | null => {
      const { safeStorage } = require('electron')
      const credPath = path.join(
        app.getPath('userData'),
        'creds',
        key.replace(/[^a-z0-9_-]/gi, '_')
      )
      if (!fs.existsSync(credPath)) return null
      try {
        const encrypted = fs.readFileSync(credPath)
        return safeStorage.decryptString(encrypted)
      } catch { return null }
    }

    const clientId = loadCred('McQuireTracker_plaid_client_id')
    const secret = loadCred('McQuireTracker_plaid_secret')

    if (!clientId || !secret) throw new Error('Plaid not configured')

    const env =
      (
        this.db
          .prepare("SELECT value FROM settings WHERE key = 'plaid_env'")
          .get() as { value: string } | undefined
      )?.value || 'development'

    const baseUrl =
      env === 'sandbox'
        ? PlaidEnvironments.sandbox
        : env === 'production'
        ? PlaidEnvironments.production
        : PlaidEnvironments.development

    const config = new Configuration({
      basePath: baseUrl,
      baseOptions: {
        headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret },
      },
    })

    return new PlaidApi(config)
  }
}
