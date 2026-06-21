// electron/services/att-bill-parser.ts
//
// Parse the TEXT of an AT&T wireless bill PDF (account …8152) into the fields
// needed to auto-split the autopay charge. Pure (takes already-extracted text)
// so it unit-tests without a PDF — the caller extracts text via `pdf-parse`.
//
// Reliable anchors confirmed across Dec 2025–Apr 2026:
//   "Account Number:287301218152"
//   "Issue Date:Apr 27, 2026"
//   "AutoPay is scheduled to charge your card on May 20, 2026"
//   "Total due$488.73"                       (= the autopay amount)
//   "Total for 832.687.0468$91.77"           (the business line's own total)

export interface ParsedAttBill {
  accountNumber: string
  issueDate: string       // ISO yyyy-mm-dd — the match-window anchor
  autopayDate: string     // ISO yyyy-mm-dd
  billTotal: number       // = the autopay amount
  line0468Amount: number  // the 832.687.0468 line total → Peak 10 / Telephone & Communication
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

function toIso(s: string): string | null {
  const m = s.match(/([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})/)
  if (!m) return null
  const mm = MONTHS[m[1].slice(0, 3).toLowerCase()]
  if (!mm) return null
  return `${m[3]}-${mm}-${m[2].padStart(2, '0')}`
}

const money = (s: string): number => parseFloat(s.replace(/,/g, ''))

export function parseAttBill(rawText: string): ParsedAttBill | null {
  const text = (rawText || '').replace(/\s+/g, ' ') // collapse newlines/columns
  const acct = text.match(/Account Number:\s*(\d{6,})/)
  const issue = text.match(/Issue Date:\s*([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})/)
  const autopay = text.match(/AutoPay is scheduled (?:to charge your card on|for:?)\s*([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})/)
  const total = text.match(/Total due\s*\$([\d,]+\.\d{2})/)
  const line = text.match(/Total for 832\.687\.0468\s*\$([\d,]+\.\d{2})/)
  if (!acct || !issue || !autopay || !total || !line) return null

  const issueDate = toIso(issue[1])
  const autopayDate = toIso(autopay[1])
  if (!issueDate || !autopayDate) return null

  const billTotal = money(total[1])
  const line0468Amount = money(line[1])
  // Sanity: the line is a strict portion of the bill.
  if (!(billTotal > 0) || !(line0468Amount > 0) || line0468Amount >= billTotal) return null

  return { accountNumber: acct[1], issueDate, autopayDate, billTotal, line0468Amount }
}
