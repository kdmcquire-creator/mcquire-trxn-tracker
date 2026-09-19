// electron/services/expense-report-manager.ts
//
// Pure(ish) DB logic for auditing and managing Peak 10 expense reports — extracted
// from the IPC layer so it can be unit-tested (CLAUDE.md §5). The IPC handlers in
// financial-statements-ipc.ts, the dashboard bucket totals, and migration 023 all
// call these; don't re-inline the SQL.

import type { CompatDb } from './database'

export const REIMBURSE_CUTOFF_DEFAULT = '2025-11-30'

const parseNotes = (n: string | null): any => { try { return JSON.parse(n ?? '{}') } catch { return {} } }

export interface ExpenseReportRow {
  id: string; report_period: string; date_generated: string
  date_submitted: string | null; date_paid: string | null; file_path: string
  status: string; total_amount: number; transaction_count: number; archived: number
  dateFrom: string | null; dateTo: string | null
}

export function listExpenseReports(db: CompatDb): ExpenseReportRow[] {
  const rows = db.prepare(`
    SELECT id, report_period, date_generated, date_submitted, date_paid, file_path,
           status, total_amount, transaction_count, archived, notes
    FROM expense_reports ORDER BY date_generated DESC
  `).all() as any[]
  return rows.map(r => {
    const n = parseNotes(r.notes)
    const { notes: _notes, ...rest } = r
    return { ...rest, dateFrom: n.dateFrom ?? null, dateTo: n.dateTo ?? null } as ExpenseReportRow
  })
}

export function latestReportInputs(db: CompatDb): { periodLabel: string; dateFrom: string | null; dateTo: string | null } | null {
  const r = db.prepare("SELECT report_period, notes FROM expense_reports ORDER BY date_generated DESC LIMIT 1")
    .get() as { report_period: string; notes: string } | undefined
  if (!r) return null
  const n = parseNotes(r.notes)
  return { periodLabel: r.report_period, dateFrom: n.dateFrom ?? null, dateTo: n.dateTo ?? null }
}

/** Tag this report's transactions (from its stored txIds) with its id. Idempotent. */
export function tagReportTransactions(db: CompatDb, reportId: string): number {
  const r = db.prepare("SELECT notes FROM expense_reports WHERE id=?").get(reportId) as { notes: string } | undefined
  const ids: string[] = parseNotes(r?.notes ?? null).txIds ?? []
  if (ids.length) {
    const upd = db.prepare("UPDATE transactions SET expense_report_id=? WHERE id=?")
    db.transaction(() => ids.forEach(id => upd.run(reportId, id)))()
  }
  return ids.length
}

export function markReportSubmitted(db: CompatDb, reportId: string): { tagged: number } {
  db.prepare("UPDATE expense_reports SET status='submitted', date_submitted=COALESCE(date_submitted, datetime('now')) WHERE id=?").run(reportId)
  return { tagged: tagReportTransactions(db, reportId) }
}

export function markReportPaid(db: CompatDb, reportId: string): { tagged: number } {
  // paid implies submitted → keep the transactions tagged and stamp both dates.
  db.prepare("UPDATE expense_reports SET status='paid', date_paid=datetime('now'), date_submitted=COALESCE(date_submitted, datetime('now')) WHERE id=?").run(reportId)
  return { tagged: tagReportTransactions(db, reportId) }
}

/** Delete a report; its transactions return to "outstanding" (untagged). File left on disk. */
export function deleteReport(db: CompatDb, reportId: string): void {
  db.transaction(() => {
    db.prepare("UPDATE transactions SET expense_report_id=NULL WHERE expense_report_id=?").run(reportId)
    db.prepare("DELETE FROM expense_reports WHERE id=?").run(reportId)
  })()
}

export function setReportArchived(db: CompatDb, reportId: string, archived: boolean): void {
  db.prepare("UPDATE expense_reports SET archived=? WHERE id=?").run(archived ? 1 : 0, reportId)
}

export function reimburseCutoff(db: CompatDb): string {
  return (db.prepare("SELECT value FROM settings WHERE key='peak10_already_reimbursed_through'").get() as { value: string } | undefined)?.value ?? REIMBURSE_CUTOFF_DEFAULT
}

/** Peak 10 reimbursement position. Outstanding mirrors the expense-report query:
 *  after the reimbursement cutoff, classified, not tagged to a submitted/paid report,
 *  not a split parent. */
export function peak10Outstanding(db: CompatDb): { total: number; outstanding: number; reimbursed: number; cutoff: string } {
  const cutoff = reimburseCutoff(db)
  const notParent = "AND NOT EXISTS (SELECT 1 FROM transactions _sp WHERE _sp.split_parent_id = t.id)"
  const total = (db.prepare(`SELECT COALESCE(SUM(ABS(t.amount)),0) s FROM transactions t WHERE t.bucket='Peak 10' ${notParent}`).get() as { s: number }).s
  const outstanding = (db.prepare(`
    SELECT COALESCE(SUM(ABS(t.amount)),0) s FROM transactions t
    WHERE t.bucket='Peak 10' AND t.review_status IN ('auto_classified','manually_classified')
      AND t.transaction_date > ? AND t.expense_report_id IS NULL ${notParent}
  `).get(cutoff) as { s: number }).s
  return { total, outstanding, reimbursed: Math.round((total - outstanding) * 100) / 100, cutoff }
}

/** De-duplicate expense_reports: per period keep one canonical row (most-advanced
 *  status, then a row with tagged transactions, then newest) and delete the OTHERS
 *  that have no transactions tagged to them (so nothing is orphaned). Idempotent. */
export function dedupeExpenseReports(db: CompatDb): { deleted: number } {
  const rows = db.prepare(`
    SELECT er.id, er.report_period, er.status, er.date_generated,
           (SELECT COUNT(*) FROM transactions t WHERE t.expense_report_id = er.id) AS tagged
    FROM expense_reports er
  `).all() as Array<{ id: string; report_period: string; status: string; date_generated: string; tagged: number }>
  const rank = (s: string) => (s === 'paid' ? 3 : s === 'submitted' ? 2 : 1)
  const byPeriod = new Map<string, typeof rows>()
  for (const r of rows) { const g = byPeriod.get(r.report_period) ?? []; g.push(r); byPeriod.set(r.report_period, g) }
  let deleted = 0
  const del = db.prepare("DELETE FROM expense_reports WHERE id = ?")
  db.transaction(() => {
    for (const group of byPeriod.values()) {
      if (group.length < 2) continue
      const keeper = [...group].sort((a, b) =>
        rank(b.status) - rank(a.status) ||
        ((b.tagged > 0 ? 1 : 0) - (a.tagged > 0 ? 1 : 0)) ||
        b.date_generated.localeCompare(a.date_generated))[0]
      for (const r of group) if (r.id !== keeper.id && r.tagged === 0) { del.run(r.id); deleted++ }
    }
  })()
  return { deleted }
}
