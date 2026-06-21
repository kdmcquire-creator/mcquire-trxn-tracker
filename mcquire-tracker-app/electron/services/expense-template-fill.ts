// electron/services/expense-template-fill.ts
//
// Fills the Peak 10 expense-report template (.xlsx) with live expense data while
// preserving EVERYTHING else byte-for-byte: the "Expense" Table, all structured-
// reference formulas, the per-diem / reimbursement machinery, styles, the logo,
// and the signature block. exceljs corrupts this file on save, so we edit the
// underlying OOXML directly with jszip and only touch what must change.
//
// Why this is tractable: the data-row formulas use structured references
// (Expense[[#This Row],…]) with NO hard row numbers, so every data row is an
// identical clone. Adding/removing expense rows therefore only requires:
//   1. emitting one <row> per expense (rows 11..10+N),
//   2. shifting the totals + signature block below by a fixed delta, and
//   3. widening the Table / autoFilter refs.
// No formula is ever rewritten.

import JSZip from 'jszip'
import { EXPENSE_TEMPLATE_B64 } from './expense-template-data'

export interface ExpenseRow {
  date: string      // ISO 'yyyy-mm-dd'
  entity: string    // e.g. 'Peak 10 Energy Management'
  account: string   // the canonical p10_category
  merchant: string
  notes: string
  amount: number
}

export interface FillOptions {
  title: string             // full B3 title, e.g. 'Kyle McQuire Expense Report: Dec2025 - Jun2026'
  period: string            // D7 "Month" value, e.g. 'Dec2025 - Jun2026'
  name?: string             // D5 (defaults 'Kyle McQuire')
  role?: string             // D6 (defaults 'CEO')
}

const FIRST_DATA_ROW = 11
const BASE_DATA_ROWS = 87           // template data rows 11..97
const ORIG_LAST_ROW = 111           // <dimension> bottom

// Data-row formula text — copied verbatim from the template (already XML-escaped).
// Single-quoted so the `$`/`[` characters are never treated as interpolation.
const F_I = 'ROUNDUP(Expense[[#This Row],[Mileage]]*$I$8,2)'
const F_N = 'SUM(Expense[[#This Row],[Number of Employees]:[Number of Guests]])'
const F_R = 'IF(Expense[[#This Row],[Account]]=$Q$8,SUMIFS(#REF!,#REF!,Expense[[#This Row],[Location]],#REF!,"&lt;="&amp;Expense[[#This Row],[Date]],#REF!,"&gt;="&amp;Expense[[#This Row],[Date]]),0)*Expense[[#This Row],[Number of People]]*Expense[[#This Row],[Number of Nights]]'
const F_S = 'IF(Expense[[#This Row],[Account]]=$R$8,SUMIFS(#REF!,#REF!,Expense[[#This Row],[Location]],#REF!,"&lt;="&amp;Expense[[#This Row],[Date]],#REF!,"&gt;="&amp;Expense[[#This Row],[Date]]),0)*Expense[[#This Row],[Number of People]]'
const F_V = 'Expense[[#This Row],[Amount ($)]]'

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Excel 1900-system serial (days since 1899-12-30). Verified vs the template. */
export function dateToSerial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000)
}

function amountStr(n: number): string {
  return String(Math.round(Math.abs(n) * 100) / 100)
}

function numCell(ref: string, s: string, v: string): string {
  return `<c r="${ref}" s="${s}"><v>${v}</v></c>`
}
function strCell(ref: string, s: string, text: string): string {
  // inline string — avoids touching the shared-strings table
  const t = text === text.trim() ? '<t>' : '<t xml:space="preserve">'
  return `<c r="${ref}" s="${s}" t="inlineStr"><is>${t}${xmlEscape(text)}</t></is></c>`
}
function fCell(ref: string, s: string, f: string, v: string, str = false): string {
  return `<c r="${ref}" s="${s}"${str ? ' t="str"' : ''}><f>${f}</f><v>${v}</v></c>`
}
function emptyCell(ref: string, s: string): string {
  return `<c r="${ref}" s="${s}"/>`
}

/** A visible, filled expense row mirroring template row 11/12 (plain O/P/Q formulas). */
function filledRow(r: number, e: ExpenseRow, name: string, role: string, period: string): string {
  const amt = amountStr(e.amount)
  return `<row r="${r}" spans="1:27" s="8" customFormat="1" ht="15" customHeight="1" x14ac:dyDescent="0.25">`
    + numCell(`B${r}`, '1', String(dateToSerial(e.date)))
    + strCell(`C${r}`, '2', e.entity)
    + strCell(`D${r}`, '2', e.account)
    + strCell(`E${r}`, '3', e.merchant)
    + (e.notes ? strCell(`F${r}`, '3', e.notes) : emptyCell(`F${r}`, '3'))
    + numCell(`G${r}`, '24', amt)
    + emptyCell(`H${r}`, '2')
    + fCell(`I${r}`, '4', F_I, '0')
    + emptyCell(`J${r}`, '2') + emptyCell(`K${r}`, '2') + emptyCell(`L${r}`, '2') + emptyCell(`M${r}`, '2')
    + fCell(`N${r}`, '2', F_N, '0')
    + fCell(`O${r}`, '5', '$D$5', xmlEscape(name), true)
    + fCell(`P${r}`, '5', '$D$6', xmlEscape(role), true)
    + fCell(`Q${r}`, '6', '$D$7', xmlEscape(period), true)
    + fCell(`R${r}`, '7', F_R, '0')
    + fCell(`S${r}`, '7', F_S, '0')
    + emptyCell(`T${r}`, '4') + emptyCell(`U${r}`, '4')
    + fCell(`V${r}`, '4', F_V, amt)
    + emptyCell(`AA${r}`, '9')
    + `</row>`
}

/** A hidden, empty spare row — mirrors the template's own hidden filler rows (e.g. row 34). */
function emptyRow(r: number): string {
  return `<row r="${r}" spans="2:27" s="14" customFormat="1" hidden="1" x14ac:dyDescent="0.25">`
    + emptyCell(`B${r}`, '1') + emptyCell(`C${r}`, '2') + emptyCell(`D${r}`, '2')
    + emptyCell(`E${r}`, '3') + emptyCell(`F${r}`, '3') + emptyCell(`G${r}`, '24')
    + emptyCell(`H${r}`, '2') + emptyCell(`I${r}`, '4') + emptyCell(`J${r}`, '2')
    + emptyCell(`K${r}`, '2') + emptyCell(`L${r}`, '2') + emptyCell(`M${r}`, '2')
    + emptyCell(`N${r}`, '2') + emptyCell(`O${r}`, '5') + emptyCell(`P${r}`, '5')
    + emptyCell(`Q${r}`, '6') + emptyCell(`R${r}`, '7') + emptyCell(`S${r}`, '7')
    + emptyCell(`T${r}`, '4') + emptyCell(`U${r}`, '4')
    + fCell(`V${r}`, '4', F_V, '0')
    + emptyCell(`AA${r}`, '28')
    + `</row>`
}

/** Shift every <row>/<c> row number in the tail (rows >= 98) down by delta. */
function renumberTail(tail: string, delta: number): string {
  if (delta === 0) return tail
  const sdEnd = tail.indexOf('</sheetData>')
  const rows = tail.slice(0, sdEnd)
  const rest = tail.slice(sdEnd)
  const shifted = rows
    .replace(/<row r="(\d+)"/g, (_m, n) => `<row r="${Number(n) + delta}"`)
    .replace(/<c r="([A-Z]+)(\d+)"/g, (_m, col, n) => `<c r="${col}${Number(n) + delta}"`)
  return shifted + rest
}

export async function fillExpenseTemplate(expenses: ExpenseRow[], opts: FillOptions): Promise<Buffer> {
  const name = opts.name ?? 'Kyle McQuire'
  const role = opts.role ?? 'CEO'
  const period = opts.period

  const zip = await JSZip.loadAsync(Buffer.from(EXPENSE_TEMPLATE_B64, 'base64'))

  // ── sheet1.xml ──────────────────────────────────────────────────────────────
  let sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')

  const N = expenses.length
  const dataRowCount = Math.max(BASE_DATA_ROWS, N)
  const delta = dataRowCount - BASE_DATA_ROWS            // >= 0
  const lastDataRow = FIRST_DATA_ROW + dataRowCount - 1  // 97 + delta
  const newTotalsRow = lastDataRow + 1                   // 98 + delta

  const body: string[] = []
  for (let i = 0; i < dataRowCount; i++) {
    const r = FIRST_DATA_ROW + i
    body.push(i < N ? filledRow(r, expenses[i], name, role, period) : emptyRow(r))
  }

  const dataStart = sheet.search(/<row r="11"[ >]/)
  const tailStart = sheet.search(/<row r="98"[ >]/)
  if (dataStart < 0 || tailStart < 0) throw new Error('expense template: data region not found')
  const head = sheet.slice(0, dataStart)
  const tail = renumberTail(sheet.slice(tailStart), delta)
  sheet = head + body.join('') + tail

  // Title (B3) + "Month" (D7) → inline strings carrying the report period.
  sheet = sheet.replace(/<c r="B3"[^>]*>[\s\S]*?<\/c>/,
    `<c r="B3" s="12" t="inlineStr"><is><t>${xmlEscape(opts.title)}</t></is></c>`)
  sheet = sheet.replace(/<c r="D7"[^>]*\/>|<c r="D7"[^>]*>[\s\S]*?<\/c>/,
    `<c r="D7" s="42" t="inlineStr"><is><t>${xmlEscape(period)}</t></is></c>`)
  sheet = sheet.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A2:AA${ORIG_LAST_ROW + delta}"/>`)
  zip.file('xl/worksheets/sheet1.xml', sheet)

  // ── table1.xml: widen the Table, autoFilter, and sort refs ───────────────────
  let table = await zip.file('xl/tables/table1.xml')!.async('string')
  table = table
    .replace('ref="B10:V98"', `ref="B10:V${newTotalsRow}"`)
    .replace('<autoFilter ref="B10:V97"', `<autoFilter ref="B10:V${lastDataRow}"`)
    .replace('<sortState ref="B11:V97"', `<sortState ref="B11:V${lastDataRow}"`)
    .replace('<sortCondition ref="B10:B97"/>', `<sortCondition ref="B10:B${lastDataRow}"/>`)
  zip.file('xl/tables/table1.xml', table)

  // ── workbook.xml: force a full recalc on open (caches above are now stale) ────
  let wb = await zip.file('xl/workbook.xml')!.async('string')
  wb = wb.replace(/<calcPr[^>]*\/>/, '<calcPr calcId="191029" fullCalcOnLoad="1"/>')
  zip.file('xl/workbook.xml', wb)

  // ── drop calcChain.xml (orders formulas by the OLD row numbers) ───────────────
  zip.remove('xl/calcChain.xml')
  let ct = await zip.file('[Content_Types].xml')!.async('string')
  ct = ct.replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, '')
  zip.file('[Content_Types].xml', ct)
  let rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string')
  rels = rels.replace(/<Relationship[^>]*calcChain\.xml"\/>/, '')
  zip.file('xl/_rels/workbook.xml.rels', rels)

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
