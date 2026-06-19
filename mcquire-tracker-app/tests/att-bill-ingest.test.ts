// tests/att-bill-ingest.test.ts
// End-to-end (against an in-memory DB): a parsed bill stores, matches the autopay
// charge, splits it (0468→Peak 10, rest→Personal), excludes the double-post, and
// holds pending until the charge posts.

import { describe, it, expect, beforeEach } from 'vitest'
import { ingestParsedBill, rematchPendingAttBills, listAttBills } from '../electron/services/att-bill-ingest'
import { makeDb, applyCoreSchema, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'
import type { ParsedAttBill } from '../electron/services/att-bill-parser'

const bill: ParsedAttBill = {
  accountNumber: '287301218152', issueDate: '2026-04-27', autopayDate: '2026-05-20',
  billTotal: 488.73, line0468Amount: 91.77,
}

function attBillsTable(db: CompatDb): void {
  db.prepare("CREATE TABLE att_bills (id TEXT PRIMARY KEY, account_number TEXT, issue_date TEXT, " +
    "autopay_date TEXT, bill_total REAL, line_0468 REAL, source_file TEXT, status TEXT DEFAULT 'pending', " +
    "matched_txn_id TEXT, created_at TEXT, updated_at TEXT, UNIQUE(account_number, issue_date))").run()
}
function addCharge(db: CompatDb, id: string, amount: number, date: string): void {
  db.prepare("INSERT INTO transactions (id, account_id, transaction_date, description_raw, merchant_name, " +
    "amount, bucket, review_status) VALUES (?, 'a', ?, 'ATT* BILL PAYMENT', 'AT&T', ?, NULL, 'auto_classified')")
    .run(id, date, amount)
}

describe('AT&T bill ingest', () => {
  let db: CompatDb
  beforeEach(async () => { db = await makeDb(); applyCoreSchema(db); attBillsTable(db); insertAccount(db, 'a', '5829') })

  it('splits the matching charge on import and excludes the double-post', () => {
    addCharge(db, 'c1', 488.73, '2026-05-20')
    addCharge(db, 'c2', 488.73, '2026-05-22')   // double-posted autopay
    expect(ingestParsedBill(db, bill, 'Apr.pdf').outcome).toBe('split')

    const kids = db.prepare("SELECT bucket, p10_category, amount FROM transactions WHERE split_parent_id='c1' ORDER BY amount DESC").all() as any[]
    expect(kids).toHaveLength(2)
    expect(kids[0]).toMatchObject({ bucket: 'Personal', amount: 396.96 })
    expect(kids[1]).toMatchObject({ bucket: 'Peak 10', p10_category: 'Telephone & Communication', amount: 91.77 })
    expect((db.prepare("SELECT bucket FROM transactions WHERE id='c2'").get() as any).bucket).toBe('Exclude')
    expect(listAttBills(db)[0]).toMatchObject({ status: 'split', matched_txn_id: 'c1' })
  })

  it('holds pending until the charge posts, then auto-splits on rematch', () => {
    expect(ingestParsedBill(db, bill, 'Apr.pdf').outcome).toBe('pending')
    addCharge(db, 'c1', 488.73, '2026-05-20')   // charge arrives weeks later
    expect(rematchPendingAttBills(db).applied).toBe(1)
    expect(db.prepare("SELECT bucket FROM transactions WHERE split_parent_id='c1'").all()).toHaveLength(2)
    expect(listAttBills(db)[0].status).toBe('split')
  })

  it('dedups a re-uploaded bill (same account+month)', () => {
    ingestParsedBill(db, bill, 'Apr.pdf')
    expect(ingestParsedBill(db, bill, 'Apr-copy.pdf').outcome).toBe('duplicate-upload')
    expect(listAttBills(db)).toHaveLength(1)
  })
})
