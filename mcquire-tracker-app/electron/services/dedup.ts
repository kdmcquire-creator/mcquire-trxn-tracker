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

// ── Statement re-import dedup (same account, fuzzy) ──────────────────────────
//
// The checks above can't catch a PDF statement re-imported into the SAME account
// that already holds those charges (from CSV/Plaid) with differently-formatted
// descriptions: the source hash differs and isCrossAccountDuplicate only looks at
// OTHER accounts. So match each parsed row to at most one existing same-account
// row by exact amount + near date + a shared significant description token.

const STMT_NOISE = new Set([
  'pos', 'debit', 'credit', 'ach', 'withdrawal', 'deposit', 'dep', 'payment', 'pmt',
  'transfer', 'xfer', 'card', 'purchase', 'visa', 'direct', 'online', 'funds', 'usaa',
  'iod', 'the', 'and', 'for', 'from', 'www', 'com', 'llc', 'inc',
])

/** Significant lowercase tokens of a bank description: drops transaction-type
 *  noise, pure numbers (refs/dates/masks), and short tokens. */
export function statementTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of (text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)) {
    if (t.length < 3 || /^\d+$/.test(t) || STMT_NOISE.has(t)) continue
    out.add(t)
  }
  return out
}

export interface StatementRow { amount: number; transaction_date: string; description_raw: string }
export interface ExistingRow { id: string; amount: number; transaction_date: string; text: string }

const daysApart = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000)

/** For each parsed statement row, true if it duplicates an EXISTING same-account
 *  row — claiming each existing row at most once, so two genuinely-identical
 *  charges (e.g. two $150 payments the same day) still both import. Order-preserving. */
export function matchStatementDuplicates(
  parsed: StatementRow[],
  existing: ExistingRow[],
  windowDays = DEDUP_DATE_WINDOW_DAYS
): boolean[] {
  const claimed = new Set<string>()
  const exTokens = existing.map(e => statementTokens(e.text))
  return parsed.map(p => {
    const pTok = statementTokens(p.description_raw)
    for (let i = 0; i < existing.length; i++) {
      const e = existing[i]
      if (claimed.has(e.id) || e.amount !== p.amount) continue
      if (daysApart(e.transaction_date, p.transaction_date) > windowDays) continue
      let shared = false
      for (const t of pTok) if (exTokens[i].has(t)) { shared = true; break }
      if (!shared) continue
      claimed.add(e.id)
      return true
    }
    return false
  })
}
