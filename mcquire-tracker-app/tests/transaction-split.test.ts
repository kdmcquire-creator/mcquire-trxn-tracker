// tests/transaction-split.test.ts
// Regression test for the split crash: a fragment routed to Peak 10 / Moonsmoke
// LLC used to bind `undefined` (handler read the wrong field name) and throw
// "tried to bind a value of an unknown type (undefined)". These prove the split
// now succeeds AND saves the per-fragment category + notes.

import { describe, it, expect, beforeEach } from 'vitest'
import { splitTransaction } from '../electron/services/transaction-split'
import { makeDb, applyCoreSchema, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

function addParent(db: CompatDb, id: string, amount: number, flag: string | null): void {
  db.prepare(`
    INSERT INTO transactions (id, account_id, transaction_date, description_raw, merchant_name,
      amount, bucket, review_status, flag_reason, is_split_child)
    VALUES (?, 'a', '2026-01-12', 'ATT* BILL PAYMENT', 'AT&T', ?, NULL, 'pending_review', ?, 0)
  `).run(id, amount, flag)
}

describe('transaction split (transactions:split)', () => {
  let db: CompatDb
  beforeEach(async () => {
    db = await makeDb(); applyCoreSchema(db); insertAccount(db, 'a', '5829')
  })

  it('splits an AT&T bill into a Peak 10 business line + Personal, saving the category', () => {
    addParent(db, 'att1', 463.53, 'AT&T split required')
    const res = splitTransaction(db, 'att1', [
      { bucket: 'Peak 10', amount: 200.0, p10_category: 'Telephone & Communication' },
      { bucket: 'Personal', amount: 263.53, description_notes: 'personal lines' },
    ])
    expect(res).toMatchObject({ success: true, created: 2 })

    const kids = db.prepare(
      "SELECT bucket, p10_category, description_notes, amount, is_split_child, split_parent_id FROM transactions WHERE split_parent_id='att1' ORDER BY amount DESC"
    ).all() as any[]
    expect(kids).toHaveLength(2)
    expect(kids[0]).toMatchObject({ bucket: 'Personal', amount: 263.53, is_split_child: 1, split_parent_id: 'att1', description_notes: 'personal lines' })
    expect(kids[1]).toMatchObject({ bucket: 'Peak 10', p10_category: 'Telephone & Communication', amount: 200.0, is_split_child: 1 })

    const parent = db.prepare("SELECT review_status, is_split_child FROM transactions WHERE id='att1'").get() as any
    expect(parent).toMatchObject({ review_status: 'manually_classified', is_split_child: 0 })
  })

  it('does not crash when a business fragment has no category (binds null, not undefined)', () => {
    addParent(db, 'att2', 300, null)
    const res = splitTransaction(db, 'att2', [
      { bucket: 'Peak 10', amount: 150, p10_category: undefined },  // the exact crash case
      { bucket: 'Moonsmoke LLC', amount: 150 },                     // llc_category absent entirely
    ])
    expect(res.success).toBe(true)
    const kids = db.prepare("SELECT p10_category, llc_category FROM transactions WHERE split_parent_id='att2'").all() as any[]
    expect(kids).toHaveLength(2)
    expect(kids.every(k => k.p10_category === null || k.llc_category === null)).toBe(true)
  })

  it('rejects a split with fewer than 2 valid fragments', () => {
    addParent(db, 'att3', 100, null)
    expect(splitTransaction(db, 'att3', [{ bucket: 'Peak 10', amount: 100 }]).success).toBe(false)
    // a fragment with a non-numeric amount is dropped → still < 2
    expect(splitTransaction(db, 'att3', [
      { bucket: 'Peak 10', amount: 100 },
      { bucket: 'Personal', amount: NaN as unknown as number },
    ]).success).toBe(false)
  })
})
