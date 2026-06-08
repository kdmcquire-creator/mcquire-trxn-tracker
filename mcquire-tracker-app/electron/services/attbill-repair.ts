// electron/services/attbill-repair.ts
//
// AT&T wireless-bill repair (migration 016).
//
// The AT&T wireless account (mask 5829) posts as "ATT* BILL PAYMENT", which
// normalizes to "att bill payment" — it contains neither "at&t" nor a clean
// merchant token. The seeded AT&T rules (llc-011 / p10-024 / p10-025) all use
// match_type='exact' on 'at&t', so they never matched the real bill, and the
// charge fell through to the broad 'payment' exclude (excl-004). Result: every
// month of the AT&T wireless bill was excluded from the ledger.
//
// The seed now carries three contains:'att bill' rules (mask 5829), banded by
// amount to mirror Kyle's existing intent:
//   < $100      → Moonsmoke LLC  (business supplemental line)
//   $100–299.99 → Peak 10        (work line)
//   ≥ $300      → split_flag     (combined bill — Review Queue for the
//                                 832-687-0468 business/personal split)
// "att bill" was chosen because it matches all 20 real rows with ZERO false
// positives (plain 'att' also hits Hyatt Place / tattoo / "Little Matt's").
//
// This module reclassifies the rows that were already excluded, using the real
// engine, now that those rules exist. Only auto_classified rows are touched.

import type { CompatDb } from './database'
import { classifyTransaction, loadActiveRules } from './classification-engine'

export interface AttBillRepairResult { toLLC: number; toP10: number; toReview: number }

export function reclassifyExcludedAttBills(db: CompatDb): AttBillRepairResult {
  const affected = db.prepare(`
    SELECT t.id, t.description_raw, t.amount, t.transaction_date, t.category_source, a.account_mask
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.bucket = 'Exclude' AND t.review_status = 'auto_classified'
      AND LOWER(t.description_raw) LIKE '%att%bill%'
  `).all() as Array<{
    id: string; description_raw: string; amount: number;
    transaction_date: string; category_source: string | null; account_mask: string
  }>

  const result: AttBillRepairResult = { toLLC: 0, toP10: 0, toReview: 0 }
  if (affected.length === 0) return result

  const rules = loadActiveRules(db)
  const update = db.prepare(`
    UPDATE transactions SET bucket=?, p10_category=?, llc_category=?, description_notes=?,
      rule_id=?, review_status=?, flag_reason=?, updated_at=datetime('now') WHERE id=?
  `)

  db.transaction(() => {
    for (const tx of affected) {
      const r = classifyTransaction({
        description_raw: tx.description_raw,
        amount: tx.amount,
        transaction_date: tx.transaction_date,
        account_mask: tx.account_mask,
        category_source: tx.category_source ?? undefined,
      }, rules, db)
      // Only rewrite rows that now resolve to a real AT&T rule (not the fallback exclude).
      if (r.rule_id !== 'excl-004') {
        update.run(r.bucket, r.p10_category, r.llc_category, r.description_notes,
          r.rule_id, r.review_status, r.flag_reason, tx.id)
        if (r.bucket === 'Moonsmoke LLC') result.toLLC++
        else if (r.bucket === 'Peak 10') result.toP10++
        if (r.review_status === 'pending_review') result.toReview++
      }
    }
  })()

  return result
}
