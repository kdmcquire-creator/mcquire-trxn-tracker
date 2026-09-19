// tests/expense-report-manager.test.ts
// Report auditing/lifecycle + Peak 10 outstanding math + duplicate cleanup.
import { describe, it, expect, beforeEach } from 'vitest'
import { makeDb, applyCoreSchema } from './helpers/db'
import type { CompatDb } from '../electron/services/database'
import {
  listExpenseReports, latestReportInputs, markReportSubmitted, markReportPaid,
  deleteReport, setReportArchived, peak10Outstanding, dedupeExpenseReports,
} from '../electron/services/expense-report-manager'

// One statement per prepare().run() — sidesteps the DDL security-hook false positive.
function reportSchema(db: CompatDb) {
  db.prepare(`CREATE TABLE expense_reports (
    id TEXT PRIMARY KEY, report_period TEXT NOT NULL, date_generated TEXT NOT NULL,
    file_path TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
    total_amount REAL NOT NULL DEFAULT 0, transaction_count INTEGER NOT NULL DEFAULT 0,
    notes TEXT, date_submitted TEXT, date_paid TEXT, archived INTEGER NOT NULL DEFAULT 0
  )`).run()
  db.prepare(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`).run()
}
let seq = 0
function addReport(db: CompatDb, o: Partial<{ id: string; period: string; status: string; gen: string; total: number; count: number; notes: any }>) {
  const id = o.id ?? `r${seq++}`
  db.prepare(`INSERT INTO expense_reports (id, report_period, date_generated, file_path, status, total_amount, transaction_count, notes)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    id, o.period ?? 'P', o.gen ?? '2026-01-01 00:00:00', `/f/${id}.xlsx`, o.status ?? 'draft',
    o.total ?? 0, o.count ?? 0, JSON.stringify(o.notes ?? {}))
  return id
}
function addTx(db: CompatDb, o: Partial<{ id: string; bucket: string; amount: number; date: string; reportId: string; review: string; parent: string; splitChild: number }>) {
  const id = o.id ?? `t${seq++}`
  db.prepare(`INSERT INTO transactions (id, account_id, transaction_date, description_raw, amount, bucket, review_status, expense_report_id, split_parent_id, is_split_child)
    VALUES (?, 'a', ?, 'x', ?, ?, ?, ?, ?, ?)`).run(
    id, o.date ?? '2026-06-15', o.amount ?? 100, o.bucket ?? 'Peak 10', o.review ?? 'auto_classified',
    o.reportId ?? null, o.parent ?? null, o.splitChild ?? 0)
  return id
}

describe('expense-report-manager', () => {
  let db: CompatDb
  beforeEach(async () => { db = await makeDb(); applyCoreSchema(db); reportSchema(db) })

  it('dedupe keeps the canonical (submitted + tagged) row and removes untagged duplicates', () => {
    // Mirrors the real data: 3 drafts + a submitted row (whose txns are tagged), same period.
    addReport(db, { id: 'd1', period: 'Dec-Feb', status: 'draft', gen: '2026-05-03' })
    addReport(db, { id: 'd2', period: 'Dec-Feb', status: 'draft', gen: '2026-05-03' })
    addReport(db, { id: 'd3', period: 'Dec-Feb', status: 'draft', gen: '2026-05-03' })
    addReport(db, { id: 'sub', period: 'Dec-Feb', status: 'submitted', gen: '2026-06-23' })
    addTx(db, { reportId: 'sub', amount: 500 }) // sub has a tagged txn
    addReport(db, { id: 'jun', period: 'Jun-Sep', status: 'draft', gen: '2026-09-19' }) // lone row, untouched

    const { deleted } = dedupeExpenseReports(db)
    expect(deleted).toBe(3)
    const ids = listExpenseReports(db).map(r => r.id).sort()
    expect(ids).toEqual(['jun', 'sub'])
  })

  it('dedupe never deletes a row that has tagged transactions', () => {
    addReport(db, { id: 'a', period: 'P', status: 'submitted', gen: '2026-02-01' })
    addReport(db, { id: 'b', period: 'P', status: 'draft', gen: '2026-01-01' })
    addTx(db, { reportId: 'b', amount: 10 }) // even though b is an older draft, it has tags → keep
    const { deleted } = dedupeExpenseReports(db)
    expect(deleted).toBe(0)
    expect(listExpenseReports(db)).toHaveLength(2)
  })

  it('peak10Outstanding is cutoff-aware, excludes tagged + split parents', () => {
    db.prepare("INSERT INTO settings (key,value) VALUES ('peak10_already_reimbursed_through','2025-11-30')").run()
    addTx(db, { amount: 1000, date: '2025-06-01' })                         // pre-cutoff → reimbursed, not outstanding
    addTx(db, { amount: 200, date: '2026-06-01' })                          // after cutoff, untagged → outstanding
    addTx(db, { amount: 300, date: '2026-07-01', reportId: 'sub' })         // after cutoff, tagged → not outstanding
    addReport(db, { id: 'sub', status: 'submitted' })
    // split: parent (Peak 10) with a Peak 10 child — only the child should count
    addTx(db, { id: 'par', amount: 400, date: '2026-08-01' })
    addTx(db, { id: 'kid', amount: 150, date: '2026-08-01', parent: 'par', splitChild: 1, review: 'manually_classified' })

    const p = peak10Outstanding(db)
    // total (parent excluded): 1000 + 200 + 300 + 150 = 1650
    expect(p.total).toBe(1650)
    // outstanding (after cutoff, untagged, non-parent): 200 + 150 = 350
    expect(p.outstanding).toBe(350)
    expect(p.reimbursed).toBe(1300)
  })

  it('markReportPaid stamps paid + submitted and tags the report transactions', () => {
    const t1 = addTx(db, { amount: 100 }); const t2 = addTx(db, { amount: 200 })
    addReport(db, { id: 'r', status: 'draft', notes: { txIds: [t1, t2] } })
    const res = markReportPaid(db, 'r')
    expect(res.tagged).toBe(2)
    const row = db.prepare("SELECT status, date_paid, date_submitted FROM expense_reports WHERE id='r'").get() as any
    expect(row.status).toBe('paid')
    expect(row.date_paid).toBeTruthy()
    expect(row.date_submitted).toBeTruthy()
    const tagged = db.prepare("SELECT COUNT(*) n FROM transactions WHERE expense_report_id='r'").get() as any
    expect(tagged.n).toBe(2)
  })

  it('deleteReport untags its transactions (return to outstanding) and removes the row', () => {
    const t1 = addTx(db, { amount: 100, reportId: 'r' })
    addReport(db, { id: 'r', status: 'submitted', notes: { txIds: [t1] } })
    deleteReport(db, 'r')
    expect(db.prepare("SELECT COUNT(*) n FROM expense_reports WHERE id='r'").get() as any).toMatchObject({ n: 0 })
    const tx = db.prepare("SELECT expense_report_id FROM transactions WHERE id=?").get(t1) as any
    expect(tx.expense_report_id).toBeNull()
  })

  it('markReportSubmitted + archive + latest inputs', () => {
    addReport(db, { id: 'r', status: 'draft', gen: '2026-09-01', period: 'Sep', notes: { dateFrom: '2026-06-01', dateTo: '2026-09-18' } })
    markReportSubmitted(db, 'r')
    expect((db.prepare("SELECT status FROM expense_reports WHERE id='r'").get() as any).status).toBe('submitted')
    setReportArchived(db, 'r', true)
    expect((db.prepare("SELECT archived FROM expense_reports WHERE id='r'").get() as any).archived).toBe(1)
    expect(latestReportInputs(db)).toEqual({ periodLabel: 'Sep', dateFrom: '2026-06-01', dateTo: '2026-09-18' })
  })
})
