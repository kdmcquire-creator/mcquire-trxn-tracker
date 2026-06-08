// electron/services/payment-exclude-repair.ts
//
// Repair for the over-broad "Payment Category Exclude" rule (excl-004,
// match=contains:'payment'). It was seeded at priority 103 — BEFORE the vendor
// rules — so any vendor charge whose bank text contains the word "payment" was
// excluded instead of classified. The textbook case is Bilt rent, which posts as
// "ORIG CO NAME:BILT PAYMENT … BILTRENT": the word "payment" tripped excl-004
// before the Bilt rule (llc-002) could classify it as Moonsmoke LLC rent. Months
// that posted as plain "BILT RENT" classified correctly, so the ledger silently
// lost ~half of Bilt rent.
//
// The fix is purely about rule ORDER, not matching: move excl-004 to run after
// the vendor rules (but before the default catch-all), then re-classify the rows
// it wrongly excluded using the real engine. A row that now matches a real vendor
// rule (Bilt → llc-002) is reclassified; a genuine card payment (no vendor rule)
// still lands on excl-004 and stays excluded. We only ever touch auto_classified
// rows that excl-004 itself produced — never a manual decision.

import type { CompatDb } from './database'
import { classifyTransaction, loadActiveRules } from './classification-engine'

/** Highest seed classify/split/ask priority is 808; the default catch-all is 9000.
 *  8999 puts the broad payment-exclude last — after every specific rule, just
 *  before the default — so it still catches genuine card payments. */
export const PAYMENT_EXCLUDE_PRIORITY = 8999
export const PAYMENT_EXCLUDE_RULE_ID = 'excl-004'

export function reprioritizePaymentExclude(db: CompatDb): { moved: number } {
  // 1. Demote the broad payment-exclude rule below the vendor rules.
  db.prepare(`UPDATE rules SET priority_order = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(PAYMENT_EXCLUDE_PRIORITY, PAYMENT_EXCLUDE_RULE_ID)

  // 2. Find the rows excl-004 auto-excluded (never manual decisions).
  const affected = db.prepare(`
    SELECT t.id, t.description_raw, t.amount, t.transaction_date, t.category_source, a.account_mask
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.rule_id = ? AND t.bucket = 'Exclude' AND t.review_status = 'auto_classified'
  `).all(PAYMENT_EXCLUDE_RULE_ID) as Array<{
    id: string; description_raw: string; amount: number;
    transaction_date: string; category_source: string | null; account_mask: string
  }>

  if (affected.length === 0) return { moved: 0 }

  // 3. Re-run the real engine with the corrected order and rewrite only the rows
  //    that now resolve to a different (real vendor) rule.
  const rules = loadActiveRules(db)
  const update = db.prepare(`
    UPDATE transactions SET bucket=?, p10_category=?, llc_category=?, description_notes=?,
      rule_id=?, review_status=?, flag_reason=?, updated_at=datetime('now') WHERE id=?
  `)

  let moved = 0
  db.transaction(() => {
    for (const tx of affected) {
      const r = classifyTransaction({
        description_raw: tx.description_raw,
        amount: tx.amount,
        transaction_date: tx.transaction_date,
        account_mask: tx.account_mask,
        category_source: tx.category_source ?? undefined,
      }, rules, db)
      if (r.rule_id !== PAYMENT_EXCLUDE_RULE_ID) {
        update.run(r.bucket, r.p10_category, r.llc_category, r.description_notes,
          r.rule_id, r.review_status, r.flag_reason, tx.id)
        moved++
      }
    }
  })()

  return { moved }
}
