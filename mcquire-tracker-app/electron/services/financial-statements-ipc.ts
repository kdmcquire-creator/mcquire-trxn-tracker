// electron/services/financial-statements-ipc.ts
//
// Phase 4 — IPC handlers for all financial statement exports.
// Register by calling registerFinancialStatementsHandlers() in main process.

import { ipcMain, shell } from 'electron'
import * as fs from 'fs'
import type { CompatDb } from './database'
import { FinancialStatementsService } from './financial-statements.service'
import {
  generatePeak10ExpenseReport,
  validateExpenseReportReadiness,
} from './excel-export'
import * as path from 'path'

export function registerFinancialStatementsHandlers(
  db: CompatDb,
  getSyncFolder: () => string
): void {
  const svc = FinancialStatementsService.getInstance(db)

  // ── P&L ──────────────────────────────────────────────────────────────────────
  ipcMain.handle('statements:pandl', async () => {
    try {
      const outputPath = await svc.generatePandL(getSyncFolder())
      return { success: true, data: outputPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── Balance Sheet ─────────────────────────────────────────────────────────────
  ipcMain.handle('statements:balance-sheet', async () => {
    try {
      const outputPath = await svc.generateBalanceSheet(getSyncFolder())
      return { success: true, data: outputPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── Cashflow ──────────────────────────────────────────────────────────────────
  ipcMain.handle('statements:cashflow', async () => {
    try {
      const outputPath = await svc.generateCashflow(getSyncFolder())
      return { success: true, data: outputPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── Personal Summary ──────────────────────────────────────────────────────────
  ipcMain.handle('statements:personal-summary', async () => {
    try {
      const outputPath = await svc.generatePersonalSummary(getSyncFolder())
      return { success: true, data: outputPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── Full Tracker Export ───────────────────────────────────────────────────────
  ipcMain.handle('statements:full-tracker', async () => {
    try {
      const outputPath = await svc.generateFullTracker(getSyncFolder())
      return { success: true, data: outputPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── Open exports folder in Explorer ──────────────────────────────────────────
  ipcMain.handle('statements:open-folder', async () => {
    const exportDir = require('path').join(getSyncFolder(), 'exports', 'statements')
    require('fs').mkdirSync(exportDir, { recursive: true })
    shell.openPath(exportDir)
    return { success: true }
  })

  // ── Cash balance manual entry (for Balance Sheet) ─────────────────────────────
  ipcMain.handle('statements:set-cash-balance', async (_event, { date, amount }: { date: string; amount: number }) => {
    try {
      db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(`cash_balance_${date}`, String(amount))
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── Revenue manual entry (for P&L — Strawn wire amounts) ─────────────────────
  ipcMain.handle('statements:set-revenue', async (_event, { month, amount }: { month: string; amount: number }) => {
    try {
      db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(`revenue_${month}`, String(amount))
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── Peak 10 Expense Report (reports:* channel) ────────────────────────────────
  ipcMain.handle('reports:check-expense-report-readiness', async (_event, payload?: { dateFrom?: string; dateTo?: string }) => {
    try {
      const dateFrom = payload?.dateFrom ?? '2025-01-01'
      const dateTo = payload?.dateTo ?? new Date().toISOString().substring(0, 10)
      const result = validateExpenseReportReadiness(db, dateFrom, dateTo)
      return {
        success: true,
        data: {
          ready: result.valid,
          blockers: result.blocking,
          warnings: result.warnings,
        },
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('reports:get-blocker-transactions', (_event, payload?: { dateFrom?: string; dateTo?: string }) => {
    try {
      const dateFrom = payload?.dateFrom ?? '2025-01-01'
      const dateTo = payload?.dateTo ?? new Date().toISOString().substring(0, 10)
      const meals = db.prepare(`
        SELECT t.*, a.account_name, a.account_mask, a.institution
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.bucket = 'Peak 10'
          AND t.p10_category IN ('Meals & Meetings - external','Meals & Meetings - internal','Meals & Meetings - internal and external mixed attendees')
          AND (t.description_notes IS NULL OR TRIM(t.description_notes) = '' OR t.description_notes = 'null')
          AND t.transaction_date >= ? AND t.transaction_date <= ?
          AND t.review_status IN ('auto_classified','manually_classified')
          AND NOT EXISTS (SELECT 1 FROM transactions c WHERE c.split_parent_id = t.id)
        ORDER BY t.transaction_date DESC
      `).all(dateFrom, dateTo)
      const attSplits = db.prepare(`
        SELECT t.*, a.account_name, a.account_mask, a.institution
        FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.bucket = 'Peak 10'
          AND t.review_status = 'flagged'
          AND t.flag_reason LIKE '%AT&T%split%'
          AND t.transaction_date >= ? AND t.transaction_date <= ?
        ORDER BY t.transaction_date DESC
      `).all(dateFrom, dateTo)
      return { success: true, data: { meals, attSplits } }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Check for overlapping prior reports in the date range
  ipcMain.handle('reports:check-overlap', (_event, payload: { dateFrom: string; dateTo: string }) => {
    try {
      const { dateFrom, dateTo } = payload
      const priorReports = db.prepare(`
        SELECT er.id, er.report_period, er.date_generated, er.status, er.total_amount, er.transaction_count
        FROM expense_reports er
        WHERE er.status = 'draft'
          AND er.notes IS NOT NULL
      `).all() as Array<{
        id: string; report_period: string; date_generated: string;
        status: string; total_amount: number; transaction_count: number
      }>

      // Check which drafts overlap with the requested date range
      const overlapping = priorReports.filter(r => {
        try {
          const notes = JSON.parse(db.prepare("SELECT notes FROM expense_reports WHERE id = ?").get(r.id)?.notes ?? '{}')
          return notes.dateFrom && notes.dateTo &&
            notes.dateFrom <= dateTo && notes.dateTo >= dateFrom
        } catch { return false }
      })

      return { success: true, data: { hasOverlap: overlapping.length > 0, reports: overlapping } }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Confirm a prior report was submitted — tags its transactions
  ipcMain.handle('reports:confirm-submitted', (_event, reportId: string) => {
    try {
      const report = db.prepare("SELECT id, notes FROM expense_reports WHERE id = ?").get(reportId) as { id: string; notes: string } | undefined
      if (!report) return { success: false, error: 'Report not found' }

      const notesData = JSON.parse(report.notes ?? '{}')
      const txIds: string[] = notesData.txIds ?? []

      db.prepare("UPDATE expense_reports SET status = 'submitted' WHERE id = ?").run(reportId)

      if (txIds.length > 0) {
        const upd = db.prepare("UPDATE transactions SET expense_report_id = ? WHERE id = ?")
        db.transaction(() => txIds.forEach(id => upd.run(reportId, id)))()
      }

      console.log(`[Reports] Marked report ${reportId} as submitted, tagged ${txIds.length} transactions`)
      return { success: true, data: { tagged: txIds.length } }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('reports:generate-expense-report', async (_event, payload: { dateFrom: string; dateTo: string; periodLabel?: string; includeAlreadyReported?: boolean }) => {
    try {
      const { dateFrom, dateTo, periodLabel, includeAlreadyReported } = payload
      const label = periodLabel ?? `${dateFrom} – ${dateTo}`
      const exportDir = path.join(getSyncFolder(), 'exports', 'expense_reports')
      fs.mkdirSync(exportDir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
      const outputPath = path.join(exportDir, `Peak10_ExpenseReport_${ts}.xlsx`)
      const result = await generatePeak10ExpenseReport(db, dateFrom, dateTo, label, outputPath, { includeAlreadyReported })
      return { success: true, data: { filePath: result.file_path, total: result.total, count: result.count, reportId: result.report_id } }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ── Get current manual entries (for Reports UI display) ───────────────────────
  ipcMain.handle('statements:get-manual-entries', async () => {
    try {
      const revenue = db
        .prepare("SELECT key, value FROM settings WHERE key LIKE 'revenue_%' ORDER BY key")
        .all() as Array<{ key: string; value: string }>

      const cashBalances = db
        .prepare("SELECT key, value FROM settings WHERE key LIKE 'cash_balance_%' ORDER BY key")
        .all() as Array<{ key: string; value: string }>

      return {
        success: true,
        data: {
          revenue: revenue.map((r) => ({
            month: r.key.replace('revenue_', ''),
            amount: parseFloat(r.value),
          })),
          cash_balances: cashBalances.map((r) => ({
            date: r.key.replace('cash_balance_', ''),
            amount: parseFloat(r.value),
          })),
        },
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
