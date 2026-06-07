// tests/reports.test.ts
// Locks in the expense-report readiness logic that previously produced
// phantom blockers (literal 'null' notes, split parents, wrong date range).

import { describe, it, expect, beforeEach } from 'vitest'
import { validateExpenseReportReadiness } from '../electron/services/excel-export'
import { makeDb, applyCoreSchema, insertTx, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

const MEAL = 'Meals & Meetings - external'

describe('expense report readiness', () => {
  let db: CompatDb
  const A = 'a'
  beforeEach(async () => {
    db = await makeDb(); applyCoreSchema(db); insertAccount(db, A, '5829')
  })

  it('flags a P10 meal with no attendee notes', () => {
    insertTx(db, { account_id: A, merchant_name: 'park house', amount: 150,
      transaction_date: '2026-01-15', bucket: 'Peak 10', p10_category: MEAL, description_notes: null })
    const r = validateExpenseReportReadiness(db, '2026-01-01', '2026-02-28')
    expect(r.valid).toBe(false)
    expect(r.blocking.join(' ')).toMatch(/Meals & Meetings/)
  })

  it('treats the literal string "null" as missing notes', () => {
    insertTx(db, { account_id: A, merchant_name: 'bari', amount: 200,
      transaction_date: '2026-01-15', bucket: 'Peak 10', p10_category: MEAL, description_notes: 'null' })
    expect(validateExpenseReportReadiness(db, '2026-01-01', '2026-02-28').valid).toBe(false)
  })

  it('passes when attendee notes are present', () => {
    insertTx(db, { account_id: A, merchant_name: 'park house', amount: 150,
      transaction_date: '2026-01-15', bucket: 'Peak 10', p10_category: MEAL,
      description_notes: 'John Smith (CEO), Jane Doe (CFO)' })
    expect(validateExpenseReportReadiness(db, '2026-01-01', '2026-02-28').valid).toBe(true)
  })

  it('does NOT count a split PARENT as a blocker (only its children matter)', () => {
    const parent = insertTx(db, { account_id: A, merchant_name: 'briar club', amount: 955,
      transaction_date: '2026-01-06', bucket: 'Peak 10', p10_category: MEAL, description_notes: null })
    // Children carry the real allocations + notes
    insertTx(db, { account_id: A, merchant_name: 'briar club', amount: 500,
      transaction_date: '2026-01-06', bucket: 'Peak 10', p10_category: MEAL,
      description_notes: 'Attendees listed', is_split_child: 1, split_parent_id: parent })
    insertTx(db, { account_id: A, merchant_name: 'briar club', amount: 455,
      transaction_date: '2026-01-06', bucket: 'Personal', is_split_child: 1, split_parent_id: parent })
    // Parent has no notes but is split → must not block
    expect(validateExpenseReportReadiness(db, '2026-01-01', '2026-02-28').valid).toBe(true)
  })

  it('respects the date range (ignores meals outside the period)', () => {
    insertTx(db, { account_id: A, merchant_name: 'topgolf', amount: 120,
      transaction_date: '2025-10-19', bucket: 'Peak 10', p10_category: MEAL, description_notes: null })
    // Asking about Dec 2025–Feb 2026 must NOT see the Oct 2025 meal
    expect(validateExpenseReportReadiness(db, '2025-12-01', '2026-02-28').valid).toBe(true)
    // Asking about a range that includes it → blocked
    expect(validateExpenseReportReadiness(db, '2025-10-01', '2025-10-31').valid).toBe(false)
  })
})
