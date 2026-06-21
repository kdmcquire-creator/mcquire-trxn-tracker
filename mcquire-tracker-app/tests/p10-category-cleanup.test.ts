// tests/p10-category-cleanup.test.ts
// Migration 019: align Peak 10 categories to the canonical expense-report Account
// list. Legacy "Office Supplies & Expenses" splits by merchant (software →
// Computer/Internet, shipping → Postage & Delivery, else → Office Supplies/
// Equipment); parking charges filed under Travel → Parking; "Other - Executive
// Wellness" → Other; uncategorized Peak 10 → Other. Rules are fixed too. Idempotent.

import { describe, it, expect, beforeEach } from 'vitest'
import { remapP10Categories } from '../electron/services/p10-category-cleanup'
import { makeDb, applyCoreSchema, applyRulesSchema, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

function addRule(db: CompatDb, id: string, p10_category: string): void {
  db.prepare(`
    INSERT INTO rules (id, rule_name, section, match_type, match_value, bucket,
      p10_category, action, priority_order, is_active)
    VALUES (?,?,'test','contains',?, 'Peak 10', ?, 'classify', 300, 1)
  `).run(id, id, id, p10_category)
}

function addTx(db: CompatDb, id: string, merchant: string, p10_category: string | null, bucket = 'Peak 10'): void {
  db.prepare(`
    INSERT INTO transactions (id, account_id, merchant_name, description_raw, amount,
      transaction_date, bucket, p10_category, rule_id, review_status)
    VALUES (?,?,?,?,?,'2025-12-15',?,?,'r','auto_classified')
  `).run(id, 'a', merchant, merchant, 50, bucket, p10_category)
}

describe('Peak 10 category cleanup (migration 019)', () => {
  let db: CompatDb
  beforeEach(async () => {
    db = await makeDb()
    applyCoreSchema(db); applyRulesSchema(db)
    insertAccount(db, 'a', '5829')
  })

  it('remaps every legacy category by merchant, and fixes the rules', () => {
    // Rules carrying the old values
    addRule(db, 'p10-015', 'Office Supplies & Expenses')  // Adobe → Computer/Internet
    addRule(db, 'p10-018', 'Office Supplies & Expenses')  // Anthropic → Computer/Internet
    addRule(db, 'p10-030', 'Office Supplies & Expenses')  // UPS → Postage & Delivery
    addRule(db, 'p10-028', 'Travel')                      // Parking → Parking
    addRule(db, 'p10-031', 'Travel')                      // ParkMobile → Parking
    addRule(db, 'p10-004', 'Other - Executive Wellness')  // P Fitness → Other

    // Transactions
    addTx(db, 't_anthropic', 'Anthropic Claude', 'Office Supplies & Expenses')
    addTx(db, 't_adobe', 'Adobe', 'Office Supplies & Expenses')
    addTx(db, 't_ups', 'UPS', 'Office Supplies & Expenses')
    addTx(db, 't_office', 'OfficeMax', 'Office Supplies & Expenses')   // catch-all rename
    addTx(db, 't_parking', '500 W 2nd Street Parking', 'Travel')
    addTx(db, 't_gas', 'Shell Oil', 'Travel')                          // stays Travel
    addTx(db, 't_fitness', 'P Fitness', 'Other - Executive Wellness')
    addTx(db, 't_none', 'Mystery Vendor', null)                        // uncategorized → Other
    addTx(db, 't_llc', 'Adobe', 'Office Supplies & Expenses', 'Moonsmoke LLC') // not Peak 10 → untouched

    const res = remapP10Categories(db)

    const cat = (id: string) =>
      (db.prepare('SELECT p10_category AS c FROM transactions WHERE id=?').get(id) as { c: string | null }).c
    expect(cat('t_anthropic')).toBe('Computer/Internet')
    expect(cat('t_adobe')).toBe('Computer/Internet')
    expect(cat('t_ups')).toBe('Postage & Delivery')
    expect(cat('t_office')).toBe('Office Supplies/Equipment')
    expect(cat('t_parking')).toBe('Parking')
    expect(cat('t_gas')).toBe('Travel')
    expect(cat('t_fitness')).toBe('Other')
    expect(cat('t_none')).toBe('Other')
    expect(cat('t_llc')).toBe('Office Supplies & Expenses')  // untouched (not Peak 10)

    const ruleCat = (id: string) =>
      (db.prepare('SELECT p10_category AS c FROM rules WHERE id=?').get(id) as { c: string }).c
    expect(ruleCat('p10-015')).toBe('Computer/Internet')
    expect(ruleCat('p10-018')).toBe('Computer/Internet')
    expect(ruleCat('p10-030')).toBe('Postage & Delivery')
    expect(ruleCat('p10-028')).toBe('Parking')
    expect(ruleCat('p10-031')).toBe('Parking')
    expect(ruleCat('p10-004')).toBe('Other')

    expect(res.txnsUpdated).toBe(7)   // 8 Peak 10 rows, but t_gas stays Travel
    expect(res.rulesUpdated).toBe(6)
  })

  it('is idempotent', () => {
    addRule(db, 'p10-015', 'Office Supplies & Expenses')
    addTx(db, 't_adobe', 'Adobe', 'Office Supplies & Expenses')
    expect(remapP10Categories(db).txnsUpdated).toBe(1)
    const second = remapP10Categories(db)
    expect(second.txnsUpdated).toBe(0)
    expect(second.rulesUpdated).toBe(0)
  })
})
