// electron/services/gas-personal-repair.ts
//
// 2026-06-21 — Gas-station fill-ups of $25 or less are personal, not reimbursable
// Peak 10 travel. The seed rules pers-001..008 (priority 250s, which run BEFORE
// the P10 gas rules at 331+) route NEW small gas charges to Personal; a charge
// over $25 falls through to the existing P10 gas rule and stays Peak 10 travel.
// This repair moves the EXISTING Peak 10 gas charges ≤ $25 to Personal.
//
// Idempotent: once a row is Personal the `bucket='Peak 10'` filter skips it.
// Manual classifications are never touched.

import type { CompatDb } from './database'

export const GAS_THRESHOLD = 25

/** Gas merchants + their Personal-rule ids/priorities. Used by both the seed
 *  (schema.ts) and this repair, so the two stay in lock-step. */
export const GAS_PERSONAL_RULES: ReadonlyArray<{ id: string; match: string; priority: number; name: string }> = [
  { id: 'pers-001', match: 'shell',           priority: 250, name: 'Shell gas ≤$25 → Personal' },
  { id: 'pers-002', match: 'exxon',           priority: 251, name: 'ExxonMobil gas ≤$25 → Personal' },
  { id: 'pers-003', match: 'buc-ee',          priority: 252, name: 'Buc-ees gas ≤$25 → Personal' },
  { id: 'pers-004', match: '7-eleven',        priority: 253, name: '7-Eleven gas ≤$25 → Personal' },
  { id: 'pers-005', match: 'chevron',         priority: 254, name: 'Chevron gas ≤$25 → Personal' },
  { id: 'pers-006', match: 'valero',          priority: 255, name: 'Valero gas ≤$25 → Personal' },
  { id: 'pers-007', match: 'snappys',         priority: 256, name: 'Snappys gas ≤$25 → Personal' },
  { id: 'pers-008', match: 'wildcat express', priority: 257, name: 'Wildcat Express gas ≤$25 → Personal' },
]

export function reclassifyGasUnder25(db: CompatDb): { moved: number; byMerchant: Record<string, number> } {
  const result = { moved: 0, byMerchant: {} as Record<string, number> }
  db.transaction(() => {
    for (const g of GAS_PERSONAL_RULES) {
      const where =
        `bucket='Peak 10' AND ABS(amount) <= ${GAS_THRESHOLD}` +
        ` AND COALESCE(review_status,'') != 'manually_classified'` +
        ` AND (LOWER(COALESCE(merchant_name,'')) LIKE '%${g.match}%' OR LOWER(COALESCE(description_raw,'')) LIKE '%${g.match}%')` +
        ` AND NOT EXISTS (SELECT 1 FROM transactions s WHERE s.split_parent_id = transactions.id)`
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`).get() as { n: number }).n
      if (n > 0) {
        db.prepare(
          `UPDATE transactions SET bucket='Personal', p10_category=NULL, llc_category=NULL,` +
          ` rule_id=?, review_status='auto_classified', updated_at=datetime('now') WHERE ${where}`
        ).run(g.id)
        result.moved += n
        result.byMerchant[g.match] = n
      }
    }
  })()
  return result
}
