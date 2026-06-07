// electron/services/dedup.ts
//
// Single source of truth for cross-account duplicate detection.
//
// The problem this solves: when two linked cards (e.g. ···9007 and ···2419)
// both surface the same charge — often with the pending date on one and the
// posted date on the other, 1-2 days apart — the app would otherwise store
// both and double-count.
//
// The critical nuance: RECURRING charges (rent, subscriptions, utilities) are
// the same merchant + same amount every month. Those must NOT be treated as
// duplicates just because two of them happen to fall within the date window or
// appear on two cards. The recurring guard below prevents that.
//
// This module is pure (only needs a CompatDb) so it is fully unit-testable and
// is shared by the Plaid import path, the CSV import path, and the data-repair
// migrations.

import type { CompatDb } from './database'

/** Number of days of tolerance between the two charges (pending vs posted). */
export const DEDUP_DATE_WINDOW_DAYS = 2

/**
 * If a merchant+amount appears at least this many times on the OTHER account,
 * it is treated as a recurring charge (rent, subscription) and never deduped.
 */
export const RECURRING_THRESHOLD = 3

export interface DedupCandidate {
  merchantNorm: string
  amount: number
  date: string
  accountId: string
}

/**
 * Returns true if `candidate` is a cross-account duplicate of an existing,
 * non-excluded transaction on a DIFFERENT account, within the date window —
 * UNLESS the merchant+amount is a recurring charge on that other account.
 */
export function isCrossAccountDuplicate(db: CompatDb, candidate: DedupCandidate): boolean {
  const { merchantNorm, amount, date, accountId } = candidate

  if (!merchantNorm) return false

  // Recurring guard: if this exact merchant+amount shows up 3+ times on other
  // accounts, it is a recurring charge (e.g. monthly rent) — not a duplicate.
  const recurring = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions t
       WHERE t.account_id != ?
         AND t.merchant_name = ?
         AND t.amount = ?
         AND (t.bucket IS NULL OR t.bucket != 'Exclude')`
    )
    .get(accountId, merchantNorm, amount) as { n: number }
  if (recurring.n >= RECURRING_THRESHOLD) return false

  // Otherwise: a single match within the date window on another account is a dupe.
  const match = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions t
       WHERE t.account_id != ?
         AND t.merchant_name = ?
         AND t.amount = ?
         AND ABS(julianday(t.transaction_date) - julianday(?)) <= ${DEDUP_DATE_WINDOW_DAYS}
         AND (t.bucket IS NULL OR t.bucket != 'Exclude')`
    )
    .get(accountId, merchantNorm, amount, date) as { n: number }

  return match.n >= 1
}
