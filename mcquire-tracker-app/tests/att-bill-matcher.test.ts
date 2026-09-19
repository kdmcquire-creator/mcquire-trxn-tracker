// tests/att-bill-matcher.test.ts
import { describe, it, expect } from 'vitest'
import { matchBillToCharge, type ChargeCandidate } from '../electron/services/att-bill-matcher'
import type { ParsedAttBill } from '../electron/services/att-bill-parser'

const bill: ParsedAttBill = {
  accountNumber: '287301218152', issueDate: '2026-04-27', autopayDate: '2026-05-20',
  billTotal: 488.73, line0468Amount: 91.77,
}
const charge = (id: string, amount: number, date: string, extra: Partial<ChargeCandidate> = {}): ChargeCandidate =>
  ({ id, amount, date, bucket: null, review_status: 'auto_classified', ...extra })

describe('AT&T bill → charge matcher', () => {
  it('splits the exact-total charge in the window (0468 → Peak 10, rest → Personal)', () => {
    expect(matchBillToCharge(bill, [charge('c1', 488.73, '2026-05-20')]))
      .toEqual({ action: 'split', targetId: 'c1', line0468: 91.77, remainder: 396.96, duplicateIds: [] })
  })

  it('collapses a double-posted autopay (same amount within 4 days): keep first, exclude rest', () => {
    expect(matchBillToCharge(bill, [charge('c1', 488.73, '2026-05-20'), charge('c2', 488.73, '2026-05-22')]))
      .toMatchObject({ action: 'split', targetId: 'c1', duplicateIds: ['c2'] })
  })

  it('is pending when no confident charge exists yet', () => {
    expect(matchBillToCharge(bill, [])).toEqual({ action: 'pending' })
    expect(matchBillToCharge(bill, [charge('c1', 488.74, '2026-05-20')])).toEqual({ action: 'pending' }) // a cent off
    expect(matchBillToCharge(bill, [charge('c1', 488.73, '2026-07-15')])).toEqual({ action: 'pending' }) // out of window
  })

  it('asks for review when two same-total charges are >4 days apart (ambiguous)', () => {
    expect(matchBillToCharge(bill, [charge('c1', 488.73, '2026-05-05'), charge('c2', 488.73, '2026-05-20')]))
      .toMatchObject({ action: 'review' })
  })

  it('matches a pending_review charge (the autopay the split rule flagged)', () => {
    expect(matchBillToCharge(bill, [charge('c1', 488.73, '2026-05-20', { review_status: 'pending_review' })]))
      .toMatchObject({ action: 'split', targetId: 'c1' })
  })

  it('ignores charges already split / manually classified / excluded', () => {
    expect(matchBillToCharge(bill, [charge('c1', 488.73, '2026-05-20', { review_status: 'manually_classified' })]))
      .toEqual({ action: 'pending' })
    expect(matchBillToCharge(bill, [charge('c1', 488.73, '2026-05-20', { bucket: 'Exclude' })]))
      .toEqual({ action: 'pending' })
  })
})

// Option C: a bill paid across several ACH drafts (e.g. a device-upgrade month).
describe('AT&T bill → multi-draft combination (Option C)', () => {
  // May 2026: $1,017.16 was drafted as $414.30 (6/09) + $602.86 (6/22).
  const may: ParsedAttBill = {
    accountNumber: '287301218152', issueDate: '2026-05-27', autopayDate: '2026-06-20',
    billTotal: 1017.16, line0468Amount: 91.77,
  }

  it('splits the 0468 line out of the largest draft; the rest → Personal', () => {
    const m = matchBillToCharge(may, [charge('c1', 414.30, '2026-06-09'), charge('c2', 602.86, '2026-06-22')])
    expect(m).toEqual({
      action: 'split-combo',
      carrierId: 'c2',                 // the larger draft carries the split
      line0468: 91.77,
      personalFromCarrier: 511.09,     // 602.86 − 91.77
      personalIds: ['c1'],             // the other draft → Personal in full
    })
  })

  it('prefers a single exact-total charge over a combination', () => {
    const m = matchBillToCharge(may, [
      charge('single', 1017.16, '2026-06-20'),
      charge('c1', 414.30, '2026-06-09'), charge('c2', 602.86, '2026-06-22'),
    ])
    expect(m).toMatchObject({ action: 'split', targetId: 'single' })
  })

  it('stays pending when a draft is outside the window (no complete sum)', () => {
    const m = matchBillToCharge(may, [charge('c1', 414.30, '2026-06-09'), charge('c2', 602.86, '2026-08-01')])
    expect(m).toEqual({ action: 'pending' })
  })

  it('stays pending when two different combinations both sum to the total (ambiguous)', () => {
    const amb: ParsedAttBill = { ...may, billTotal: 250, line0468Amount: 40 }
    const m = matchBillToCharge(amb, [
      charge('a', 100, '2026-06-01'), charge('b', 150, '2026-06-05'),
      charge('c', 90, '2026-06-09'), charge('d', 160, '2026-06-13'),
    ])
    expect(m).toEqual({ action: 'pending' })
  })
})
