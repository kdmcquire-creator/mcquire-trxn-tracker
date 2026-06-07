// electron/services/recurring-repair.ts
//
// Self-healing repair for recurring charges (rent, subscriptions, utilities)
// that earlier, over-aggressive dedup logic incorrectly excluded.
//
// A charge is "recurring" when the same (merchant_name, amount) appears in 3+
// DISTINCT calendar months anywhere in the data. A one-off accidental double
// charge never meets this bar; monthly rent always does. This is independent of
// which code path did the excluding, so a single pass repairs Bilt, Gexa, etc.

import type { CompatDb } from './database'

/** Minimum distinct months for a (merchant, amount) to count as recurring. */
export const RECURRING_MONTHS = 3

/**
 * Restore any dedup-excluded transaction that is actually a recurring charge.
 * Sets bucket=NULL / review_status='pending_review' so the rules engine can
 * reclassify it. Returns the number of transactions restored.
 */
export function restoreRecurringExclusions(db: CompatDb): number {
  const restorable = db.prepare(`
    WITH recurring AS (
      SELECT merchant_name, amount
      FROM transactions
      WHERE merchant_name IS NOT NULL AND merchant_name != ''
      GROUP BY merchant_name, amount
      HAVING COUNT(DISTINCT substr(transaction_date, 1, 7)) >= ${RECURRING_MONTHS}
    )
    SELECT t.id
    FROM transactions t
    JOIN recurring r ON r.merchant_name = t.merchant_name AND r.amount = t.amount
    WHERE t.bucket = 'Exclude'
      AND (t.flag_reason LIKE '%uplicate%' OR t.flag_reason LIKE '%dedup%' OR t.flag_reason LIKE '%migration%')
  `).all() as Array<{ id: string }>

  if (restorable.length === 0) return 0

  const restore = db.prepare(`
    UPDATE transactions
    SET bucket = NULL, review_status = 'pending_review',
        flag_reason = 'Restored recurring charge', updated_at = datetime('now')
    WHERE id = ?
  `)
  db.transaction(() => { for (const r of restorable) restore.run(r.id) })()
  return restorable.length
}

export interface MerchantVerdict {
  merchant: string
  total: number
  months: number
  excluded: number
  firstDate: string | null
  lastDate: string | null
}

/**
 * Per-merchant coverage report. If a merchant you expect monthly shows only
 * 1-2 distinct months, those months were never imported (a data-source gap) —
 * not a dedup problem.
 */
export function recurringMerchantVerdict(db: CompatDb, names: string[]): MerchantVerdict[] {
  const out: MerchantVerdict[] = []
  for (const name of names) {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT substr(transaction_date,1,7)) AS months,
        SUM(CASE WHEN bucket='Exclude' THEN 1 ELSE 0 END) AS excluded,
        MIN(transaction_date) AS firstDate,
        MAX(transaction_date) AS lastDate
      FROM transactions WHERE LOWER(merchant_name) LIKE ?
    `).get(`%${name.toLowerCase()}%`) as any
    if (row && row.total > 0) {
      out.push({ merchant: name, total: row.total, months: row.months, excluded: row.excluded, firstDate: row.firstDate, lastDate: row.lastDate })
    }
  }
  return out
}
