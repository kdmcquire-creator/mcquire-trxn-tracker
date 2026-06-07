import ExcelJS from 'exceljs'
import type { CompatDb } from './database'
import type { Transaction } from '../../src/shared/types'

const NAVY = '1F3864'
const LBLUE = 'BDD7EE'
const WHITE = 'FFFFFF'

function navyFill() { return { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: NAVY } } }
function headerStyle(_ws: ExcelJS.Worksheet, row: ExcelJS.Row) {
  row.eachCell(cell => {
    cell.fill = navyFill()
    cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: WHITE } }
    cell.border = { top: thinBorder(), bottom: thinBorder(), left: thinBorder(), right: thinBorder() }
    cell.alignment = { vertical: 'middle', wrapText: false }
  })
  row.height = 18
}
function thinBorder() { return { style: 'thin' as const, color: { argb: 'BFBFBF' } } }
function allBorders(cell: ExcelJS.Cell) {
  cell.border = { top: thinBorder(), bottom: thinBorder(), left: thinBorder(), right: thinBorder() }
}
function dataRow(row: ExcelJS.Row, isEven: boolean) {
  const bg = isEven ? 'FFDEEAF1' : 'FFFFFFFF'
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
    cell.font = { name: 'Arial', size: 9 }
    allBorders(cell)
    cell.alignment = { vertical: 'middle' }
  })
  row.height = 15
}

// ── Peak 10 Expense Report ─────────────────────────────────────────────
export async function generatePeak10ExpenseReport(
  db: CompatDb,
  dateFrom: string,
  dateTo: string,
  periodLabel: string,
  outputPath: string,
  options?: { includeAlreadyReported?: boolean }
): Promise<{ file_path: string; total: number; count: number; report_id: string }> {

  const alreadyReimbursedThrough = db.prepare("SELECT value FROM settings WHERE key='peak10_already_reimbursed_through'").get() as { value: string } | undefined
  const cutoff = alreadyReimbursedThrough?.value ?? '2025-11-30'

  // If includeAlreadyReported, don't filter on expense_report_id (re-draft mode)
  const reportFilter = options?.includeAlreadyReported
    ? ''
    : 'AND t.expense_report_id IS NULL'

  const txs = db.prepare(`
    SELECT t.*, a.account_name, a.account_mask, a.institution
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.bucket = 'Peak 10'
      AND t.transaction_date >= ?
      AND t.transaction_date <= ?
      AND t.transaction_date > ?
      AND t.review_status IN ('auto_classified','manually_classified')
      ${reportFilter}
      AND NOT EXISTS (SELECT 1 FROM transactions _sp WHERE _sp.split_parent_id = t.id)
    ORDER BY t.transaction_date ASC
  `).all(dateFrom, dateTo, cutoff) as Transaction[]

  const wb = new ExcelJS.Workbook()
  wb.creator = 'McQuire Tracker'

  const ws = wb.addWorksheet('Expense Report')

  // Title
  ws.mergeCells('A1:S1')
  const titleCell = ws.getCell('A1')
  titleCell.value = `Peak 10 Energy Management — Expense Report: ${periodLabel}`
  titleCell.font = { name: 'Arial', size: 12, bold: true, color: { argb: NAVY } }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 24

  // Column headers (matching Peak 10 template)
  const headers = [
    'Date', 'Entity', 'Account/Category', 'Merchant', 'Description/Notes',
    'Amount ($)', 'Location', '# Nights', '# Employees', '# Guests',
    '# People', 'Name', 'Title', 'Date of Report',
    'Per Diem Lodging', 'Per Diem M&M', 'Billed to Fund Level',
    'Paid by Op. Co.', 'Paid by Manager'
  ]
  const colWidths = [12,22,22,24,32,12,16,8,10,8,8,18,8,14,14,12,18,14,14]

  const headerRow = ws.getRow(2)
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = h
    allBorders(cell)
  })
  headerStyle(ws, headerRow)
  headers.forEach((_, i) => { ws.getColumn(i + 1).width = colWidths[i] })

  let total = 0
  const today = new Date().toLocaleDateString('en-US')

  txs.forEach((tx, idx) => {
    const rowNum = idx + 3
    const row = ws.getRow(rowNum)
    const vals = [
      tx.transaction_date,
      'Peak 10 Energy Management',
      tx.p10_category ?? '',
      tx.merchant_name ?? tx.description_raw,
      tx.description_notes ?? '',
      Math.abs(tx.amount),
      '', '', '', '', '',
      'Kyle McQuire', 'CEO', today,
      '', '', '', '', ''
    ]
    vals.forEach((v, i) => {
      const cell = row.getCell(i + 1)
      cell.value = v
      if (i === 5) {
        cell.numFmt = '$#,##0.00'
        cell.alignment = { horizontal: 'right', vertical: 'middle' }
      }
    })
    dataRow(row, idx % 2 === 0)
    total += Math.abs(tx.amount)
  })

  // Total row
  const totalRow = ws.getRow(txs.length + 3)
  ws.mergeCells(`A${txs.length + 3}:E${txs.length + 3}`)
  const totalLabelCell = totalRow.getCell(1)
  totalLabelCell.value = 'TOTAL'
  totalLabelCell.font = { name: 'Arial', size: 10, bold: true }
  totalLabelCell.alignment = { horizontal: 'right' }

  const totalAmtCell = totalRow.getCell(6)
  totalAmtCell.value = total
  totalAmtCell.font = { name: 'Arial', size: 10, bold: true }
  totalAmtCell.numFmt = '$#,##0.00'
  totalAmtCell.alignment = { horizontal: 'right' }
  totalAmtCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LBLUE } }
  totalRow.height = 18

  await wb.xlsx.writeFile(outputPath)

  // Record the report as a draft — don't tag transactions yet.
  // Transactions only get tagged when the user confirms submission.
  const reportId = require('uuid').v4()
  db.prepare(`INSERT INTO expense_reports
    (id, report_period, date_generated, file_path, status, total_amount, transaction_count, notes)
    VALUES (?,?,datetime('now'),?,'draft',?,?,?)`)
    .run(reportId, periodLabel, outputPath, total, txs.length,
      JSON.stringify({ dateFrom, dateTo, txIds: txs.map(t => t.id) }))

  return { file_path: outputPath, total, count: txs.length, report_id: reportId }
}

// ── Full Tracker Export (9-tab workbook) ──────────────────────────────
export async function generateFullTrackerExport(db: CompatDb, outputPath: string): Promise<void> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'McQuire Tracker'

  // Tab 1: Summary
  const wsSummary = wb.addWorksheet('📊 Summary')
  const wsPeak10 = wb.addWorksheet('🏢 Peak 10 (W2)')
  const wsLLC = wb.addWorksheet('💼 Moonsmoke LLC')
  wb.addWorksheet('🏠 Personal')
  const wsAll = wb.addWorksheet('📋 All Transactions')

  // All Transactions tab
  const allTxs = db.prepare(`
    SELECT t.*, a.account_name, a.account_mask, a.institution
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE (t.bucket != 'Exclude' OR t.bucket IS NULL)
    AND NOT EXISTS (SELECT 1 FROM transactions _sp WHERE _sp.split_parent_id = t.id)
    ORDER BY t.transaction_date DESC
  `).all() as Transaction[]

  const allHeaders = ['Date','Account','Institution','Merchant','Raw Description','Bucket','P10 Category','LLC Category','Notes','Amount','Status','Flag']
  const allHRow = wsAll.getRow(1)
  allHeaders.forEach((h, i) => { allHRow.getCell(i+1).value = h })
  headerStyle(wsAll, allHRow)

  allTxs.forEach((tx, idx) => {
    const row = wsAll.getRow(idx + 2)
    const bucketColor = tx.bucket === 'Peak 10' ? 'FFDEEAF1' : tx.bucket === 'Moonsmoke LLC' ? 'FFE2EFDA' : 'FFFFFFFF'
    const vals = [
      tx.transaction_date, tx.account_name ?? '', tx.institution ?? '',
      tx.merchant_name ?? '', tx.description_raw,
      tx.bucket ?? '(unclassified)', tx.p10_category ?? '', tx.llc_category ?? '',
      tx.description_notes ?? '', tx.amount, tx.review_status, tx.flag_reason ?? ''
    ]
    vals.forEach((v, i) => {
      const cell = row.getCell(i+1)
      cell.value = v
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bucketColor } }
      cell.font = { name: 'Arial', size: 9 }
      allBorders(cell)
      if (i === 9) { cell.numFmt = '$#,##0.00'; cell.alignment = { horizontal: 'right' } }
    })
    row.height = 15
  })

  wsAll.columns.forEach(col => { col.width = 18 })

  // Peak 10 tab
  const p10Txs = db.prepare("SELECT t.*, a.account_name FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.bucket='Peak 10' AND NOT EXISTS (SELECT 1 FROM transactions _sp WHERE _sp.split_parent_id = t.id) ORDER BY t.transaction_date").all() as Transaction[]
  const p10Headers = ['Date','Entity','Account/Category','Merchant','Description/Notes','Amount','Name','Title']
  const p10HRow = wsPeak10.getRow(1)
  p10Headers.forEach((h, i) => { p10HRow.getCell(i+1).value = h })
  headerStyle(wsPeak10, p10HRow)
  p10Txs.forEach((tx, idx) => {
    const row = wsPeak10.getRow(idx+2)
    ;[tx.transaction_date,'Peak 10 Energy Management',tx.p10_category??'',tx.merchant_name??tx.description_raw,tx.description_notes??'',Math.abs(tx.amount),'Kyle McQuire','CEO']
      .forEach((v,i) => { const c = row.getCell(i+1); c.value=v; c.font={name:'Arial',size:9}; allBorders(c); if(i===5){c.numFmt='$#,##0.00';c.alignment={horizontal:'right'}} })
    dataRow(row, idx%2===0)
  })
  wsPeak10.columns.forEach(col => { col.width = 20 })

  // LLC tab
  const llcTxs = db.prepare("SELECT t.*, a.account_name FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.bucket='Moonsmoke LLC' AND NOT EXISTS (SELECT 1 FROM transactions _sp WHERE _sp.split_parent_id = t.id) ORDER BY t.transaction_date").all() as Transaction[]
  const llcHeaders = ['Date','Account','Merchant','Description','Category','Amount','Period Label']
  const llcHRow = wsLLC.getRow(1)
  llcHeaders.forEach((h,i) => { llcHRow.getCell(i+1).value = h })
  headerStyle(wsLLC, llcHRow)
  llcTxs.forEach((tx, idx) => {
    const row = wsLLC.getRow(idx+2)
    ;[tx.transaction_date,tx.account_name??'',tx.merchant_name??tx.description_raw,tx.description_notes??'',tx.llc_category??'',Math.abs(tx.amount),tx.period_label??'']
      .forEach((v,i) => { const c=row.getCell(i+1); c.value=v; c.font={name:'Arial',size:9}; allBorders(c); if(i===5){c.numFmt='$#,##0.00';c.alignment={horizontal:'right'}} })
    dataRow(row, idx%2===0)
  })
  wsLLC.columns.forEach(col => { col.width = 20 })

  // Summary tab
  const peak10Total = p10Txs.reduce((s, t) => s + Math.abs(t.amount), 0)
  const llcTotal = llcTxs.reduce((s, t) => s + Math.abs(t.amount), 0)
  const pending = db.prepare("SELECT COUNT(*) as c FROM transactions WHERE review_status='pending_review'").get() as { c: number }

  wsSummary.getCell('A1').value = 'McQuire Financial Tracker — Summary'
  wsSummary.getCell('A1').font = { name: 'Arial', size: 14, bold: true, color: { argb: NAVY } }

  const summaryData = [
    ['Bucket', 'Transactions', 'Total ($)', 'Status'],
    ['🏢 Peak 10 (W2)', p10Txs.length, peak10Total, 'Expense reimbursement'],
    ['💼 Moonsmoke LLC', llcTxs.length, llcTotal, 'Schedule C'],
    ['⚠️ Pending Review', pending.c, '', 'Needs classification'],
  ]
  summaryData.forEach((rowData, i) => {
    const row = wsSummary.getRow(i + 3)
    rowData.forEach((v, j) => {
      const cell = row.getCell(j + 1)
      cell.value = v
      if (i === 0) { cell.fill = navyFill(); cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: WHITE } } }
      else { cell.font = { name: 'Arial', size: 10 } }
      if (j === 2 && i > 0) { cell.numFmt = '$#,##0.00'; cell.alignment = { horizontal: 'right' } }
      allBorders(cell)
    })
    row.height = 20
  })
  wsSummary.columns.forEach(col => { col.width = 24 })

  await wb.xlsx.writeFile(outputPath)
}

// ── Validate export readiness ──────────────────────────────────────────
export function validateExpenseReportReadiness(db: CompatDb, dateFrom: string, dateTo: string): { valid: boolean; blocking: string[]; warnings: string[] } {
  const blocking: string[] = []
  const warnings: string[] = []

  // Check for Meals & Meetings with no description (exclude split parents)
  const missingDescRows = db.prepare(`
    SELECT t.id, t.merchant_name, t.description_raw, t.description_notes, t.p10_category,
           t.transaction_date, t.review_status, t.is_split_child, t.split_parent_id
    FROM transactions t
    WHERE t.bucket='Peak 10'
    AND t.p10_category IN ('Meals & Meetings - external','Meals & Meetings - internal','Meals & Meetings - internal and external mixed attendees')
    AND (t.description_notes IS NULL OR TRIM(t.description_notes) = '' OR t.description_notes = 'null')
    AND t.transaction_date >= ? AND t.transaction_date <= ?
    AND t.review_status IN ('auto_classified','manually_classified')
    AND NOT EXISTS (SELECT 1 FROM transactions c WHERE c.split_parent_id = t.id)
  `).all(dateFrom, dateTo) as Array<any>
  if (missingDescRows.length > 0) {
    console.log(`[Readiness] Found ${missingDescRows.length} meals missing notes (${dateFrom} to ${dateTo}):`)
    for (const r of missingDescRows.slice(0, 5)) {
      console.log(`  - ${r.transaction_date} ${r.merchant_name ?? r.description_raw} cat="${r.p10_category}" notes="${r.description_notes}" status=${r.review_status} split_child=${r.is_split_child} parent=${r.split_parent_id}`)
    }
    blocking.push(`${missingDescRows.length} Meals & Meetings transactions missing attendee names in Description/Notes`)
  }

  // Check for unflagged AT&T splits
  const attSplits = db.prepare(`
    SELECT COUNT(*) as c FROM transactions
    WHERE bucket='Peak 10' AND review_status='flagged'
    AND flag_reason LIKE '%AT&T%split%'
    AND transaction_date >= ? AND transaction_date <= ?
  `).get(dateFrom, dateTo) as { c: number }
  if (attSplits.c > 0) {
    blocking.push(`${attSplits.c} AT&T bills still need line-item split from att.com/billdetail`)
  }

  // Warn about pending items
  const pending = db.prepare(`
    SELECT COUNT(*) as c FROM transactions
    WHERE review_status='pending_review'
    AND transaction_date >= ? AND transaction_date <= ?
  `).get(dateFrom, dateTo) as { c: number }
  if (pending.c > 0) {
    warnings.push(`${pending.c} transactions in this period are still unclassified`)
  }

  return { valid: blocking.length === 0, blocking, warnings }
}

// ── IRS Form 1120-S & Schedule K-1 Export ──────────────────────────────
// Maps Moonsmoke LLC expense categories to IRS line items

interface ScorpInputs {
  taxYear: string
  grossReceipts: number
  officerCompensation: number
  distributions: number
  otherIncome: number
  beginningCash: number
  endingCash: number
}

const LLC_TO_1120S: Record<string, { line: string; label: string }> = {
  'Rent - Business Lodging':       { line: '11', label: 'Rents' },
  'Lodging - Business Housing':    { line: '11', label: 'Rents' },
  'Utilities - Home Office':       { line: '19', label: 'Other deductions — Utilities' },
  'Executive Wellness':            { line: '18', label: 'Employee benefit programs' },
  'Payroll - Salary':              { line: '7',  label: 'Compensation of officers' },
  'Business Services - Payroll':   { line: '19', label: 'Other deductions — Payroll services' },
  'Business Services - Software':  { line: '19', label: 'Other deductions — Software/subscriptions' },
  'Business Services - Other':     { line: '19', label: 'Other deductions — Business services' },
  'Telephone - Business Line':     { line: '19', label: 'Other deductions — Telephone' },
  'Bank Fees':                     { line: '19', label: 'Other deductions — Bank fees' },
  'Taxes - Payroll':               { line: '12', label: 'Taxes and licenses' },
  'Meals & Entertainment':         { line: '19', label: 'Other deductions — Meals (50% deductible)' },
  'Travel':                        { line: '19', label: 'Other deductions — Travel' },
  'Office Expenses':               { line: '19', label: 'Other deductions — Office expenses' },
  'Business Expenses - Other':     { line: '19', label: 'Other deductions — Other' },
}

export async function generate1120SWorkbook(
  db: CompatDb,
  inputs: ScorpInputs,
  outputPath: string
): Promise<{ file_path: string }> {
  const year = inputs.taxYear
  const dateFrom = `${year}-01-01`
  const dateTo = `${year}-12-31`

  // Pull all Moonsmoke LLC transactions for the tax year
  const txs = db.prepare(`
    SELECT t.llc_category, SUM(ABS(t.amount)) as total, COUNT(*) as cnt
    FROM transactions t
    WHERE t.bucket = 'Moonsmoke LLC'
      AND t.transaction_date >= ? AND t.transaction_date <= ?
      AND t.review_status IN ('auto_classified', 'manually_classified')
      AND NOT EXISTS (SELECT 1 FROM transactions c WHERE c.split_parent_id = t.id)
    GROUP BY t.llc_category
    ORDER BY t.llc_category
  `).all(dateFrom, dateTo) as Array<{ llc_category: string; total: number; cnt: number }>

  // Also pull detail rows for the statement attachment
  const detailTxs = db.prepare(`
    SELECT t.transaction_date, t.merchant_name, t.description_raw, t.llc_category,
           t.amount, t.description_notes, a.account_mask
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.bucket = 'Moonsmoke LLC'
      AND t.transaction_date >= ? AND t.transaction_date <= ?
      AND t.review_status IN ('auto_classified', 'manually_classified')
      AND NOT EXISTS (SELECT 1 FROM transactions c WHERE c.split_parent_id = t.id)
    ORDER BY t.transaction_date ASC
  `).all(dateFrom, dateTo) as Array<{
    transaction_date: string; merchant_name: string; description_raw: string;
    llc_category: string; amount: number; description_notes: string; account_mask: string
  }>

  // Build line-item totals
  const lineTotals: Record<string, { label: string; amount: number; categories: string[] }> = {}
  for (const tx of txs) {
    const mapping = LLC_TO_1120S[tx.llc_category] ?? { line: '19', label: `Other deductions — ${tx.llc_category}` }
    if (!lineTotals[mapping.line]) {
      lineTotals[mapping.line] = { label: mapping.label, amount: 0, categories: [] }
    }
    lineTotals[mapping.line].amount += tx.total
    if (!lineTotals[mapping.line].categories.includes(tx.llc_category)) {
      lineTotals[mapping.line].categories.push(tx.llc_category)
    }
  }

  const totalDeductions = Object.values(lineTotals).reduce((s, l) => s + l.amount, 0)
  const ordinaryIncome = inputs.grossReceipts + inputs.otherIncome - totalDeductions

  const wb = new ExcelJS.Workbook()
  wb.creator = 'McQuire Tracker'

  // ═══ Tab 1: Form 1120-S Summary ═══════════════════════════════════════
  const ws1 = wb.addWorksheet('1120-S')

  ws1.getColumn(1).width = 10
  ws1.getColumn(2).width = 50
  ws1.getColumn(3).width = 18
  ws1.getColumn(4).width = 30

  // Title
  ws1.mergeCells('A1:D1')
  const title1 = ws1.getCell('A1')
  title1.value = `IRS Form 1120-S — Moonsmoke LLC — Tax Year ${year}`
  title1.font = { name: 'Arial', size: 14, bold: true, color: { argb: NAVY } }
  title1.alignment = { horizontal: 'center' }
  ws1.getRow(1).height = 28

  ws1.mergeCells('A2:D2')
  ws1.getCell('A2').value = 'S Corporation Income Tax Return — Auto-generated from McQuire Tracker'
  ws1.getCell('A2').font = { name: 'Arial', size: 9, italic: true, color: { argb: '666666' } }
  ws1.getCell('A2').alignment = { horizontal: 'center' }

  // Headers
  const hdr = ws1.getRow(4)
  ;['Line', 'Description', 'Amount', 'Source Categories'].forEach((h, i) => {
    const cell = hdr.getCell(i + 1)
    cell.value = h
    allBorders(cell)
  })
  headerStyle(ws1, hdr)

  // Income section
  let row = 5
  const addLine = (line: string, desc: string, amount: number | null, note?: string) => {
    const r = ws1.getRow(row)
    r.getCell(1).value = line; r.getCell(1).font = { name: 'Arial', size: 9, bold: true }
    r.getCell(2).value = desc; r.getCell(2).font = { name: 'Arial', size: 9 }
    if (amount !== null) {
      r.getCell(3).value = amount
      r.getCell(3).numFmt = '$#,##0.00'
      r.getCell(3).alignment = { horizontal: 'right' }
    }
    r.getCell(3).font = { name: 'Arial', size: 9 }
    r.getCell(4).value = note ?? ''; r.getCell(4).font = { name: 'Arial', size: 8, italic: true, color: { argb: '888888' } }
    r.eachCell(c => allBorders(c))
    dataRow(r, row % 2 === 0)
    row++
  }

  // Section: Income
  const sectionRow = ws1.getRow(row)
  ws1.mergeCells(`A${row}:D${row}`)
  sectionRow.getCell(1).value = 'INCOME'
  sectionRow.getCell(1).font = { name: 'Arial', size: 10, bold: true, color: { argb: WHITE } }
  sectionRow.getCell(1).fill = navyFill()
  sectionRow.getCell(1).alignment = { horizontal: 'center' }
  sectionRow.eachCell(c => allBorders(c))
  row++

  addLine('1a', 'Gross receipts or sales', inputs.grossReceipts, 'Manual entry')
  addLine('5', 'Other income', inputs.otherIncome, 'Manual entry')
  addLine('6', 'Total income (1a + 5)', inputs.grossReceipts + inputs.otherIncome)

  // Section: Deductions
  const dedRow = ws1.getRow(row)
  ws1.mergeCells(`A${row}:D${row}`)
  dedRow.getCell(1).value = 'DEDUCTIONS'
  dedRow.getCell(1).font = { name: 'Arial', size: 10, bold: true, color: { argb: WHITE } }
  dedRow.getCell(1).fill = navyFill()
  dedRow.getCell(1).alignment = { horizontal: 'center' }
  dedRow.eachCell(c => allBorders(c))
  row++

  // Line 7: Officer compensation (from payroll or manual input)
  const payrollFromTx = lineTotals['7']?.amount ?? 0
  const officerComp = inputs.officerCompensation || payrollFromTx
  addLine('7', 'Compensation of officers', officerComp, payrollFromTx > 0 ? `From transactions: ${lineTotals['7']?.categories.join(', ')}` : 'Manual entry')

  // Line 11: Rents
  if (lineTotals['11']) addLine('11', 'Rents', lineTotals['11'].amount, lineTotals['11'].categories.join(', '))

  // Line 12: Taxes and licenses
  if (lineTotals['12']) addLine('12', 'Taxes and licenses', lineTotals['12'].amount, lineTotals['12'].categories.join(', '))

  // Line 18: Employee benefit programs
  if (lineTotals['18']) addLine('18', 'Employee benefit programs', lineTotals['18'].amount, lineTotals['18'].categories.join(', '))

  // Line 19: Other deductions (itemized)
  const line19Total = lineTotals['19']?.amount ?? 0
  if (line19Total > 0) {
    addLine('19', 'Other deductions (see attached statement)', line19Total, lineTotals['19']?.categories.join(', '))

    // Sub-itemize line 19 by category
    for (const tx of txs) {
      const mapping = LLC_TO_1120S[tx.llc_category]
      if (mapping?.line === '19') {
        addLine('', `    ${mapping.label}`, tx.total, `${tx.cnt} transactions`)
      }
    }

    // Meals at 50%
    const mealsEntry = txs.find(t => t.llc_category === 'Meals & Entertainment')
    if (mealsEntry) {
      addLine('', '    ↳ Meals 50% deductible amount', mealsEntry.total * 0.5, 'IRS limits meals deduction to 50%')
    }
  }

  // Totals
  addLine('20', 'Total deductions', totalDeductions)
  row++
  addLine('21', 'Ordinary business income (loss)', ordinaryIncome)

  // Section: Balance Sheet (Schedule L)
  row += 2
  const bsRow = ws1.getRow(row)
  ws1.mergeCells(`A${row}:D${row}`)
  bsRow.getCell(1).value = 'SCHEDULE L — BALANCE SHEET (simplified)'
  bsRow.getCell(1).font = { name: 'Arial', size: 10, bold: true, color: { argb: WHITE } }
  bsRow.getCell(1).fill = navyFill()
  bsRow.getCell(1).alignment = { horizontal: 'center' }
  bsRow.eachCell(c => allBorders(c))
  row++
  addLine('', 'Cash — beginning of year', inputs.beginningCash, 'Manual entry')
  addLine('', 'Cash — end of year', inputs.endingCash, 'Manual entry')
  addLine('', 'Distributions to shareholders', inputs.distributions, 'Manual entry')

  // ═══ Tab 2: Schedule K-1 ══════════════════════════════════════════════
  const ws2 = wb.addWorksheet('K-1')
  ws2.getColumn(1).width = 10
  ws2.getColumn(2).width = 50
  ws2.getColumn(3).width = 18

  ws2.mergeCells('A1:C1')
  ws2.getCell('A1').value = `Schedule K-1 (Form 1120-S) — Moonsmoke LLC — Tax Year ${year}`
  ws2.getCell('A1').font = { name: 'Arial', size: 14, bold: true, color: { argb: NAVY } }
  ws2.getCell('A1').alignment = { horizontal: 'center' }
  ws2.getRow(1).height = 28

  ws2.mergeCells('A2:C2')
  ws2.getCell('A2').value = "Shareholder's Share of Income, Deductions, Credits — Kyle McQuire (100%)"
  ws2.getCell('A2').font = { name: 'Arial', size: 9, italic: true, color: { argb: '666666' } }
  ws2.getCell('A2').alignment = { horizontal: 'center' }

  const k1hdr = ws2.getRow(4)
  ;['Box', 'Description', 'Amount'].forEach((h, i) => {
    k1hdr.getCell(i + 1).value = h
    allBorders(k1hdr.getCell(i + 1))
  })
  headerStyle(ws2, k1hdr)

  let k1row = 5
  const addK1 = (box: string, desc: string, amount: number) => {
    const r = ws2.getRow(k1row)
    r.getCell(1).value = box; r.getCell(1).font = { name: 'Arial', size: 9, bold: true }
    r.getCell(2).value = desc; r.getCell(2).font = { name: 'Arial', size: 9 }
    r.getCell(3).value = amount; r.getCell(3).numFmt = '$#,##0.00'
    r.getCell(3).font = { name: 'Arial', size: 9 }
    r.getCell(3).alignment = { horizontal: 'right' }
    r.eachCell(c => allBorders(c))
    dataRow(r, k1row % 2 === 0)
    k1row++
  }

  addK1('1', 'Ordinary business income (loss)', ordinaryIncome)
  addK1('16d', 'Distributions', inputs.distributions)

  // ═══ Tab 3: Transaction Detail (attached statement for Line 19) ═══════
  const ws3 = wb.addWorksheet('Transaction Detail')
  ws3.getColumn(1).width = 12
  ws3.getColumn(2).width = 28
  ws3.getColumn(3).width = 28
  ws3.getColumn(4).width = 14
  ws3.getColumn(5).width = 10
  ws3.getColumn(6).width = 30

  ws3.mergeCells('A1:F1')
  ws3.getCell('A1').value = `Moonsmoke LLC — Expense Detail — ${year}`
  ws3.getCell('A1').font = { name: 'Arial', size: 12, bold: true, color: { argb: NAVY } }
  ws3.getCell('A1').alignment = { horizontal: 'center' }
  ws3.getRow(1).height = 24

  const detHdr = ws3.getRow(2)
  ;['Date', 'Category', 'Merchant', 'Amount', 'Card', 'Notes'].forEach((h, i) => {
    detHdr.getCell(i + 1).value = h
    allBorders(detHdr.getCell(i + 1))
  })
  headerStyle(ws3, detHdr)

  let detTotal = 0
  detailTxs.forEach((tx, idx) => {
    const r = ws3.getRow(idx + 3)
    ;[tx.transaction_date, tx.llc_category ?? '', tx.merchant_name ?? tx.description_raw,
      Math.abs(tx.amount), `···${tx.account_mask ?? ''}`, tx.description_notes ?? ''].forEach((v, i) => {
      const cell = r.getCell(i + 1)
      cell.value = v
      if (i === 3) { cell.numFmt = '$#,##0.00'; cell.alignment = { horizontal: 'right' } }
    })
    dataRow(r, idx % 2 === 0)
    detTotal += Math.abs(tx.amount)
  })

  const dtRow = ws3.getRow(detailTxs.length + 3)
  ws3.mergeCells(`A${detailTxs.length + 3}:C${detailTxs.length + 3}`)
  dtRow.getCell(1).value = 'TOTAL'
  dtRow.getCell(1).font = { name: 'Arial', size: 10, bold: true }
  dtRow.getCell(1).alignment = { horizontal: 'right' }
  dtRow.getCell(4).value = detTotal
  dtRow.getCell(4).numFmt = '$#,##0.00'
  dtRow.getCell(4).font = { name: 'Arial', size: 10, bold: true }

  await wb.xlsx.writeFile(outputPath)
  return { file_path: outputPath }
}
