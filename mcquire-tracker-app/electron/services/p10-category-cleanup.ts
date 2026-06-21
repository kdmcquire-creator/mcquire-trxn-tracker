// electron/services/p10-category-cleanup.ts
//
// 2026-06-21 — Align Peak 10 expense categories to the canonical "Account" list
// used by the Peak 10 expense-report template (the 20 values in P10_CATEGORIES).
//
// A handful of legacy p10_category values predate that list or were catch-alls:
//   • "Office Supplies & Expenses"  →  Computer/Internet          (software: Anthropic, Adobe)
//                                      Postage & Delivery         (shipping: UPS, Pak Mail)
//                                      Office Supplies/Equipment  (anything else — the rename)
//   • "Travel" on a parking merchant →  Parking
//   • "Other - Executive Wellness"  →  Other
//   • (uncategorized Peak 10 charge) →  Other
//
// This updates BOTH the seed rules that emit those values (so future imports are
// correct) and the already-bucketed transactions. Every statement is guarded by
// the OLD value in its WHERE clause, so once the data is canonical, re-runs no-op.

import type { CompatDb } from './database'

// Merchant predicates — checked against both the cleaned merchant_name and the
// raw description, lower-cased. Each is scoped by a category filter in the UPDATE,
// so e.g. the "ups" substring can't stray outside the office-supplies bucket.
const SOFTWARE =
  `(LOWER(COALESCE(merchant_name,'')) LIKE '%anthropic%' OR LOWER(COALESCE(merchant_name,'')) LIKE '%adobe%'` +
  ` OR LOWER(COALESCE(description_raw,'')) LIKE '%anthropic%' OR LOWER(COALESCE(description_raw,'')) LIKE '%adobe%')`
const SHIPPING =
  `(LOWER(COALESCE(merchant_name,'')) LIKE '%ups%' OR LOWER(COALESCE(merchant_name,'')) LIKE '%pak mail%'` +
  ` OR LOWER(COALESCE(description_raw,'')) LIKE '%pak mail%')`
const PARKING =
  `(LOWER(COALESCE(merchant_name,'')) LIKE '%parking%' OR LOWER(COALESCE(merchant_name,'')) LIKE '%parkmobile%'` +
  ` OR LOWER(COALESCE(merchant_name,'')) LIKE '%garage%' OR LOWER(COALESCE(description_raw,'')) LIKE '%parking%'` +
  ` OR LOWER(COALESCE(description_raw,'')) LIKE '%parkmobile%')`

export interface CategoryCleanupResult {
  rulesUpdated: number
  txnsUpdated: number
  byTarget: Record<string, number>
}

export function remapP10Categories(db: CompatDb): CategoryCleanupResult {
  const result: CategoryCleanupResult = { rulesUpdated: 0, txnsUpdated: 0, byTarget: {} }

  const count = (table: string, where: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n

  // Rule fixes — keyed by id, guarded by the old value (precise + idempotent).
  const ruleSteps: Array<{ where: string; target: string }> = [
    { where: `id IN ('p10-015','p10-018') AND p10_category='Office Supplies & Expenses'`, target: 'Computer/Internet' },
    { where: `id = 'p10-030' AND p10_category='Office Supplies & Expenses'`, target: 'Postage & Delivery' },
    { where: `id IN ('p10-028','p10-029','p10-031') AND p10_category='Travel'`, target: 'Parking' },
    { where: `id IN ('p10-004','p10-005') AND p10_category='Other - Executive Wellness'`, target: 'Other' },
  ]

  // Transaction remap — ORDER MATTERS: the software & shipping carve-outs run
  // before the catch-all rename, so they aren't swept into Office Supplies/Equipment.
  const txnSteps: Array<{ where: string; target: string; label: string }> = [
    { where: `bucket='Peak 10' AND p10_category='Office Supplies & Expenses' AND ${SOFTWARE}`, target: 'Computer/Internet', label: 'Computer/Internet (software)' },
    { where: `bucket='Peak 10' AND p10_category='Office Supplies & Expenses' AND ${SHIPPING}`, target: 'Postage & Delivery', label: 'Postage & Delivery (shipping)' },
    { where: `bucket='Peak 10' AND p10_category='Office Supplies & Expenses'`, target: 'Office Supplies/Equipment', label: 'Office Supplies/Equipment' },
    { where: `bucket='Peak 10' AND p10_category='Travel' AND ${PARKING}`, target: 'Parking', label: 'Parking' },
    { where: `bucket='Peak 10' AND p10_category='Other - Executive Wellness'`, target: 'Other', label: 'Other (wellness)' },
    { where: `bucket='Peak 10' AND COALESCE(p10_category,'')='' AND NOT EXISTS (SELECT 1 FROM transactions s WHERE s.split_parent_id = transactions.id)`, target: 'Other', label: 'Other (uncategorized)' },
  ]

  db.transaction(() => {
    for (const step of ruleSteps) {
      const n = count('rules', step.where)
      if (n > 0) {
        db.prepare(`UPDATE rules SET p10_category=?, updated_at=datetime('now') WHERE ${step.where}`).run(step.target)
        result.rulesUpdated += n
      }
    }
    for (const step of txnSteps) {
      const n = count('transactions', step.where)
      if (n > 0) {
        db.prepare(`UPDATE transactions SET p10_category=?, updated_at=datetime('now') WHERE ${step.where}`).run(step.target)
        result.txnsUpdated += n
        result.byTarget[step.label] = (result.byTarget[step.label] ?? 0) + n
      }
    }
  })()

  return result
}
