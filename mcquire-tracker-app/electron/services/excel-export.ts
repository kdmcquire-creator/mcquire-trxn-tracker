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
  outputPath: string
): Promise<{ file_path: string; total: number; count: number }> {

  const alreadyReimbursedThrough = db.prepare("SELECT value FROM settings WHERE key='peak10_already_reimbursed_through'").get() as { value: string } | undefined
  const cutoff = alreadyReimbursedThrough?.value ?? '2025-11-30'

  const txs = db.prepare(`
    SELECT t.*, a.account_name, a.account_mask, a.institution
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.bucket = 'Peak 10'
      AND t.transaction_date >= ?
      AND t.transaction_date <= ?
      AND t.transaction_date > ?
      AND t.review_status IN ('auto_classified','manually_classified')
      AND t.expense_report_id IS NULL
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

  // Mark transactions as included in this report
  const reportId = require('uuid').v4()
  db.prepare("INSERT INTO expense_reports (id, report_period, date_generated, file_path, status, total_amount, transaction_count) VALUES (?,?,datetime('now'),?,'draft',?,?)")
    .run(reportId, periodLabel, outputPath, total, txs.length)
  const upd = db.prepare("UPDATE transactions SET expense_report_id = ? WHERE id = ?")
  db.transaction(() => txs.forEach(tx => upd.run(reportId, tx.id)))()

  return { file_path: outputPath, total, count: txs.length }
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
  const missingDesc = db.prepare(`
    SELECT COUNT(*) as c FROM transactions t
    WHERE t.bucket='Peak 10'
    AND t.p10_category IN ('Meals & Meetings - external','Meals & Meetings - internal','Meals & Meetings - internal and external mixed attendees')
    AND (t.description_notes IS NULL OR t.description_notes = '')
    AND t.transaction_date >= ? AND t.transaction_date <= ?
    AND t.review_status IN ('auto_classified','manually_classified')
    AND NOT EXISTS (SELECT 1 FROM transactions c WHERE c.split_parent_id = t.id)
  `).get(dateFrom, dateTo) as { c: number }
  if (missingDesc.c > 0) {
    blocking.push(`${missingDesc.c} Meals & Meetings transactions missing attendee names in Description/Notes`)
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
