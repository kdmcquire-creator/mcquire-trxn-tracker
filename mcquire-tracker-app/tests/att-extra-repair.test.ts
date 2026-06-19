// tests/att-extra-repair.test.ts
// Migration 017: AT&T MOBILITY EPAY is banded like the wireless bill; ATT BUSINESS
// UVERSE → Peak 10 and UVERSE CONS → Moonsmoke LLC (Kyle's calls). A mobility charge
// already excluded as a duplicate is left alone. Exercises the real engine.

import { describe, it, expect, beforeEach } from 'vitest'
import { reclassifyAttExtras } from '../electron/services/att-extra-repair'
import { makeDb, applyCoreSchema, applyRulesSchema, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

function addRule(db: CompatDb, r: {
  id: string; match_value: string; bucket: string; action: string; priority: number
  mask?: string | null; amount_min?: number | null; amount_max?: number | null
  p10_category?: string | null; llc_category?: string | null; flag_reason?: string | null
}): void {
  db.prepare(`
    INSERT INTO rules (id, rule_name, section, match_type, match_value, account_mask_filter,
      amount_min, amount_max, bucket, p10_category, llc_category, flag_reason, action, priority_order, is_active)
    VALUES (?,?,?,'contains',?,?,?,?,?,?,?,?,?,?,1)
  `).run(r.id, r.id, 'test', r.match_value, r.mask ?? null, r.amount_min ?? null, r.amount_max ?? null,
    r.bucket, r.p10_category ?? null, r.llc_category ?? null, r.flag_reason ?? null, r.action, r.priority)
}

function addTx(db: CompatDb, id: string, accountId: string, raw: string, amount: number, bucket: string): void {
  db.prepare(`
    INSERT INTO transactions (id, account_id, merchant_name, description_raw, amount,
      transaction_date, bucket, rule_id, review_status)
    VALUES (?,?,?,?,?,?,?,'default-001','auto_classified')
  `).run(id, accountId, 'AT&T', raw, amount, '2026-04-21', bucket)
}

describe('AT&T mobility / U-verse repair (migration 017)', () => {
  let db: CompatDb
  beforeEach(async () => {
    db = await makeDb()
    applyCoreSchema(db); applyRulesSchema(db)
    insertAccount(db, 'a', '5829')
    insertAccount(db, 'b', '2419')
    addRule(db, { id: 'llc-022', match_value: 'at&t mobility', bucket: 'Moonsmoke LLC', action: 'classify', priority: 221, mask: '5829', amount_max: 99.99, llc_category: 'Telephone - Business Line' })
    addRule(db, { id: 'p10-040', match_value: 'at&t mobility', bucket: 'Peak 10', action: 'classify', priority: 339, mask: '5829', amount_min: 100, amount_max: 299.99, p10_category: 'Telephone & Communication' })
    addRule(db, { id: 'p10-041', match_value: 'at&t mobility', bucket: 'Peak 10', action: 'split_flag', priority: 340, mask: '5829', amount_min: 300, p10_category: 'Telephone & Communication', flag_reason: 'AT&T split required' })
    addRule(db, { id: 'p10-042', match_value: 'business uverse', bucket: 'Peak 10', action: 'classify', priority: 341, p10_category: 'Telephone & Communication' })
    addRule(db, { id: 'llc-023', match_value: 'uverse cons', bucket: 'Moonsmoke LLC', action: 'classify', priority: 222, llc_category: 'Utilities - Home Office' })
    addRule(db, { id: 'default-001', match_value: '', bucket: 'Personal', action: 'classify', priority: 9000 })
  })

  it('bands mobility, routes U-verse per Kyle, and never un-excludes a duplicate', () => {
    addTx(db, 'mob_large', 'a', 'AT&T MOBILITY EPAY', 463.53, 'Personal')   // ≥300 → split/review
    addTx(db, 'mob_small', 'a', 'AT&T MOBILITY EPAY', 75.00, 'Personal')    // <100 → LLC
    addTx(db, 'mob_dup', 'a', 'AT&T MOBILITY EPAY', 469.39, 'Exclude')      // dup → leave excluded
    addTx(db, 'buverse', 'b', 'ATT BUSINESS UVERSE', 210.12, 'Personal')   // → Peak 10
    addTx(db, 'cuverse', 'a', 'UVERSE CONS SW EVR', 75.70, 'Personal')     // → Moonsmoke LLC

    expect(reclassifyAttExtras(db).reclassified).toBe(4)

    const get = (id: string) => db.prepare('SELECT bucket, rule_id, review_status FROM transactions WHERE id=?').get(id) as any
    expect(get('mob_large')).toMatchObject({ bucket: null, rule_id: 'p10-041', review_status: 'pending_review' })
    expect(get('mob_small')).toMatchObject({ bucket: 'Moonsmoke LLC', rule_id: 'llc-022' })
    expect(get('mob_dup')).toMatchObject({ bucket: 'Exclude' })   // untouched
    expect(get('buverse')).toMatchObject({ bucket: 'Peak 10', rule_id: 'p10-042' })
    expect(get('cuverse')).toMatchObject({ bucket: 'Moonsmoke LLC', rule_id: 'llc-023' })
  })

  it('is idempotent', () => {
    addTx(db, 'b1', 'b', 'ATT BUSINESS UVERSE', 210.12, 'Personal')
    expect(reclassifyAttExtras(db).reclassified).toBe(1)
    expect(reclassifyAttExtras(db).reclassified).toBe(0)
  })
})
