// tests/migration018-dedup-repair.test.ts
// Migration 021: re-exclude the migration-018-restored copy of each CROSS-ACCOUNT
// duplicate (same amount, ≤3 days, different account), keeping the twin. Same-
// account near-amount rows and rows with no twin are left alone. Idempotent.

import { describe, it, expect, beforeEach } from 'vitest'
import { reExcludeMigration018Duplicates } from '../electron/services/migration018-dedup-repair'
import { makeDb, applyCoreSchema, applyRulesSchema, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

function addTx(db: CompatDb, id: string, ac: string, merchant: string, amount: number, d: string, flag: string | null): void {
  db.prepare(`
    INSERT INTO transactions (id, account_id, merchant_name, description_raw, amount,
      transaction_date, bucket, p10_category, rule_id, review_status, flag_reason)
    VALUES (?,?,?,?,?,?,'Peak 10','Meals & Meetings - external','p10-001','manually_classified',?)
  `).run(id, ac, merchant, merchant, amount, d, flag)
}
const RESTORED = 'Restored from manual review (migration 018)'

describe('migration 018 duplicate re-exclusion (migration 021)', () => {
  let db: CompatDb
  beforeEach(async () => {
    db = await makeDb()
    applyCoreSchema(db); applyRulesSchema(db)
    insertAccount(db, 'a', '5829'); insertAccount(db, 'b', '5829') // same card, two source records
  })

  it('re-excludes only cross-account 018 duplicates, keeping the twin', () => {
    // cross-account dup: restored on acct a, twin on acct b, 0 days apart
    addTx(db, 'ph_restored', 'a', 'Park House Houston', 164.16, '2026-02-11', RESTORED)
    addTx(db, 'ph_twin', 'b', 'Park House', 164.16, '2026-02-11', null)
    // cross-account dup 2 days apart
    addTx(db, 'fs_restored', 'a', 'Four Seasons', 2073.04, '2026-02-21', RESTORED)
    addTx(db, 'fs_twin', 'b', 'Four Seasons Htl', 2073.04, '2026-02-23', null)
    // SAME-account near-amount (e.g. real gas / fee) — must be left alone
    addTx(db, 'gas_restored', 'a', 'shell shell', 61.79, '2026-06-07', RESTORED)
    addTx(db, 'gas_twin', 'a', 'shell', 61.79, '2026-06-09', null)
    // restored with NO twin — kept (this is a legitimate restore)
    addTx(db, 'solo_restored', 'a', 'Mexta', 148.25, '2026-04-22', RESTORED)
    // cross-account but > 3 days apart — not a dup
    addTx(db, 'far_restored', 'a', 'Bloomberg', 40.00, '2026-01-13', RESTORED)
    addTx(db, 'far_twin', 'b', 'Bloomberg', 40.00, '2026-01-20', null)
    // same merchant, very different strings — must still match (shared "fitness")
    addTx(db, 'fit_restored', 'a', 'P Fitness', 3000.00, '2026-02-21', RESTORED)
    addTx(db, 'fit_twin', 'b', 'P2P FITNESS', 3000.00, '2026-02-22', null)
    // DIFFERENT merchants, same $15, cross-account, near date — NOT a dup (the
    // Wire Fee false positive that amount-only matching wrongly caught)
    addTx(db, 'wire_restored', 'a', 'Wire Fee', 15.00, '2026-01-08', RESTORED)
    addTx(db, 'ms_twin', 'b', 'Monthly Service Fee', 15.00, '2026-01-09', null)

    const res = reExcludeMigration018Duplicates(db)
    expect(res.reExcluded).toBe(3)   // ph + fs + fit (NOT wire)

    const bk = (id: string) => (db.prepare('SELECT bucket AS b FROM transactions WHERE id=?').get(id) as { b: string }).b
    expect(bk('ph_restored')).toBe('Exclude')   // re-excluded
    expect(bk('ph_twin')).toBe('Peak 10')       // kept
    expect(bk('fs_restored')).toBe('Exclude')
    expect(bk('fs_twin')).toBe('Peak 10')
    expect(bk('gas_restored')).toBe('Peak 10')  // same-account — untouched
    expect(bk('gas_twin')).toBe('Peak 10')
    expect(bk('solo_restored')).toBe('Peak 10') // no twin — untouched
    expect(bk('far_restored')).toBe('Peak 10')  // > 3 days — untouched
    expect(bk('fit_restored')).toBe('Exclude')  // matched via shared "fitness"
    expect(bk('fit_twin')).toBe('Peak 10')
    expect(bk('wire_restored')).toBe('Peak 10') // merchant mismatch — untouched
    expect(bk('ms_twin')).toBe('Peak 10')
  })

  it('is idempotent', () => {
    addTx(db, 'r', 'a', 'Park House Houston', 99.99, '2026-03-01', RESTORED)
    addTx(db, 't', 'b', 'Park House', 99.99, '2026-03-02', null)
    expect(reExcludeMigration018Duplicates(db).reExcluded).toBe(1)
    expect(reExcludeMigration018Duplicates(db).reExcluded).toBe(0)
  })
})
