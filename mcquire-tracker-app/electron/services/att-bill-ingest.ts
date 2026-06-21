// electron/services/att-bill-ingest.ts
//
// Orchestrates the AT&T bill auto-split: store a parsed bill (deduped per
// account+month), match it to the card charges, and apply the result — split the
// autopay charge (0468 → Peak 10 / Telephone & Communication, rest → Personal)
// and Exclude any double-posted twin. Re-checks pending bills whenever new
// transactions arrive. The PDF→ParsedAttBill step happens in the IPC layer; this
// works on ParsedAttBill so it's testable against an in-memory DB.

import type { CompatDb } from './database'
import type { ParsedAttBill } from './att-bill-parser'
import { matchBillToCharge, type ChargeCandidate } from './att-bill-matcher'
import { splitTransaction } from './transaction-split'

const P10_TELECOM = 'Telephone & Communication'
const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

export interface AttBillRow {
  id: string; account_number: string; issue_date: string; autopay_date: string | null
  bill_total: number; line_0468: number; status: string; matched_txn_id: string | null; source_file: string | null
}
export interface IngestResult { bill: AttBillRow; outcome: 'split' | 'pending' | 'review' | 'duplicate-upload' }

/** AT&T autopay-looking, untouched charges the matcher can consider. */
function attChargeCandidates(db: CompatDb): ChargeCandidate[] {
  return db.prepare(`
    SELECT id, ABS(amount) AS amount, transaction_date AS date, bucket, review_status
    FROM transactions
    WHERE review_status != 'manually_classified'
      AND (bucket IS NULL OR bucket != 'Exclude')
      AND is_split_child = 0
      AND (LOWER(description_raw) LIKE '%at&t%' OR LOWER(description_raw) LIKE '%att %'
        OR LOWER(description_raw) LIKE '%att*%' OR LOWER(description_raw) LIKE '%mobility%'
        OR LOWER(merchant_name) LIKE '%at&t%')
  `).all() as ChargeCandidate[]
}

const getBill = (db: CompatDb, id: string): AttBillRow =>
  db.prepare('SELECT * FROM att_bills WHERE id = ?').get(id) as AttBillRow

/** Apply a confident match: exclude duplicates, split the target, mark the bill. */
function applySplit(db: CompatDb, billId: string, targetId: string, line0468: number, remainder: number, duplicateIds: string[]): void {
  const excl = db.prepare(`UPDATE transactions SET bucket='Exclude', review_status='manually_classified',
      flag_reason=?, updated_at=datetime('now') WHERE id=?`)
  db.transaction(() => {
    for (const dupId of duplicateIds) excl.run(`Duplicate of ${targetId} — AT&T autopay`, dupId)
    splitTransaction(db, targetId, [
      { bucket: 'Peak 10', amount: line0468, p10_category: P10_TELECOM },
      { bucket: 'Personal', amount: remainder },
    ])
    db.prepare(`UPDATE att_bills SET status='split', matched_txn_id=?, updated_at=datetime('now') WHERE id=?`).run(targetId, billId)
  })()
}

function toParsed(bill: AttBillRow): ParsedAttBill {
  return {
    accountNumber: bill.account_number, issueDate: bill.issue_date,
    autopayDate: bill.autopay_date ?? bill.issue_date, billTotal: bill.bill_total, line0468Amount: bill.line_0468,
  }
}

function tryMatchAndApply(db: CompatDb, bill: AttBillRow): 'split' | 'pending' | 'review' {
  const m = matchBillToCharge(toParsed(bill), attChargeCandidates(db))
  if (m.action === 'split') { applySplit(db, bill.id, m.targetId, m.line0468, m.remainder, m.duplicateIds); return 'split' }
  const next = m.action === 'review' ? 'review' : 'pending'
  if (bill.status !== next) db.prepare(`UPDATE att_bills SET status=?, updated_at=datetime('now') WHERE id=?`).run(next, bill.id)
  return next
}

/** Store a freshly-parsed bill (deduped per account+month) and try to apply it. */
export function ingestParsedBill(db: CompatDb, parsed: ParsedAttBill, sourceFile: string): IngestResult {
  const existing = db.prepare('SELECT * FROM att_bills WHERE account_number=? AND issue_date=?')
    .get(parsed.accountNumber, parsed.issueDate) as AttBillRow | undefined
  if (existing) return { bill: existing, outcome: 'duplicate-upload' }

  const { v4: uuidv4 } = require('uuid')
  const id = uuidv4()
  db.prepare(`INSERT INTO att_bills (id, account_number, issue_date, autopay_date, bill_total, line_0468, source_file, status)
    VALUES (?,?,?,?,?,?,?, 'pending')`).run(
    id, parsed.accountNumber, parsed.issueDate, parsed.autopayDate, parsed.billTotal, parsed.line0468Amount, sourceFile)
  const outcome = tryMatchAndApply(db, getBill(db, id))
  return { bill: getBill(db, id), outcome }
}

/** Re-check every still-pending bill against current charges. Call after each import/sync. */
export function rematchPendingAttBills(db: CompatDb): { applied: number } {
  const pending = db.prepare("SELECT * FROM att_bills WHERE status='pending'").all() as AttBillRow[]
  let applied = 0
  for (const bill of pending) if (tryMatchAndApply(db, bill) === 'split') applied++
  return { applied }
}

/** Candidate charges for a bill that needs review (so the user can pick one). */
export function attBillReviewCandidates(db: CompatDb, billId: string): Array<{ id: string; amount: number; date: string; description: string }> {
  const bill = getBill(db, billId)
  if (!bill) return []
  const cands = attChargeCandidates(db).filter(c => Math.abs(c.amount - bill.bill_total) < 0.005)
  return cands.map(c => {
    const row = db.prepare('SELECT description_raw FROM transactions WHERE id=?').get(c.id) as { description_raw: string }
    return { id: c.id, amount: c.amount, date: c.date, description: row?.description_raw ?? '' }
  })
}

/** Apply a user-confirmed match (from the review state). */
export function confirmAttBillMatch(db: CompatDb, billId: string, chargeId: string): { ok: boolean; error?: string } {
  const bill = getBill(db, billId)
  if (!bill) return { ok: false, error: 'Bill not found' }
  const charge = db.prepare('SELECT id FROM transactions WHERE id=?').get(chargeId)
  if (!charge) return { ok: false, error: 'Charge not found' }
  applySplit(db, billId, chargeId, bill.line_0468, r2(bill.bill_total - bill.line_0468), [])
  return { ok: true }
}

export const listAttBills = (db: CompatDb): AttBillRow[] =>
  db.prepare('SELECT * FROM att_bills ORDER BY issue_date DESC').all() as AttBillRow[]
