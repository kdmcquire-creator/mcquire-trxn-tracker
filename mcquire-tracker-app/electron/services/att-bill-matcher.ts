// electron/services/att-bill-matcher.ts
//
// Decide how a parsed AT&T bill maps onto the card / ACH charges. Pure + tested.
// `charges` must already be filtered to AT&T-looking, untouched charges (the
// caller does the merchant SQL filter). Rules locked with Kyle:
//   • confident = AT&T charge, amount == bill total TO THE CENT, dated within
//     [issue date, issue date + 55 days];
//   • duplicate collapse = candidates of the same amount within 4 days of the
//     earliest are double-posts → keep the earliest, exclude the rest;
//   • exactly one after dedup → split; none → pending; 2+ distinct → review.
//
// Option C (2026-09-19): AT&T wireless autopay now drafts from checking as ACH
// "ATT PAYMENT", and a bill can be paid in MORE THAN ONE draft (e.g. a device-
// upgrade month split into two). When no single charge equals the bill total, look
// for a UNIQUE combination of 2–3 AT&T drafts in the window that sums to the total
// to the cent, and split the business line (0468) out of the largest draft (the
// "carrier") with the other drafts booked entirely to Personal. Anything ambiguous
// (no combo, or 2+ different combos) stays pending — never a silent wrong split.

import type { ParsedAttBill } from './att-bill-parser'

export interface ChargeCandidate {
  id: string
  amount: number        // absolute dollars
  date: string          // ISO yyyy-mm-dd
  bucket: string | null
  review_status: string
}

export type BillMatch =
  | { action: 'split'; targetId: string; line0468: number; remainder: number; duplicateIds: string[] }
  | { action: 'split-combo'; carrierId: string; line0468: number; personalFromCarrier: number; personalIds: string[] }
  | { action: 'pending' }
  | { action: 'review'; candidateIds: string[] }

const DAY = 86_400_000
const t = (iso: string): number => new Date(iso + 'T12:00:00').getTime()
const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const CENT = 0.005

export const WINDOW_DAYS = 55
export const DUP_DAYS = 4
export const COMBO_MAX = 3   // most drafts we'll sum for one bill

/** Collapse double-posts: same amount within DUP_DAYS → keep the earliest. */
function dedupeByAmountWindow(cands: ChargeCandidate[]): ChargeCandidate[] {
  const sorted = [...cands].sort((a, b) => t(a.date) - t(b.date))
  const kept: ChargeCandidate[] = []
  for (const c of sorted) {
    if (kept.some(k => Math.abs(k.amount - c.amount) < CENT && Math.abs(t(k.date) - t(c.date)) <= DUP_DAYS * DAY)) continue
    kept.push(c)
  }
  return kept
}

/** All subsets of size 2..COMBO_MAX whose amounts sum to `total` (to the cent). */
function exactSubsets(parts: ChargeCandidate[], total: number): ChargeCandidate[][] {
  const out: ChargeCandidate[][] = []
  const n = parts.length
  const combine = (start: number, size: number, acc: ChargeCandidate[], sum: number) => {
    if (acc.length === size) {
      if (Math.abs(sum - total) < CENT) out.push([...acc])
      return
    }
    for (let i = start; i < n; i++) {
      if (sum - CENT > total) break // amounts sorted asc → no smaller sum ahead
      acc.push(parts[i]); combine(i + 1, size, acc, sum + parts[i].amount); acc.pop()
    }
  }
  for (let size = 2; size <= COMBO_MAX; size++) combine(0, size, [], 0)
  return out
}

export function matchBillToCharge(bill: ParsedAttBill, charges: ChargeCandidate[]): BillMatch {
  const issue = t(bill.issueDate)
  const usable = (c: ChargeCandidate): boolean =>
    t(c.date) >= issue && t(c.date) <= issue + WINDOW_DAYS * DAY && // in the window
    c.review_status !== 'manually_classified' &&                    // candidate unless Kyle already decided it
    c.bucket !== 'Exclude'

  // ── 1) Single exact-total charge (the common, high-confidence case) ──────────
  const cands = charges
    .filter(c => Math.abs(c.amount - bill.billTotal) < CENT && usable(c))
    .sort((a, b) => t(a.date) - t(b.date))

  if (cands.length > 0) {
    const keep = cands[0]
    const others = cands.slice(1)
    const duplicates = others.filter(c => Math.abs(t(c.date) - t(keep.date)) <= DUP_DAYS * DAY)
    const distinct = others.filter(c => Math.abs(t(c.date) - t(keep.date)) > DUP_DAYS * DAY)

    // Two+ genuinely different same-total charges → don't guess.
    if (distinct.length > 0) return { action: 'review', candidateIds: cands.map(c => c.id) }

    return {
      action: 'split',
      targetId: keep.id,
      line0468: r2(bill.line0468Amount),
      remainder: r2(bill.billTotal - bill.line0468Amount),
      duplicateIds: duplicates.map(c => c.id),
    }
  }

  // ── 2) A unique combination of AT&T drafts that SUMS to the bill total ───────
  const parts = dedupeByAmountWindow(charges.filter(c => usable(c) && c.amount < bill.billTotal - CENT))
    .sort((a, b) => a.amount - b.amount)
  const combos = exactSubsets(parts, bill.billTotal)
    // the carrier (largest in the combo) must be big enough to carve the 0468 line out of
    .filter(cb => Math.max(...cb.map(c => c.amount)) + CENT >= bill.line0468Amount)

  if (combos.length === 1) {
    const combo = combos[0]
    const carrier = combo.reduce((m, c) => (c.amount > m.amount ? c : m), combo[0])
    return {
      action: 'split-combo',
      carrierId: carrier.id,
      line0468: r2(bill.line0468Amount),
      personalFromCarrier: r2(carrier.amount - bill.line0468Amount),
      personalIds: combo.filter(c => c.id !== carrier.id).map(c => c.id),
    }
  }
  // 0 combos, or 2+ different combos (ambiguous) → wait; the review UI only handles
  // single-charge picks, so a combo is never silently guessed.
  return { action: 'pending' }
}
