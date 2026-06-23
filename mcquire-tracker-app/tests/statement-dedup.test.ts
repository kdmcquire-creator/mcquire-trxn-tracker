// tests/statement-dedup.test.ts
// Same-account fuzzy dedup for re-imported statement rows: match by exact amount
// + near date + shared significant description token, claiming each existing row
// once so genuine identical-same-day pairs still import.

import { describe, it, expect } from 'vitest'
import { matchStatementDuplicates, statementTokens, type ExistingRow, type StatementRow } from '../electron/services/dedup'

const existing: ExistingRow[] = [
  { id: 'e1', amount: 150, transaction_date: '2025-01-06', text: 'VENMO *Jose Landscape Visa Direct NY' },
  { id: 'e2', amount: 150, transaction_date: '2025-01-06', text: 'VENMO *Jose Landscape Visa Direct NY' },
  { id: 'e3', amount: 19.37, transaction_date: '2025-01-15', text: 'GRUBHUB*WHATABURGER GRUBHUB.COM NY' },
  { id: 'e4', amount: -10000, transaction_date: '2025-01-07', text: 'AMEGY BANK EXTRL XFER MCQUIRE, KYLE' },
]

describe('matchStatementDuplicates', () => {
  it('ignores transaction-type noise, numbers, and masks when tokenizing', () => {
    expect([...statementTokens('POS DEBIT 010625 4829010625 VENMO *Jose Landscape Visa Direct NY')])
      .toEqual(expect.arrayContaining(['venmo', 'jose', 'landscape']))
    expect([...statementTokens('ACH WITHDRAWAL 011025 ***********796')]).toHaveLength(0)
  })

  it('flags re-imported rows; leaves genuinely-new and different-merchant rows', () => {
    const parsed: StatementRow[] = [
      { amount: 150, transaction_date: '2025-01-06', description_raw: 'POS DEBIT 010625 VENMO *Jose Landscape Visa Direct NY' }, // dup of e1
      { amount: 19.37, transaction_date: '2025-01-16', description_raw: 'DEBIT CARD 011525 GRUBHUB*WHATABURGER' },             // dup of e3 (1 day off)
      { amount: -10000, transaction_date: '2025-01-07', description_raw: 'ACH DEP 010725 AMEGY BANK EXTRL XFER MCQUIRE, KYLE' }, // dup of e4
      { amount: 200, transaction_date: '2024-12-26', description_raw: 'POS DEBIT VENMO *Madison Bolton' },                      // new (gap period)
      { amount: 150, transaction_date: '2025-01-06', description_raw: 'POS DEBIT 010625 GRUBHUB lunch' },                       // amount+date match but different merchant → new
    ]
    expect(matchStatementDuplicates(parsed, existing)).toEqual([true, true, true, false, false])
  })

  it('claims each existing row once (two identical charges, one already present → one dup, one new)', () => {
    const parsed: StatementRow[] = [
      { amount: 308.49, transaction_date: '2025-01-16', description_raw: 'CLUBCORP SERVICE CARDX' },
      { amount: 308.49, transaction_date: '2025-01-16', description_raw: 'CLUBCORP SERVICE CARDX' },
    ]
    const oneExisting: ExistingRow[] = [{ id: 'x', amount: 308.49, transaction_date: '2025-01-16', text: 'CLUBCORP SERVICE CARDX 972 TX' }]
    expect(matchStatementDuplicates(parsed, oneExisting)).toEqual([true, false])
  })

  it('respects the date window', () => {
    const parsed: StatementRow[] = [{ amount: 150, transaction_date: '2025-01-12', description_raw: 'VENMO Jose Landscape' }]
    expect(matchStatementDuplicates(parsed, existing)).toEqual([false]) // 6 days from e1/e2
  })
})
