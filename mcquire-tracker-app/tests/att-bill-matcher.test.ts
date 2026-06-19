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

  it('ignores charges already split / manually classified / excluded', () => {
    expect(matchBillToCharge(bill, [charge('c1', 488.73, '2026-05-20', { review_status: 'manually_classified' })]))
      .toEqual({ action: 'pending' })
    expect(matchBillToCharge(bill, [charge('c1', 488.73, '2026-05-20', { bucket: 'Exclude' })]))
      .toEqual({ action: 'pending' })
  })
})
