// tests/payment-exclude-repair.test.ts
// Proves migration 015's repair: the over-broad "payment" exclude (excl-004) is
// demoted below the vendor rules, and the vendor charges it wrongly excluded
// (Bilt rent) reclassify — while genuine card payments and manual exclusions are
// left untouched. Exercises the REAL classification engine.

import { describe, it, expect, beforeEach } from 'vitest'
import { reprioritizePaymentExclude, PAYMENT_EXCLUDE_PRIORITY } from '../electron/services/payment-exclude-repair'
import { makeDb, applyCoreSchema, applyRulesSchema, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

function addRule(db: CompatDb, r: {
  id: string; match_value: string; bucket: string; action: string; priority: number
  match_type?: string; mask?: string | null; amount_min?: number | null; amount_max?: number | null
  llc_category?: string | null
}): void {
  db.prepare(`
    INSERT INTO rules (id, rule_name, section, match_type, match_value, account_mask_filter,
      amount_min, amount_max, bucket, llc_category, action, priority_order, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(r.id, r.id, 'test', r.match_type ?? 'contains', r.match_value, r.mask ?? null,
    r.amount_min ?? null, r.amount_max ?? null, r.bucket, r.llc_category ?? null, r.action, r.priority)
}

function addTx(db: CompatDb, t: {
  id: string; account_id: string; merchant: string; raw: string; amount: number
  date: string; bucket: string; rule_id: string; status?: string
}): void {
  db.prepare(`
    INSERT INTO transactions (id, account_id, merchant_name, description_raw, amount,
      transaction_date, bucket, rule_id, review_status)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(t.id, t.account_id, t.merchant, t.raw, t.amount, t.date, t.bucket, t.rule_id,
    t.status ?? 'auto_classified')
}

describe('payment-exclude reprioritization (migration 015)', () => {
  let db: CompatDb
  beforeEach(async () => {
    db = await makeDb()
    applyCoreSchema(db)
    applyRulesSchema(db)
    insertAccount(db, 'a', '1111')
    // The over-broad payment exclude (pre-fix priority) + the Bilt vendor rule.
    addRule(db, { id: 'excl-004', match_value: 'payment', bucket: 'Exclude', action: 'exclude', priority: 103 })
    addRule(db, { id: 'llc-002', match_value: 'bilt', bucket: 'Moonsmoke LLC', action: 'classify', priority: 201, llc_category: 'Rent - Business Lodging' })
  })

  it('reclassifies a Bilt rent charge excl-004 wrongly excluded, and demotes the rule', () => {
    addTx(db, { id: 'bilt1', account_id: 'a', merchant: 'Bilt Rewards', raw: 'BILT PAYMENT BILTRENT ***1234', amount: 2422.32, date: '2026-01-09', bucket: 'Exclude', rule_id: 'excl-004' })

    expect(reprioritizePaymentExclude(db).moved).toBe(1)

    const row = db.prepare("SELECT bucket, rule_id, llc_category FROM transactions WHERE id='bilt1'").get() as any
    expect(row.bucket).toBe('Moonsmoke LLC')
    expect(row.rule_id).toBe('llc-002')
    expect(row.llc_category).toBe('Rent - Business Lodging')

    const prio = db.prepare("SELECT priority_order p FROM rules WHERE id='excl-004'").get() as any
    expect(prio.p).toBe(PAYMENT_EXCLUDE_PRIORITY)
  })

  it('leaves a genuine card payment excluded (no vendor rule matches)', () => {
    addTx(db, { id: 'pay1', account_id: 'a', merchant: 'Payment', raw: 'AUTOMATIC PAYMENT - THANK YOU', amount: 5000, date: '2026-01-02', bucket: 'Exclude', rule_id: 'excl-004' })

    expect(reprioritizePaymentExclude(db).moved).toBe(0)

    const row = db.prepare("SELECT bucket, rule_id FROM transactions WHERE id='pay1'").get() as any
    expect(row.bucket).toBe('Exclude')
    expect(row.rule_id).toBe('excl-004')
  })

  it('never touches a manual exclusion', () => {
    addTx(db, { id: 'm1', account_id: 'a', merchant: 'Bilt Rewards', raw: 'BILT PAYMENT BILTRENT', amount: 2422, date: '2026-03-09', bucket: 'Exclude', rule_id: 'excl-004', status: 'manually_classified' })

    expect(reprioritizePaymentExclude(db).moved).toBe(0)
    const row = db.prepare("SELECT bucket FROM transactions WHERE id='m1'").get() as any
    expect(row.bucket).toBe('Exclude')
  })

  it('is idempotent — a second run moves nothing', () => {
    addTx(db, { id: 'bilt2', account_id: 'a', merchant: 'Bilt Rewards', raw: 'BILT PAYMENT BILTRENT', amount: 2229.63, date: '2025-12-03', bucket: 'Exclude', rule_id: 'excl-004' })
    expect(reprioritizePaymentExclude(db).moved).toBe(1)
    expect(reprioritizePaymentExclude(db).moved).toBe(0)
  })
})
