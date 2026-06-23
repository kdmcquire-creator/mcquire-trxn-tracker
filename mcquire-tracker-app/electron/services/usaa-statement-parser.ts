// electron/services/usaa-statement-parser.ts
//
// Parses a USAA bank-statement PDF (already converted to text by pdf-parse) into
// the same ParsedRow[] shape the CSV importer produces, so it can flow through
// the existing dedup → classify → insert pipeline.
//
// Statement layout (per transaction), as pdf-parse flattens it:
//   MM/DD <description line 1>
//   <description line 2..N>            (merchant, reference #s, masked accounts)
//   <debit>  <credit>  <balance>       — rendered across 1-3 lines:
//       debit row : "$123.45"  then "0"        then "$bal"
//       credit row: "0"        then "$123.45 $bal"
// A line is an AMOUNT line only if it is PURELY amounts ("$X.XX", "0", or two of
// them) — so the ATM-rebate description "$263.50 ATM W/D … on 12/31" stays text.
// Each transaction yields exactly [debit, credit, balance]; the "Beginning
// Balance" pseudo-row (debit 0 + credit 0) is skipped.
//
// Sign convention matches parseUSAAcsv: positive = expense (debit), negative =
// income (credit).

import { createHash } from 'crypto'
import type { ParsedRow } from './csv-parser'

export interface StatementSummary {
  beginningBalance: number | null
  endingBalance: number | null
  totalDebits: number | null
  totalCredits: number | null
}

export interface ParsedStatement {
  accountMask: string | null
  periodStart: string | null // ISO yyyy-mm-dd
  periodEnd: string | null
  summary: StatementSummary
  rows: ParsedRow[]
}

const money = (s: string): number => parseFloat(s.replace(/[$,\s]/g, '')) || 0

// A line that is ONLY amounts: "$1,858.00", "0", "0 0", or "$20.00 $1,200.00".
const AMOUNT_LINE = /^(\$[\d,]+\.\d{2}|0)(\s+(\$[\d,]+\.\d{2}|0))?\s*$/

// Page-break boilerplate that can fall between transactions.
const JUNK = [
  /^USAA/i, /^CHECKING\b/i, /^for Account Number/i, /^Statement Period/i,
  /^Online:/i, /^\d{9}\b/, /^\d{6}-\d{4}\b/, /^Transactions/i,
  /^Date\s+Description/i, /^Page \d+ of \d+/i, /Activity Summary/i,
]
const isJunk = (l: string): boolean => !l || JUNK.some(re => re.test(l))

export function parseUSAAStatement(text: string): ParsedStatement {
  const acct = text.match(/Account Number:\s*(\d+)/)
  const accountMask = acct ? acct[1].slice(-4) : null

  const per = text.match(/Statement Period:\s*(\d{2})\/(\d{2})\/(\d{4})\s*to\s*(\d{2})\/(\d{2})\/(\d{4})/)
  const periodStart = per ? `${per[3]}-${per[1]}-${per[2]}` : null
  const periodEnd = per ? `${per[6]}-${per[4]}-${per[5]}` : null
  const startYear = per ? parseInt(per[3], 10) : new Date().getFullYear()
  const endYear = per ? parseInt(per[6], 10) : startYear

  const grab = (re: RegExp): number | null => {
    const m = text.match(re)
    return m ? money(m[1]) : null
  }
  const summary: StatementSummary = {
    beginningBalance: grab(/Beginning Balance\s*\$?([\d,]+\.\d{2})/),
    endingBalance: grab(/Ending Balance\s*\$?([\d,]+\.\d{2})/),
    totalDebits: grab(/Withdrawals\/Debits\s*\$?([\d,]+\.\d{2})/),
    totalCredits: grab(/Deposits\/Credits\s*\$?([\d,]+\.\d{2})/),
  }

  const rows: ParsedRow[] = []
  let cur: { mm: string; dd: string; desc: string[]; amounts: number[]; locked: boolean } | null = null

  const finalize = () => {
    if (!cur) return
    const me = cur
    cur = null
    let debit = me.amounts[0] ?? 0
    let credit = me.amounts[1] ?? 0
    // Check rows put the amount on the date line ("CHECK # 1794 $200.00") with
    // only [0, balance] following, so debit reads as 0 and the balance becomes a
    // bogus credit. Recover the debit (a check is always money out) from the text.
    const check = me.desc.join(' ').match(/CHECK #\s*\d+\s+\$?([\d,]+\.\d{2})/i)
    if (check) { debit = money(check[1]); credit = 0 }
    if (debit === 0 && credit === 0) return // Beginning Balance / non-transaction
    // Year: assume the statement's start year; if that lands before the period
    // start (a Jan date on a Dec-Jan statement), roll to the end year.
    let year = startYear
    if (periodStart && `${startYear}-${me.mm}-${me.dd}` < periodStart) year = endYear
    const transaction_date = `${year}-${me.mm}-${me.dd}`
    const description_raw = me.desc.join(' ').replace(/\s+/g, ' ').trim()
    const amount = debit > 0 ? debit : -credit // positive = expense, negative = income
    const source_row_hash = createHash('sha256')
      .update(`usaa-pdf|${accountMask}|${transaction_date}|${description_raw}|${amount}`)
      .digest('hex')
    rows.push({ transaction_date, posting_date: null, description_raw, amount, category_source: null, source_row_hash })
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const dm = line.match(/^(\d{2})\/(\d{2})(?:\s+(.*))?$/)
    if (dm) {
      finalize()
      cur = { mm: dm[1], dd: dm[2], desc: dm[3] ? [dm[3]] : [], amounts: [], locked: false }
      continue
    }
    if (!cur || isJunk(line)) continue
    if (!cur.locked && AMOUNT_LINE.test(line)) {
      for (const tok of line.split(/\s+/)) cur.amounts.push(money(tok))
      if (cur.amounts.length >= 3) cur.locked = true
      continue
    }
    if (!cur.locked) cur.desc.push(line)
  }
  finalize()

  return { accountMask, periodStart, periodEnd, summary, rows }
}
