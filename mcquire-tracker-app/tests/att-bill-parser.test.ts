// tests/att-bill-parser.test.ts
// Uses a representative slice of the real AT&T bill text (synthetic data, real
// format — no PII committed). Real-PDF extraction was validated separately across
// 5 months (Dec 2025–Apr 2026).

import { describe, it, expect } from 'vitest'
import { parseAttBill } from '../electron/services/att-bill-parser'

const SAMPLE = `
EXAMPLE INVESTMENTS, LLC Page: 1 of 17
Issue Date:Apr 27, 2026
Account Number:287301218152
Total due
$488.73
AutoPay is scheduled to charge your card on May 20, 2026
...Wireless continued
Phone, 832.687.0468
EXAMPLE USER
Total for 832.687.0468$91.77
`

describe('AT&T bill parser', () => {
  it('extracts account, dates (ISO), bill total, and the 0468 line amount', () => {
    expect(parseAttBill(SAMPLE)).toEqual({
      accountNumber: '287301218152',
      issueDate: '2026-04-27',
      autopayDate: '2026-05-20',
      billTotal: 488.73,
      line0468Amount: 91.77,
    })
  })

  it('handles the "AutoPay is scheduled for:" wording on its own line', () => {
    const s = SAMPLE.replace(
      'AutoPay is scheduled to charge your card on May 20, 2026',
      'AutoPay is scheduled for:\nMay 20, 2026')
    expect(parseAttBill(s)?.autopayDate).toBe('2026-05-20')
  })

  it('returns null when a required field is missing', () => {
    expect(parseAttBill(SAMPLE.replace('Total for 832.687.0468$91.77', ''))).toBeNull()
    expect(parseAttBill('not a bill')).toBeNull()
  })

  it('returns null if the 0468 amount is not a strict portion of the bill total', () => {
    expect(parseAttBill(SAMPLE.replace('Total for 832.687.0468$91.77', 'Total for 832.687.0468$500.00'))).toBeNull()
  })
})
