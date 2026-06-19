// electron/services/att-extra-repair.ts
//
// Migration 017 — the remaining AT&T charges that aren't the wireless "bill":
//   • AT&T MOBILITY EPAY  — the same wireless account paid a different way, so it
//     is banded exactly like the bill (<$100 → LLC, $100-299 → Peak 10,
//     ≥$300 → split_flag / Review Queue for the 832-687-0468 split).
//   • ATT BUSINESS UVERSE — Peak 10 (Kyle's call).
//   • UVERSE CONS SW EVR  — Moonsmoke LLC (Kyle's call).
//
// The seed now carries rules for these. This reclassifies the rows that were
// mis-bucketed (mostly default → Personal). It deliberately skips rows already
// in `Exclude`: a MOBILITY EPAY that duplicates a bill payment (e.g. the 3-20
// $469.39 that mirrors the 3-22 bill) was correctly excluded by dedup and must
// stay excluded — un-excluding it would double-count.

import type { CompatDb } from './database'
import { classifyTransaction, loadActiveRules } from './classification-engine'

export interface AttExtraResult { reclassified: number }

export function reclassifyAttExtras(db: CompatDb): AttExtraResult {
  const affected = db.prepare(`
    SELECT t.id, t.description_raw, t.amount, t.transaction_date, t.category_source, a.account_mask,
           t.rule_id AS cur_rule
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.review_status = 'auto_classified'
      AND (t.bucket IS NULL OR t.bucket != 'Exclude')
      AND (LOWER(t.description_raw) LIKE '%at&t mobility%'
        OR LOWER(t.description_raw) LIKE '%business uverse%'
        OR LOWER(t.description_raw) LIKE '%uverse cons%')
  `).all() as Array<{
    id: string; description_raw: string; amount: number;
    transaction_date: string; category_source: string | null; account_mask: string; cur_rule: string | null
  }>

  if (affected.length === 0) return { reclassified: 0 }

  const rules = loadActiveRules(db)
  const update = db.prepare(`
    UPDATE transactions SET bucket=?, p10_category=?, llc_category=?, description_notes=?,
      rule_id=?, review_status=?, flag_reason=?, updated_at=datetime('now') WHERE id=?
  `)

  let reclassified = 0
  db.transaction(() => {
    for (const tx of affected) {
      const r = classifyTransaction({
        description_raw: tx.description_raw,
        amount: tx.amount,
        transaction_date: tx.transaction_date,
        account_mask: tx.account_mask,
        category_source: tx.category_source ?? undefined,
      }, rules, db)
      // Only rewrite rows that now match a real AT&T rule (not the Personal default)
      // AND actually change — so re-running is a no-op (idempotent).
      if (r.rule_id && r.rule_id !== 'default-001' && r.rule_id !== tx.cur_rule) {
        update.run(r.bucket, r.p10_category, r.llc_category, r.description_notes,
          r.rule_id, r.review_status, r.flag_reason, tx.id)
        reclassified++
      }
    }
  })()

  return { reclassified }
}
