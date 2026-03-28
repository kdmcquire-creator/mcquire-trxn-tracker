// electron/services/sync-scheduler.service.ts
//
// Manages automatic Plaid sync scheduling.
// - Runs nightly auto-sync via node-cron (configurable schedule)
// - Checks on app launch: if last sync > 12h ago, triggers sync
// - Pushes events to the renderer via webContents
// - Sends email notifications on new pending transactions or errors

import * as cron from 'node-cron'
import type { CompatDb } from './database'
import { BrowserWindow } from 'electron'
import { PlaidService } from './plaid.service'
import type { SyncResult } from '../../src/shared/plaid.types'

const DEFAULT_CRON = '0 2 * * *' // 2:00 AM daily
const STALE_THRESHOLD_HOURS = 12

export class SyncScheduler {
  private static instance: SyncScheduler | null = null
  private db: CompatDb
  private plaid: PlaidService
  private cronJob: cron.ScheduledTask | null = null
  private isSyncing = false
  private getMainWindow: () => BrowserWindow | null

  private constructor(
    db: CompatDb,
    plaid: PlaidService,
    getMainWindow: () => BrowserWindow | null
  ) {
    this.db = db
    this.plaid = plaid
    this.getMainWindow = getMainWindow
  }

  static getInstance(
    db: CompatDb,
    plaid: PlaidService,
    getMainWindow: () => BrowserWindow | null
  ): SyncScheduler {
    if (!SyncScheduler.instance) {
      SyncScheduler.instance = new SyncScheduler(db, plaid, getMainWindow)
    }
    return SyncScheduler.instance
  }

  // ─── Startup ───────────────────────────────────────────────────────────────────

  /**
   * Called once after app is ready and window is created.
   * 1. Starts the cron job (if auto-sync enabled)
   * 2. Checks staleness and syncs if needed
   */
  async onAppReady(): Promise<void> {
    this.startCronIfEnabled()
    await this.checkAndSyncIfStale()
  }

  // ─── Cron ─────────────────────────────────────────────────────────────────────

  private startCronIfEnabled(): void {
    const enabled = this.getSetting('auto_sync_enabled')
    if (enabled !== '1') return

    const schedule = this.getSetting('auto_sync_cron') || DEFAULT_CRON

    if (!cron.validate(schedule)) {
      console.error(`[SyncScheduler] Invalid cron expression: ${schedule}`)
      return
    }

    if (this.cronJob) {
      this.cronJob.stop()
    }

    this.cronJob = cron.schedule(schedule, async () => {
      console.log('[SyncScheduler] Auto-sync triggered by cron')
      await this.runSync('auto')
    })

    console.log(`[SyncScheduler] Auto-sync cron started: ${schedule}`)
  }

  updateSchedule(enabled: boolean, cronExpression?: string): void {
    this.setSetting('auto_sync_enabled', enabled ? '1' : '0')
    if (cronExpression) {
      this.setSetting('auto_sync_cron', cronExpression)
    }

    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
    }

    if (enabled) {
      this.startCronIfEnabled()
    }
  }

  // ─── Staleness check ──────────────────────────────────────────────────────────

  private async checkAndSyncIfStale(): Promise<void> {
    if (!this.plaid.isConfigured()) return

    const lastSyncRaw = this.getSetting('last_auto_sync_at')
    if (!lastSyncRaw) {
      // Never synced — run on first launch
      await this.runSync('launch')
      return
    }

    const lastSync = new Date(lastSyncRaw)
    const hoursSince = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60)

    if (hoursSince > STALE_THRESHOLD_HOURS) {
      console.log(`[SyncScheduler] Data is ${hoursSince.toFixed(1)}h old — syncing on launch`)
      await this.runSync('launch')
    }
  }

  // ─── Manual sync ──────────────────────────────────────────────────────────────

  async syncNow(): Promise<Map<string, SyncResult>> {
    return this.runSync('manual')
  }

  // ─── Core sync runner ─────────────────────────────────────────────────────────

  private async runSync(trigger: 'auto' | 'manual' | 'launch'): Promise<Map<string, SyncResult>> {
    if (this.isSyncing) {
      console.log('[SyncScheduler] Sync already in progress — skipping')
      return new Map()
    }

    this.isSyncing = true
    this.pushEvent('event:sync-started', { trigger })

    try {
      const results = await this.plaid.syncAll((msg) => {
        this.pushEvent('event:sync-progress', { message: msg })
      })

      this.setSetting('last_auto_sync_at', new Date().toISOString())

      // Aggregate results
      let totalNew = 0
      let totalQueued = 0
      let hasErrors = false
      const errors: string[] = []
      const reauthNeeded: string[] = []

      for (const [itemId, result] of results) {
        totalNew += result.transactions_new
        totalQueued += result.transactions_queued
        if (result.error) {
          hasErrors = true
          if (result.error === 'ITEM_LOGIN_REQUIRED') {
            const item = this.db
              .prepare('SELECT institution_name FROM plaid_items WHERE plaid_item_id = ?')
              .get(itemId) as { institution_name: string } | undefined
            reauthNeeded.push(item?.institution_name || itemId)
          } else {
            errors.push(`${itemId}: ${result.error}`)
          }
        }
      }

      this.pushEvent('event:sync-completed', {
        trigger,
        total_new: totalNew,
        total_queued: totalQueued,
        has_errors: hasErrors,
      })

      // Send email notifications
      if (reauthNeeded.length > 0) {
        await this.sendReauthEmail(reauthNeeded)
        this.pushEvent('event:reauth-required', { institutions: reauthNeeded })
      }

      if (errors.length > 0) {
        await this.sendErrorEmail(errors)
        this.pushEvent('event:sync-error', { errors })
      }

      if (totalQueued > 0) {
        await this.sendReviewEmail(totalQueued)
      }

      return results
    } catch (err: any) {
      console.error('[SyncScheduler] Sync failed:', err)
      this.pushEvent('event:sync-error', { error: err?.message })
      return new Map()
    } finally {
      this.isSyncing = false
    }
  }

  get syncInProgress(): boolean {
    return this.isSyncing
  }

  // ─── Push events to renderer ─────────────────────────────────────────────────

  private pushEvent(channel: string, data: any): void {
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }

  // ─── Email notifications ──────────────────────────────────────────────────────

  private async sendReviewEmail(pendingCount: number): Promise<void> {
    try {
      const { EmailService } = require('./email-service')
      const email = this.getSetting('notification_email')
      if (!email) return

      // Get pending transaction details for the email body
      const pending = this.db
        .prepare(
          `SELECT t.transaction_date, t.merchant_name, t.amount, a.account_mask
           FROM transactions t
           JOIN accounts a ON t.account_id = a.id
           WHERE t.review_status IN ('pending_review', 'flagged')
           ORDER BY t.transaction_date DESC
           LIMIT 20`
        )
        .all() as Array<{
          transaction_date: string
          merchant_name: string
          amount: number
          account_mask: string
        }>

      const rows = pending
        .map(
          (tx) =>
            `<tr>
              <td>${tx.transaction_date}</td>
              <td>${tx.merchant_name}</td>
              <td>$${Math.abs(tx.amount).toFixed(2)}</td>
              <td>···${tx.account_mask}</td>
            </tr>`
        )
        .join('\n')

      await EmailService.getInstance(this.db).send({
        to: email,
        subject: `[${pendingCount}] transaction${pendingCount > 1 ? 's' : ''} need your review — McQuire Tracker`,
        html: `
          <p>${pendingCount} new transaction${pendingCount > 1 ? 's' : ''} need classification:</p>
          <table border="1" cellpadding="4" style="border-collapse:collapse">
            <thead><tr><th>Date</th><th>Merchant</th><th>Amount</th><th>Account</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p>Open McQuire Tracker → Review Queue to classify.</p>
        `,
      })
    } catch {
      // Email failure is non-fatal
    }
  }

  private async sendReauthEmail(institutions: string[]): Promise<void> {
    try {
      const { EmailService } = require('./email-service')
      const email = this.getSetting('notification_email')
      if (!email) return

      await EmailService.getInstance(this.db).send({
        to: email,
        subject: `Action required: Re-authenticate ${institutions.join(', ')} — McQuire Tracker`,
        html: `
          <p>McQuire Tracker needs you to re-authenticate with the following institution(s):</p>
          <ul>${institutions.map((i) => `<li>${i}</li>`).join('')}</ul>
          <p>Open McQuire Tracker → Settings → Account Management and click <strong>Re-authenticate</strong> next to each affected account.</p>
        `,
      })
    } catch {
      // non-fatal
    }
  }

  private async sendErrorEmail(errors: string[]): Promise<void> {
    try {
      const { EmailService } = require('./email-service')
      const email = this.getSetting('notification_email')
      if (!email) return

      await EmailService.getInstance(this.db).send({
        to: email,
        subject: `Sync error — McQuire Tracker`,
        html: `
          <p>One or more sync operations failed:</p>
          <ul>${errors.map((e) => `<li>${e}</li>`).join('')}</ul>
          <p>Check Settings → Sync Log for details.</p>
        `,
      })
    } catch {
      // non-fatal
    }
  }

  // ─── DB helpers ───────────────────────────────────────────────────────────────

  private getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  private setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }
}
