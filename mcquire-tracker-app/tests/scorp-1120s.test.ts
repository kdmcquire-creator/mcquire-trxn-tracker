// tests/scorp-1120s.test.ts
// Verifies the 1120-S tax math: category→IRS-line mapping, deduction totals,
// ordinary income, officer comp fallback, and the 50% meals figure.

import { describe, it, expect, beforeEach } from 'vitest'
import { compute1120S } from '../electron/services/excel-export'
import { makeDb, applyCoreSchema, insertTx, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

function llc(db: CompatDb, acct: string, category: string, amount: number, date: string, extra: any = {}) {
  insertTx(db, { account_id: acct, merchant_name: category.toLowerCase(), amount, transaction_date: date,
    bucket: 'Moonsmoke LLC', review_status: 'manually_classified', ...extra })
  // llc_category is set via direct update since helper doesn't expose it
  db.prepare(`UPDATE transactions SET llc_category=? WHERE rowid=(SELECT MAX(rowid) FROM transactions)`).run(category)
}

describe('1120-S computation', () => {
  let db: CompatDb
  const A = 'a'
  beforeEach(async () => { db = await makeDb(); applyCoreSchema(db); insertAccount(db, A, '2255') })

  const inputs = {
    taxYear: '2025', grossReceipts: 100000, officerCompensation: 0,
    distributions: 20000, otherIncome: 0, beginningCash: 5000, endingCash: 8000,
  }

  it('maps categories to the correct IRS lines and totals them', () => {
    llc(db, A, 'Rent - Business Lodging', 2850, '2025-01-01')
    llc(db, A, 'Lodging - Business Housing', 1150, '2025-02-01') // also line 11
    llc(db, A, 'Taxes - Payroll', 1200, '2025-03-01')           // line 12
    llc(db, A, 'Executive Wellness', 800, '2025-04-01')          // line 18
    llc(db, A, 'Business Services - Software', 500, '2025-05-01') // line 19
    llc(db, A, 'Bank Fees', 50, '2025-06-01')                    // line 19

    const r = compute1120S(db, inputs)
    expect(r.lineTotals['11'].amount).toBeCloseTo(4000)  // 2850 + 1150
    expect(r.lineTotals['12'].amount).toBeCloseTo(1200)
    expect(r.lineTotals['18'].amount).toBeCloseTo(800)
    expect(r.lineTotals['19'].amount).toBeCloseTo(550)   // 500 + 50
    expect(r.totalDeductions).toBeCloseTo(6550)
    expect(r.ordinaryIncome).toBeCloseTo(100000 - 6550)
  })

  it('reports meals at full value on line 19 but a separate 50% figure', () => {
    llc(db, A, 'Meals & Entertainment', 1000, '2025-07-01')
    const r = compute1120S(db, inputs)
    expect(r.mealsFull).toBeCloseTo(1000)
    expect(r.mealsDeductible).toBeCloseTo(500)
  })

  it('officer comp falls back to payroll transactions when not entered manually', () => {
    llc(db, A, 'Payroll - Salary', 60000, '2025-01-15') // line 7
    const r = compute1120S(db, { ...inputs, officerCompensation: 0 })
    expect(r.officerComp).toBeCloseTo(60000)
    // Manual entry overrides
    const r2 = compute1120S(db, { ...inputs, officerCompensation: 72000 })
    expect(r2.officerComp).toBeCloseTo(72000)
  })

  it('excludes split parents and other buckets/years from the math', () => {
    // A split parent (has a child) must be excluded; its child counts
    const parent = insertTx(db, { account_id: A, merchant_name: 'x', amount: 1000, transaction_date: '2025-01-01',
      bucket: 'Moonsmoke LLC', review_status: 'manually_classified' })
    db.prepare(`UPDATE transactions SET llc_category='Travel' WHERE id=?`).run(parent)
    const child = insertTx(db, { account_id: A, merchant_name: 'x', amount: 400, transaction_date: '2025-01-01',
      bucket: 'Moonsmoke LLC', review_status: 'manually_classified', is_split_child: 1, split_parent_id: parent })
    db.prepare(`UPDATE transactions SET llc_category='Travel' WHERE id=?`).run(child)
    // Wrong bucket and wrong year must be ignored
    insertTx(db, { account_id: A, merchant_name: 'y', amount: 9999, transaction_date: '2025-01-01', bucket: 'Peak 10' })
    llc(db, A, 'Travel', 700, '2024-01-01') // prior year

    const r = compute1120S(db, inputs)
    expect(r.lineTotals['19'].amount).toBeCloseTo(400) // only the child
  })
})
