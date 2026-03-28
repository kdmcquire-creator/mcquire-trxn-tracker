import Papa from 'papaparse'
import fs from 'fs'
import { createHash } from 'crypto'

export interface ParsedRow {
  transaction_date: string
  posting_date: string | null
  description_raw: string
  amount: number
  category_source: string | null
  source_row_hash: string
}

// ── USAA CSV Parser ──────────────────────────────────────────────────
// Columns: Date, Description, Original Description, Category, Amount, Status
export function parseUSAAcsv(filePath: string): ParsedRow[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const result = Papa.parse(content, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() })
  const rows: ParsedRow[] = []

  for (const raw of result.data as Record<string, string>[]) {
    const dateStr = raw['Date'] || raw['date'] || ''
    const desc = raw['Original Description'] || raw['Description'] || raw['description'] || ''
    const amtStr = raw['Amount'] || raw['amount'] || '0'
    const cat = raw['Category'] || raw['category'] || null

    if (!dateStr || !desc) continue

    // USAA amount: negative = expense, positive = income
    const amtRaw = parseFloat(amtStr.replace(/[$,]/g, ''))
    const amount = isNaN(amtRaw) ? 0 : -amtRaw // flip sign: positive = expense

    const rowStr = JSON.stringify({ dateStr, desc, amtStr })
    const hash = createHash('sha256').update(rowStr).digest('hex')

    rows.push({
      transaction_date: normalizeDate(dateStr),
      posting_date: null,
      description_raw: desc.trim(),
      amount,
      category_source: cat,
      source_row_hash: hash
    })
  }
  return rows
}

// ── Apple Card CSV Parser ────────────────────────────────────────────
// Columns: Transaction Date, Clearing Date, Description, Merchant, Category, Type, Amount (USD), Purchased By
export function parseAppleCardCsv(filePath: string): ParsedRow[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const result = Papa.parse(content, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() })
  const rows: ParsedRow[] = []

  for (const raw of result.data as Record<string, string>[]) {
    const txDate = raw['Transaction Date'] || ''
    const clearDate = raw['Clearing Date'] || null
    const merchant = raw['Merchant'] || raw['Description'] || ''
    const cat = raw['Category'] || null
    const amtStr = raw['Amount (USD)'] || raw['Amount'] || '0'

    if (!txDate || !merchant) continue

    // Apple Card: positive = expense, negative = payment/refund
    const amtRaw = parseFloat(amtStr.replace(/[$,]/g, ''))
    const amount = isNaN(amtRaw) ? 0 : amtRaw

    const rowStr = JSON.stringify({ txDate, merchant, amtStr })
    const hash = createHash('sha256').update(rowStr).digest('hex')

    rows.push({
      transaction_date: normalizeDate(txDate),
      posting_date: clearDate ? normalizeDate(clearDate) : null,
      description_raw: merchant.trim(),
      amount,
      category_source: cat,
      source_row_hash: hash
    })
  }
  return rows
}

// ── Generic / Monarch CSV Parser ─────────────────────────────────────
// Monarch export: Date, Merchant, Category, Account, Original Statement, Notes, Amount, Tags, Owner, Business Entity
export function parseMonarchCsv(filePath: string): Array<ParsedRow & { monarch_account?: string; original_statement?: string }> {
  const content = fs.readFileSync(filePath, 'utf-8')
  const result = Papa.parse(content, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() })
  const rows: Array<ParsedRow & { monarch_account?: string; original_statement?: string }> = []

  for (const raw of result.data as Record<string, string>[]) {
    const dateStr = raw['Date'] || ''
    const merchant = raw['Merchant'] || ''
    const cat = raw['Category'] || null
    const account = raw['Account'] || ''
    const original = raw['Original Statement'] || ''
    const amtStr = raw['Amount'] || '0'

    if (!dateStr || !merchant) continue

    const amtRaw = parseFloat(amtStr.replace(/[$,]/g, ''))
    const amount = isNaN(amtRaw) ? 0 : -amtRaw // Monarch: negative = expense

    const rowStr = JSON.stringify({ dateStr, merchant, amtStr, account })
    const hash = createHash('sha256').update(rowStr).digest('hex')

    rows.push({
      transaction_date: normalizeDate(dateStr),
      posting_date: null,
      description_raw: (original || merchant).trim(),
      amount,
      category_source: cat,
      source_row_hash: hash,
      monarch_account: account,
      original_statement: original
    })
  }
  return rows
}

function normalizeDate(s: string): string {
  // Handle M/D/YYYY, MM/DD/YYYY, YYYY-MM-DD
  if (!s) return ''
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash) {
    const [, m, d, y] = slash
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`
  }
  return s.substring(0, 10) // assume ISO or truncate
}

export function detectFileType(filePath: string): 'usaa' | 'apple_card' | 'monarch' | 'unknown' {
  const content = fs.readFileSync(filePath, 'utf-8').substring(0, 500)
  if (content.includes('Transaction Date') && content.includes('Clearing Date') && content.includes('Purchased By')) return 'apple_card'
  if (content.includes('Original Description') || (content.includes('Date') && content.includes('Status'))) return 'usaa'
  if (content.includes('Original Statement') || content.includes('Business Entity')) return 'monarch'
  return 'unknown'
}
