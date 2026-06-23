// tests/usaa-statement-parser.test.ts
// Parse a USAA checking statement (text) into ParsedRow[]. Uses a SYNTHETIC
// statement (no real PII) that mirrors the real layout: debit rows, credit rows
// (0 then "$amt $bal"), multi-line descriptions, a description with a stray "$"
// (must not be read as the amount), a CHECK row (amount on the date line), the
// Beginning-Balance pseudo-row, a page break, and the Dec→Jan year rollover.
// Validates against the statement's own Activity-Summary totals.

import { describe, it, expect } from 'vitest'
import { parseUSAAStatement } from '../electron/services/usaa-statement-parser'

const STMT = `USAA CLASSIC
CHECKING
for Account Number: 0060781234
Statement Period: 12/20/2024 to 01/17/2025
Activity Summary
Beginning Balance
$1,000.00
2 Deposits/Credits $500.00
3 Withdrawals/Debits $375.00
Ending Balance
$1,125.00
Transactions
Date Description Debits Credits Balance
12/20 Beginning Balance
0 0
$1,000.00
12/20 POS DEBIT 122024 9999
ACME STORE Visa Direct NY
$100.00
0
$900.00
12/31 ACH DEP 010225
EMPLOYER PAYROLL
***********4950
0
$400.00 $1,300.00
Page 1 of 2

USAA CLASSIC CHECKING
for Account Number: 0060781234
Transactions (continued)
Date Description Debits Credits Balance
01/05 ATM REBATE
$50.00 ATM W/D 1234 MAIN ST on 01/05
$200.00
0
$1,100.00
01/09 CHECK # 1794 $75.00
0
$1,025.00
01/15 INTEREST PAID
0
$100.00 $1,125.00
Page 2 of 2`

describe('parseUSAAStatement', () => {
  const r = parseUSAAStatement(STMT)

  it('extracts account, period, and summary', () => {
    expect(r.accountMask).toBe('1234')
    expect(r.periodStart).toBe('2024-12-20')
    expect(r.periodEnd).toBe('2025-01-17')
    expect(r.summary).toMatchObject({ beginningBalance: 1000, endingBalance: 1125, totalDebits: 375, totalCredits: 500 })
  })

  it('parses 5 transactions (skipping Beginning Balance) with correct signs, dates, descriptions', () => {
    expect(r.rows).toHaveLength(5)
    const byDesc = (s: string) => r.rows.find(x => x.description_raw.includes(s))!

    const acme = byDesc('ACME STORE')
    expect(acme).toMatchObject({ transaction_date: '2024-12-20', amount: 100 })          // debit → +expense
    expect(acme.description_raw).toBe('POS DEBIT 122024 9999 ACME STORE Visa Direct NY')

    expect(byDesc('EMPLOYER PAYROLL')).toMatchObject({ transaction_date: '2024-12-31', amount: -400 }) // credit → -income

    // the ATM rebate's description contains "$50.00" — must NOT be read as the amount
    const rebate = byDesc('ATM REBATE')
    expect(rebate).toMatchObject({ transaction_date: '2025-01-05', amount: 200 })          // Jan → endYear
    expect(rebate.description_raw).toContain('$50.00 ATM W/D')

    // CHECK row: amount is on the date line; recovered as a debit
    expect(byDesc('CHECK # 1794')).toMatchObject({ transaction_date: '2025-01-09', amount: 75 })

    expect(byDesc('INTEREST PAID')).toMatchObject({ transaction_date: '2025-01-15', amount: -100 })
  })

  it('reconciles to the Activity-Summary totals (the built-in correctness check)', () => {
    const debits = r.rows.filter(x => x.amount > 0).reduce((s, x) => s + x.amount, 0)
    const credits = r.rows.filter(x => x.amount < 0).reduce((s, x) => s - x.amount, 0)
    expect(debits).toBeCloseTo(r.summary.totalDebits!, 2)
    expect(credits).toBeCloseTo(r.summary.totalCredits!, 2)
    expect(r.summary.beginningBalance! - debits + credits).toBeCloseTo(r.summary.endingBalance!, 2)
  })
})
