// tests/attbill-repair.test.ts
// Proves migration 016: AT&T wireless-bill charges ("ATT* BILL PAYMENT", mask
// 5829) that the over-broad 'payment' exclude had swallowed get reclassified by
// amount band — <$100 → Moonsmoke LLC, $100-299 → Peak 10, ≥$300 → Review Queue
// (split flag). Exercises the REAL classification engine.

import { describe, it, expect, beforeEach } from 'vitest'
import { reclassifyExcludedAttBills } from '../electron/services/attbill-repair'
import { makeDb, applyCoreSchema, applyRulesSchema, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

function addRule(db: CompatDb, r: {
  id: string; match_value: string; bucket: string; action: string; priority: number
  match_type?: string; mask?: string | null; amount_min?: number | null; amount_max?: number | null
  p10_category?: string | null; llc_category?: string | null; flag_reason?: string | null
}): void {
  db.prepare(`
    INSERT INTO rules (id, rule_name, section, match_type, match_value, account_mask_filter,
      amount_min, amount_max, bucket, p10_category, llc_category, flag_reason, action, priority_order, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(r.id, r.id, 'test', r.match_type ?? 'contains', r.match_value, r.mask ?? null,
    r.amount_min ?? null, r.amount_max ?? null, r.bucket, r.p10_category ?? null,
    r.llc_category ?? null, r.flag_reason ?? null, r.action, r.priority)
}

function addExcludedAttBill(db: CompatDb, id: string, accountId: string, amount: number): void {
  db.prepare(`
    INSERT INTO transactions (id, account_id, merchant_name, description_raw, amount,
      transaction_date, bucket, rule_id, review_status)
    VALUES (?,?,?,?,?,?,'Exclude','excl-004','auto_classified')
  `).run(id, accountId, 'AT&T', 'ATT* BILL PAYMENT', amount, '2026-01-15')
}

describe('AT&T wireless-bill repair (migration 016)', () => {
  let db: CompatDb
  beforeEach(async () => {
    db = await makeDb()
    applyCoreSchema(db)
    applyRulesSchema(db)
    insertAccount(db, 'a', '5829')   // the AT&T wireless account
    insertAccount(db, 'b', '9999')   // some other account
    // Post-015 payment exclude + the three banded AT&T-bill rules (mirrors the seed).
    addRule(db, { id: 'excl-004', match_value: 'payment', bucket: 'Exclude', action: 'exclude', priority: 8999 })
    addRule(db, { id: 'llc-021', match_value: 'att bill', bucket: 'Moonsmoke LLC', action: 'classify', priority: 220, mask: '5829', amount_max: 99.99, llc_category: 'Telephone - Business Line' })
    addRule(db, { id: 'p10-038', match_value: 'att bill', bucket: 'Peak 10', action: 'classify', priority: 337, mask: '5829', amount_min: 100, amount_max: 299.99, p10_category: 'Telephone & Communication' })
    addRule(db, { id: 'p10-039', match_value: 'att bill', bucket: 'Peak 10', action: 'split_flag', priority: 338, mask: '5829', amount_min: 300, p10_category: 'Telephone & Communication', flag_reason: 'AT&T split required' })
  })

  it('reclassifies AT&T bills by amount band', () => {
    addExcludedAttBill(db, 'small', 'a', 75.70)   // < $100  → LLC
    addExcludedAttBill(db, 'mid', 'a', 204.30)    // $100-299 → Peak 10
    addExcludedAttBill(db, 'large', 'a', 463.73)  // ≥ $300  → split → review

    const res = reclassifyExcludedAttBills(db)
    expect(res).toEqual({ toLLC: 1, toP10: 1, toReview: 1 })

    const get = (id: string) => db.prepare('SELECT bucket, rule_id, review_status FROM transactions WHERE id=?').get(id) as any
    expect(get('small')).toMatchObject({ bucket: 'Moonsmoke LLC', rule_id: 'llc-021', review_status: 'auto_classified' })
    expect(get('mid')).toMatchObject({ bucket: 'Peak 10', rule_id: 'p10-038', review_status: 'auto_classified' })
    expect(get('large')).toMatchObject({ bucket: null, rule_id: 'p10-039', review_status: 'pending_review' })
  })

  it('leaves an AT&T bill on a non-5829 account excluded (mask guard)', () => {
    addExcludedAttBill(db, 'wrongacct', 'b', 75.70)   // mask 9999, not 5829
    expect(reclassifyExcludedAttBills(db)).toEqual({ toLLC: 0, toP10: 0, toReview: 0 })
    expect((db.prepare("SELECT bucket FROM transactions WHERE id='wrongacct'").get() as any).bucket).toBe('Exclude')
  })

  it('is idempotent — a second run moves nothing', () => {
    addExcludedAttBill(db, 's2', 'a', 75.70)
    expect(reclassifyExcludedAttBills(db).toLLC).toBe(1)
    expect(reclassifyExcludedAttBills(db)).toEqual({ toLLC: 0, toP10: 0, toReview: 0 })
  })
})
