// electron/services/att-bill-matcher.ts
//
// Decide how a parsed AT&T bill maps onto the card charges. Pure + tested.
// `charges` must already be filtered to AT&T-looking, untouched charges (the
// caller does the merchant SQL filter). Rules locked with Kyle:
//   • confident = AT&T charge, amount == bill total TO THE CENT, dated within
//     [issue date, issue date + 55 days];
//   • duplicate collapse = candidates of the same amount within 4 days of the
//     earliest are double-posts → keep the earliest, exclude the rest;
//   • exactly one after dedup → split; none → pending; 2+ distinct → review.

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
  | { action: 'pending' }
  | { action: 'review'; candidateIds: string[] }

const DAY = 86_400_000
const t = (iso: string): number => new Date(iso + 'T12:00:00').getTime()
const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

export const WINDOW_DAYS = 55
export const DUP_DAYS = 4

export function matchBillToCharge(bill: ParsedAttBill, charges: ChargeCandidate[]): BillMatch {
  const issue = t(bill.issueDate)
  const cands = charges
    .filter(c =>
      Math.abs(c.amount - bill.billTotal) < 0.005 &&                 // exact to the cent
      t(c.date) >= issue && t(c.date) <= issue + WINDOW_DAYS * DAY && // in the window
      c.review_status === 'auto_classified' &&                       // untouched
      c.bucket !== 'Exclude')
    .sort((a, b) => t(a.date) - t(b.date))

  if (cands.length === 0) return { action: 'pending' }

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
