// tests/gas-personal-repair.test.ts
// Migration 020: gas-station fill-ups ≤ $25 are personal, not Peak 10 travel.
// Moves existing Peak 10 gas charges ≤ $25 to Personal; larger fill-ups, manual
// decisions, and non-gas small charges are left alone. Boundary is inclusive ($25).

import { describe, it, expect, beforeEach } from 'vitest'
import { reclassifyGasUnder25 } from '../electron/services/gas-personal-repair'
import { makeDb, applyCoreSchema, applyRulesSchema, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

function addTx(db: CompatDb, id: string, merchant: string, amount: number, bucket = 'Peak 10', status = 'auto_classified'): void {
  db.prepare(`
    INSERT INTO transactions (id, account_id, merchant_name, description_raw, amount,
      transaction_date, bucket, p10_category, rule_id, review_status)
    VALUES (?,?,?,?,?,'2026-01-15',?,'Travel','p10-033',?)
  `).run(id, 'a', merchant, merchant, amount, bucket, status)
}

describe('gas ≤ $25 → Personal (migration 020)', () => {
  let db: CompatDb
  beforeEach(async () => {
    db = await makeDb()
    applyCoreSchema(db); applyRulesSchema(db); insertAccount(db, 'a', '5829')
  })

  it('moves small Peak 10 gas charges to Personal, inclusive of $25', () => {
    addTx(db, 'exxon_sm', 'ExxonMobil', 20.00)        // → Personal
    addTx(db, 'exxon_neg', 'ExxonMobil', -18.50)      // → Personal (abs ≤ 25)
    addTx(db, 'bucee', "Buc-ee's", 23.99)             // → Personal
    addTx(db, 'sev_edge', '7-Eleven', 25.00)          // → Personal (inclusive)
    addTx(db, 'shell_big', 'Shell Oil', 25.01)        // stays Peak 10 (> 25)
    addTx(db, 'exxon_big', 'ExxonMobil', 48.00)       // stays Peak 10
    addTx(db, 'manual', 'Valero', 12.00, 'Peak 10', 'manually_classified') // stays (manual)
    addTx(db, 'nongas', 'Anthropic', 9.99)            // stays (not gas)
    addTx(db, 'already', 'Shell', 8.00, 'Personal')   // already Personal — untouched

    const res = reclassifyGasUnder25(db)
    expect(res.moved).toBe(4)

    const bucket = (id: string) => (db.prepare('SELECT bucket AS b FROM transactions WHERE id=?').get(id) as { b: string }).b
    expect(bucket('exxon_sm')).toBe('Personal')
    expect(bucket('exxon_neg')).toBe('Personal')
    expect(bucket('bucee')).toBe('Personal')
    expect(bucket('sev_edge')).toBe('Personal')
    expect(bucket('shell_big')).toBe('Peak 10')
    expect(bucket('exxon_big')).toBe('Peak 10')
    expect(bucket('manual')).toBe('Peak 10')
    expect(bucket('nongas')).toBe('Peak 10')

    // p10_category cleared + tagged with the matching Personal rule
    const row = db.prepare('SELECT p10_category, rule_id FROM transactions WHERE id=?').get('exxon_sm') as any
    expect(row.p10_category).toBeNull()
    expect(row.rule_id).toBe('pers-002')
  })

  it('is idempotent', () => {
    addTx(db, 'g1', 'Buc-ee\'s', 10.00)
    expect(reclassifyGasUnder25(db).moved).toBe(1)
    expect(reclassifyGasUnder25(db).moved).toBe(0)
  })
})
