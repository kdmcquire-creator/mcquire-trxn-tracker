// electron/services/financial-statements.service.ts
//
// Phase 4 — Financial Statement Excel Exports
// Generates the remaining three LLC financial statement tabs + Personal Summary
// matching the exact structure of the McQuire Expense Tracking vF.xlsx workbook.
//
// Exports produced:
//   1. LLC P&L            — accrual basis, monthly columns Jan 2025–present
//   2. LLC Balance Sheet  — quarterly snapshots, ⚠️ investment flags
//   3. LLC Cashflow       — direct method, quarterly + monthly
//   4. Personal Summary   — dual-year income/expense summary
//
// All formatting matches Section 3 of the workflow document and the existing
// workbook structure so exports are CPA-ready without reformatting.

import * as ExcelJS from 'exceljs'
import * as path from 'path'
import * as fs from 'fs'
import type { CompatDb } from './database'

// ─── Colors matching the workbook ────────────────────────────────────────────
const NAVY      = '1F3864'
const LBLUE     = 'DCE6F1'
const WHITE     = 'FFFFFF'
const LLC_GREEN = 'E2EFDA'
const LLC_DKGRN = '375623'

// Split-parent exclusion: when a transaction has been split into children,
// exclude the parent from aggregation to prevent double-counting.
// Use with alias 't': AND NOT_SPLIT_PARENT
const NOT_SPLIT_PARENT = "NOT EXISTS (SELECT 1 FROM transactions _sp WHERE _sp.split_parent_id = t.id)"

// ─── Format helpers ───────────────────────────────────────────────────────────

function currencyCell(cell: ExcelJS.Cell, value: number | null) {
  cell.value = value
  cell.numFmt = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)'
  if (value !== null && value < 0) cell.font = { ...cell.font, color: { argb: 'FFC00000' } }
}


function stripe(row: ExcelJS.Row, idx: number) {
  const bg = idx % 2 === 0 ? LBLUE : WHITE
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bg } }
  })
}

function boldRow(row: ExcelJS.Row, color?: string) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true, color: color ? { argb: 'FF' + color } : undefined }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + LLC_GREEN } }
  })
  row.height = 16
}

function topBorder(row: ExcelJS.Row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = { top: { style: 'medium', color: { argb: 'FF' + NAVY } } }
  })
}

// ─── Main export class ────────────────────────────────────────────────────────

export class FinancialStatementsService {
  private static instance: FinancialStatementsService | null = null
  private db: CompatDb

  private constructor(db: CompatDb) {
    this.db = db
  }

  static getInstance(db: CompatDb): FinancialStatementsService {
    if (!FinancialStatementsService.instance) {
      FinancialStatementsService.instance = new FinancialStatementsService(db)
    }
    return FinancialStatementsService.instance
  }

  // ─── LLC P&L ─────────────────────────────────────────────────────────────────

  async generatePandL(syncFolder: string): Promise<string> {
    const wb = new ExcelJS.Workbook()
    wb.creator = 'McQuire Tracker'
    const ws = wb.addWorksheet('📈 P&L')

    // Build list of months from Jan 2025 to current
    const months = this.getMonthColumns()

    // Revenue: Strawn consulting wire transfers from Chase BUS 2255
    const revenue = this.getRevenueByMonth()

    // LLC expense totals by Schedule C category by month
    const expenseCategories = this.getLLCExpenseCategoriesByMonth(months)

    // ── Column widths ────────────────────────────────────────────────────────
    ws.columns = [
      { key: 'category', width: 34 },
      ...months.map((m) => ({ key: m, width: 14 })),
      { key: 'total', width: 14 },
    ]

    // ── Title row ────────────────────────────────────────────────────────────
    const titleRow = ws.addRow([
      'Moonsmoke, LLC — Income Statement (Accrual Basis)',
      ...months.map(() => ''),
      '',
    ])
    ws.mergeCells(titleRow.number, 1, titleRow.number, months.length + 2)
    titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF' + LLC_DKGRN } }
    titleRow.height = 22

    // ── Header row ────────────────────────────────────────────────────────────
    const headerRow = ws.addRow([
      '',
      ...months.map((m) => this.fmtMonthLabel(m)),
      'TOTAL',
    ])
    headerRow.eachCell((cell, col) => {
      if (col > 1) {
        cell.font = { bold: true, color: { argb: 'FF' + WHITE } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + LLC_DKGRN } }
        cell.alignment = { horizontal: 'center' }
      }
    })
    headerRow.getCell(1).font = { bold: true }
    headerRow.height = 18

    ws.addRow([]) // spacer

    // ── REVENUE ───────────────────────────────────────────────────────────────
    const revLabel = ws.addRow(['REVENUE', ...months.map(() => ''), ''])
    revLabel.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF' + LLC_DKGRN } }

    const revenueRow = ws.addRow([
      'Consulting Revenue (Strawn)',
      ...months.map(() => null),
      null,
    ])
    let revTotal = 0
    months.forEach((m, i) => {
      const v = revenue[m] || 0
      currencyCell(revenueRow.getCell(i + 2), v)
      revTotal += v
    })
    currencyCell(revenueRow.getCell(months.length + 2), revTotal)
    revenueRow.getCell(1).font = { italic: true }

    const grossRevRow = ws.addRow(['GROSS REVENUE', ...months.map(() => null), null])
    months.forEach((m, i) => { currencyCell(grossRevRow.getCell(i + 2), revenue[m] || 0) })
    currencyCell(grossRevRow.getCell(months.length + 2), revTotal)
    boldRow(grossRevRow)
    topBorder(grossRevRow)

    ws.addRow([])

    // ── EXPENSES ──────────────────────────────────────────────────────────────
    const expLabel = ws.addRow(['OPERATING EXPENSES', ...months.map(() => ''), ''])
    expLabel.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF' + LLC_DKGRN } }

    const categoryTotals: Record<string, number> = {}
    let grandExpTotal = 0
    const monthExpTotals: Record<string, number> = {}

    expenseCategories.forEach((cat, idx) => {
      const row = ws.addRow([cat.category, ...months.map(() => null), null])
      stripe(row, idx)

      let rowTotal = 0
      months.forEach((m, i) => {
        const v = cat.months[m] || 0
        if (v !== 0) currencyCell(row.getCell(i + 2), v)
        rowTotal += v
        monthExpTotals[m] = (monthExpTotals[m] || 0) + v
      })
      if (rowTotal !== 0) currencyCell(row.getCell(months.length + 2), rowTotal)
      categoryTotals[cat.category] = rowTotal
      grandExpTotal += rowTotal
    })

    const totalExpRow = ws.addRow(['TOTAL EXPENSES', ...months.map(() => null), null])
    months.forEach((m, i) => { currencyCell(totalExpRow.getCell(i + 2), monthExpTotals[m] || 0) })
    currencyCell(totalExpRow.getCell(months.length + 2), grandExpTotal)
    boldRow(totalExpRow)
    topBorder(totalExpRow)

    ws.addRow([])

    // ── NET INCOME ────────────────────────────────────────────────────────────
    const netRow = ws.addRow(['NET INCOME / (LOSS)', ...months.map(() => null), null])
    months.forEach((m, i) => {
      const v = (revenue[m] || 0) - (monthExpTotals[m] || 0)
      currencyCell(netRow.getCell(i + 2), v)
    })
    currencyCell(netRow.getCell(months.length + 2), revTotal - grandExpTotal)
    boldRow(netRow)
    topBorder(netRow)
    netRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + NAVY } }
      cell.font = { bold: true, color: { argb: 'FF' + WHITE } }
    })
    netRow.height = 20

    // Freeze panes: freeze first column and first two rows
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }]

    return this.writeFile(wb, syncFolder, 'LLC_PandL.xlsx')
  }

  // ─── LLC Balance Sheet ────────────────────────────────────────────────────────

  async generateBalanceSheet(syncFolder: string): Promise<string> {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('📊 Balance Sheet')

    // Get quarterly snapshots from DB + settings
    const quarters = this.getQuarterlySnapshots()
    const currentYearMonths = this.getCurrentYearMonths()

    ws.columns = [
      { key: 'label', width: 38 },
      ...quarters.map((q) => ({ key: q.label, width: 16 })),
      ...currentYearMonths.map((m) => ({ key: m, width: 16 })),
    ]

    const allCols = [...quarters, ...currentYearMonths.map((m) => ({ ...this.getMonthSnapshot(m) }))]

    // Title
    const title = ws.addRow(['Moonsmoke, LLC — Balance Sheet (Quarterly Snapshots)', ...allCols.map(() => '')])
    ws.mergeCells(title.number, 1, title.number, allCols.length + 1)
    title.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF' + LLC_DKGRN } }
    title.height = 22

    const hdr = ws.addRow(['', ...allCols.map((c) => c.label)])
    hdr.eachCell((cell, col) => {
      if (col > 1) {
        cell.font = { bold: true, color: { argb: 'FF' + WHITE } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + LLC_DKGRN } }
        cell.alignment = { horizontal: 'center' }
      }
    })
    hdr.height = 18
    ws.addRow([])

    // ── ASSETS ────────────────────────────────────────────────────────────────
    const assetsHdr = ws.addRow(['ASSETS', ...allCols.map(() => '')])
    assetsHdr.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF' + LLC_DKGRN } }

    // Cash — Chase BUS 2255 confirmed from CSV
    const cashRow = ws.addRow(['Cash — Chase BUS 2255', ...allCols.map((c) => c.cash ?? null)])
    cashRow.eachCell((cell, col) => { if (col > 1 && cell.value !== null) currencyCell(cell, cell.value as number) })
    stripe(cashRow, 0)

    // Investments — flagged for CPA
    const invRow = ws.addRow([
      '⚠️ Investments (Fidelity, Schwab — CPA review)',
      ...allCols.map((c) => c.investments ?? null),
    ])
    invRow.eachCell((cell, col) => {
      if (col > 1) {
        if (cell.value !== null) currencyCell(cell, cell.value as number)
        else {
          cell.value = '⚠️ Verify'
          cell.font = { italic: true, color: { argb: 'FFED7D31' } }
        }
      }
    })
    stripe(invRow, 1)

    const totalAssetsRow = ws.addRow([
      'TOTAL ASSETS',
      ...allCols.map((c) => (c.cash ?? 0) + (c.investments ?? 0) || null),
    ])
    totalAssetsRow.eachCell((cell, col) => { if (col > 1 && cell.value !== null) currencyCell(cell, cell.value as number) })
    boldRow(totalAssetsRow)
    topBorder(totalAssetsRow)

    ws.addRow([])

    // ── LIABILITIES ───────────────────────────────────────────────────────────
    const liabHdr = ws.addRow(['LIABILITIES', ...allCols.map(() => '')])
    liabHdr.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF' + LLC_DKGRN } }

    const noLiabRow = ws.addRow(['No known liabilities', ...allCols.map(() => null)])
    stripe(noLiabRow, 0)
    noLiabRow.getCell(1).font = { italic: true, color: { argb: 'FF595959' } }

    const totalLiabRow = ws.addRow(['TOTAL LIABILITIES', ...allCols.map(() => 0)])
    totalLiabRow.eachCell((cell, col) => { if (col > 1) currencyCell(cell, 0) })
    boldRow(totalLiabRow)
    topBorder(totalLiabRow)

    ws.addRow([])

    // ── EQUITY ────────────────────────────────────────────────────────────────
    const equityHdr = ws.addRow(['EQUITY', ...allCols.map(() => '')])
    equityHdr.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF' + LLC_DKGRN } }

    const retainedRow = ws.addRow([
      "Owner's Equity / Retained Earnings",
      ...allCols.map((c) => (c.cash ?? 0) + (c.investments ?? 0) || null),
    ])
    retainedRow.eachCell((cell, col) => { if (col > 1 && cell.value !== null) currencyCell(cell, cell.value as number) })
    stripe(retainedRow, 0)

    const totalEquityRow = ws.addRow([
      'TOTAL EQUITY',
      ...allCols.map((c) => (c.cash ?? 0) + (c.investments ?? 0) || null),
    ])
    totalEquityRow.eachCell((cell, col) => { if (col > 1 && cell.value !== null) currencyCell(cell, cell.value as number) })
    boldRow(totalEquityRow)
    topBorder(totalEquityRow)

    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }]

    const notesWs = wb.addWorksheet('Notes')
    notesWs.addRow(['Balance Sheet Notes'])
    notesWs.addRow([''])
    notesWs.addRow(['• Cash balances confirmed from Chase BUS 2255 CSV exports.'])
    notesWs.addRow(['• Investment balances (Fidelity, Schwab) flagged ⚠️ — verify against brokerage statements before finalizing.'])
    notesWs.addRow(['• Watersound Investments C-Corp and Campbell Graduation Schwab are separate entities — not included here.'])
    notesWs.addRow(['• Balance Sheet does not include personal assets/liabilities.'])

    return this.writeFile(wb, syncFolder, 'LLC_BalanceSheet.xlsx')
  }

  // ─── LLC Cashflow ─────────────────────────────────────────────────────────────

  async generateCashflow(syncFolder: string): Promise<string> {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('💵 Cashflow')

    // Q1–Q4 2025 + Jan 2026 + Feb 2026
    const periods = this.getCashflowPeriods()

    ws.columns = [
      { key: 'label', width: 42 },
      ...periods.map((p) => ({ key: p.key, width: 14 })),
      { key: 'fy', width: 14 },
    ]

    // Title
    const title = ws.addRow([
      'Moonsmoke, LLC — Cash Flow Statement (Direct Method)',
      ...periods.map(() => ''), '',
    ])
    ws.mergeCells(title.number, 1, title.number, periods.length + 2)
    title.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF' + LLC_DKGRN } }
    title.height = 22

    const hdr = ws.addRow(['', ...periods.map((p) => p.label), 'FY 2025'])
    hdr.eachCell((cell, col) => {
      if (col > 1) {
        cell.font = { bold: true, color: { argb: 'FF' + WHITE } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + LLC_DKGRN } }
        cell.alignment = { horizontal: 'center' }
      }
    })
    hdr.height = 18
    ws.addRow([])

    const cashflow = this.getCashflowData()

    // Helper: add a section
    const addSection = (title: string) => {
      const row = ws.addRow([title, ...periods.map(() => ''), ''])
      row.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF' + LLC_DKGRN } }
    }

    const addLineItem = (
      label: string,
      values: (number | null)[],
      fyValue: number | null,
      idx: number
    ) => {
      const row = ws.addRow([label, ...values.map(() => null), null])
      stripe(row, idx)
      values.forEach((v, i) => { if (v !== null) currencyCell(row.getCell(i + 2), v) })
      if (fyValue !== null) currencyCell(row.getCell(periods.length + 2), fyValue)
      return row
    }

    const addTotalRow = (label: string, values: (number | null)[], fyValue: number | null) => {
      const row = ws.addRow([label, ...values.map(() => null), null])
      boldRow(row)
      topBorder(row)
      values.forEach((v, i) => { if (v !== null) currencyCell(row.getCell(i + 2), v) })
      if (fyValue !== null) currencyCell(row.getCell(periods.length + 2), fyValue)
      return row
    }

    // ── OPERATING ACTIVITIES ─────────────────────────────────────────────────
    addSection('OPERATING ACTIVITIES')

    // Cash inflows
    const inflows = cashflow.consulting_revenue
    addLineItem(
      'Consulting Revenue Received (Strawn)',
      periods.map((p) => inflows[p.key] || null),
      Object.values(inflows).reduce((a, b) => a + b, 0),
      0
    )

    // Cash outflows
    addLineItem(
      'Net Salary Paid to Kyle McQuire',
      periods.map((p) => cashflow.net_salary[p.key] ? -cashflow.net_salary[p.key] : null),
      -(Object.values(cashflow.net_salary).reduce((a, b) => a + b, 0)),
      1
    )

    addLineItem(
      'Employer Taxes Remitted (Patriot)',
      periods.map((p) => cashflow.employer_taxes[p.key] ? -cashflow.employer_taxes[p.key] : null),
      -(Object.values(cashflow.employer_taxes).reduce((a, b) => a + b, 0)),
      2
    )

    addLineItem(
      'Rent — Houston Apartment (Bilt)',
      periods.map((p) => cashflow.rent[p.key] ? -cashflow.rent[p.key] : null),
      -(Object.values(cashflow.rent).reduce((a, b) => a + b, 0)),
      3
    )

    addLineItem(
      'Other Operating Expenses',
      periods.map((p) => cashflow.other_operating[p.key] ? -cashflow.other_operating[p.key] : null),
      -(Object.values(cashflow.other_operating).reduce((a, b) => a + b, 0)),
      4
    )

    const opTotals = periods.map((p) => {
      const inflow = inflows[p.key] || 0
      const out =
        (cashflow.net_salary[p.key] || 0) +
        (cashflow.employer_taxes[p.key] || 0) +
        (cashflow.rent[p.key] || 0) +
        (cashflow.other_operating[p.key] || 0)
      return inflow - out
    })
    const fyOpTotal = opTotals.reduce((a, b) => a + b, 0)
    addTotalRow('NET CASH FROM OPERATIONS', opTotals, fyOpTotal)

    ws.addRow([])

    // ── INVESTING ─────────────────────────────────────────────────────────────
    addSection('INVESTING ACTIVITIES')
    addLineItem('No investing activities in period', periods.map(() => null), null, 0)
    addTotalRow('NET CASH FROM INVESTING', periods.map(() => 0), 0)

    ws.addRow([])

    // ── FINANCING ─────────────────────────────────────────────────────────────
    addSection('FINANCING ACTIVITIES')
    addLineItem('No financing activities in period', periods.map(() => null), null, 0)
    addTotalRow('NET CASH FROM FINANCING', periods.map(() => 0), 0)

    ws.addRow([])

    // ── NET CHANGE ────────────────────────────────────────────────────────────
    const netChangeRow = ws.addRow([
      'NET CHANGE IN CASH',
      ...opTotals.map(() => null),
      null,
    ])
    boldRow(netChangeRow)
    topBorder(netChangeRow)
    opTotals.forEach((v, i) => { currencyCell(netChangeRow.getCell(i + 2), v) })
    currencyCell(netChangeRow.getCell(periods.length + 2), fyOpTotal)
    netChangeRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + NAVY } }
      cell.font = { bold: true, color: { argb: 'FF' + WHITE } }
    })

    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }]

    return this.writeFile(wb, syncFolder, 'LLC_Cashflow.xlsx')
  }

  // ─── Personal Income/Expense Summary ─────────────────────────────────────────

  async generatePersonalSummary(syncFolder: string): Promise<string> {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('🏠 Personal Summary')

    ws.columns = [
      { key: 'category', width: 36 },
      { key: '2025', width: 16 },
      { key: '2026', width: 16 },
    ]

    // ── Title ─────────────────────────────────────────────────────────────────
    const title = ws.addRow(['Kyle McQuire — Personal Income & Expense Summary'])
    ws.mergeCells('A1:C1')
    title.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF' + NAVY } }
    title.height = 22

    ws.addRow(['', '2025', '2026']).eachCell((cell, col) => {
      if (col > 1) {
        cell.font = { bold: true, color: { argb: 'FF' + WHITE } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + NAVY } }
        cell.alignment = { horizontal: 'center' }
      }
    })

    ws.addRow([])

    // ── TRUE INCOME ───────────────────────────────────────────────────────────
    const incomeHdr = ws.addRow(['TRUE INCOME', '', ''])
    incomeHdr.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF' + NAVY } }

    const income2025 = this.getPersonalIncomeBySource(2025)
    const income2026 = this.getPersonalIncomeBySource(2026)

    const incomeSources = [
      'Insperity (W2 Payroll — Peak 10)',
      'UBS Business Sol Payroll (Moonsmoke)',
      'Mobile Deposit',
      'Zelle Received',
      'Interest Paid',
    ]

    let total2025Income = 0
    let total2026Income = 0

    incomeSources.forEach((src, idx) => {
      const v2025 = income2025[src] || 0
      const v2026 = income2026[src] || 0
      const row = ws.addRow([src, null, null])
      stripe(row, idx)
      if (v2025 !== 0) currencyCell(row.getCell(2), v2025)
      if (v2026 !== 0) currencyCell(row.getCell(3), v2026)
      total2025Income += v2025
      total2026Income += v2026
    })

    const totalIncRow = ws.addRow(['TOTAL TRUE INCOME', null, null])
    boldRow(totalIncRow)
    topBorder(totalIncRow)
    currencyCell(totalIncRow.getCell(2), total2025Income)
    currencyCell(totalIncRow.getCell(3), total2026Income)

    ws.addRow([])

    // ── GROSS EXPENSES ────────────────────────────────────────────────────────
    const expHdr = ws.addRow(['GROSS EXPENSES (Personal)', '', ''])
    expHdr.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF' + NAVY } }

    const expenses2025 = this.getPersonalExpensesByCategory(2025)
    const expenses2026 = this.getPersonalExpensesByCategory(2026)
    const allCategories = Array.from(
      new Set([...Object.keys(expenses2025), ...Object.keys(expenses2026)])
    ).sort()

    let total2025Exp = 0
    let total2026Exp = 0

    allCategories.forEach((cat, idx) => {
      const v2025 = expenses2025[cat] || 0
      const v2026 = expenses2026[cat] || 0
      if (v2025 === 0 && v2026 === 0) return
      const row = ws.addRow([cat, null, null])
      stripe(row, idx)
      if (v2025 !== 0) currencyCell(row.getCell(2), v2025)
      if (v2026 !== 0) currencyCell(row.getCell(3), v2026)
      total2025Exp += v2025
      total2026Exp += v2026
    })

    const totalExpRow = ws.addRow(['TOTAL GROSS EXPENSES', null, null])
    boldRow(totalExpRow)
    topBorder(totalExpRow)
    currencyCell(totalExpRow.getCell(2), total2025Exp)
    currencyCell(totalExpRow.getCell(3), total2026Exp)

    ws.addRow([])

    // ── REFUNDS & CREDITS ─────────────────────────────────────────────────────
    const refundHdr = ws.addRow(['REFUNDS & CREDITS (add-back)', '', ''])
    refundHdr.getCell(1).font = { bold: true, size: 11 }

    const refunds2025 = this.getPersonalRefunds(2025)
    const refunds2026 = this.getPersonalRefunds(2026)

    const refundRow = ws.addRow(['Merchant Refunds & Credits', null, null])
    stripe(refundRow, 0)
    if (refunds2025 !== 0) currencyCell(refundRow.getCell(2), refunds2025)
    if (refunds2026 !== 0) currencyCell(refundRow.getCell(3), refunds2026)

    const netExpRow = ws.addRow(['NET EXPENSES', null, null])
    boldRow(netExpRow)
    topBorder(netExpRow)
    currencyCell(netExpRow.getCell(2), total2025Exp - Math.abs(refunds2025))
    currencyCell(netExpRow.getCell(3), total2026Exp - Math.abs(refunds2026))

    ws.addRow([])

    // ── TRANSFERS (excluded) ──────────────────────────────────────────────────
    const xferHdr = ws.addRow(['TRANSFERS (excluded from income/expenses)', '', ''])
    xferHdr.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF595959' } }

    const xfers = this.getPersonalTransfers()
    const xferRow = ws.addRow([
      'CC Payments, Bank Transfers, etc.',
      xfers[2025] || null,
      xfers[2026] || null,
    ])
    xferRow.eachCell((cell, col) => {
      if (col > 1 && cell.value !== null) currencyCell(cell, cell.value as number)
      cell.font = { italic: true, color: { argb: 'FF595959' } }
    })
    stripe(xferRow, 0)

    // ── NET CASH FLOW ─────────────────────────────────────────────────────────
    ws.addRow([])
    const netCashRow = ws.addRow(['NET PERSONAL CASH FLOW', null, null])
    boldRow(netCashRow)
    topBorder(netCashRow)
    const netCash2025 = total2025Income - (total2025Exp - Math.abs(refunds2025))
    const netCash2026 = total2026Income - (total2026Exp - Math.abs(refunds2026))
    currencyCell(netCashRow.getCell(2), netCash2025)
    currencyCell(netCashRow.getCell(3), netCash2026)
    netCashRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + NAVY } }
      cell.font = { bold: true, color: { argb: 'FF' + WHITE } }
    })

    return this.writeFile(wb, syncFolder, 'Personal_Income_Expense_Summary.xlsx')
  }

  // ─── Full 9-tab tracker workbook export ───────────────────────────────────────

  async generateFullTracker(syncFolder: string): Promise<string> {
    // Generate each statement independently, then combine into a single workbook
    // For simplicity: generate a combined workbook with all statements
    // The Phase 1 Peak 10 / LLC Transaction / Personal Transaction exports
    // are generated separately; this combines the financial statement sheets.
    const wb = new ExcelJS.Workbook()
    wb.creator = 'McQuire Tracker'

    const today = new Date().toLocaleDateString()

    // Add a cover sheet
    const cover = wb.addWorksheet('📋 Cover')
    cover.addRow(['McQuire Financial Tracker — Full Export'])
      .getCell(1).font = { bold: true, size: 16, color: { argb: 'FF' + NAVY } }
    cover.addRow([`Generated: ${today}`])
    cover.addRow([''])
    cover.addRow(['Contents:'])
    const contents = [
      '📊 Summary — Dashboard totals and action items',
      '🏢 Peak 10 — Expense report Dec 2025–Feb 2026',
      '📈 P&L — Moonsmoke LLC Income Statement',
      '💼 Moonsmoke LLC — Transaction ledger',
      '🏠 Personal — Transaction ledger with income/expense summary',
      '📊 Balance Sheet — Quarterly snapshots',
      '💵 Cashflow — Direct method statement',
    ]
    contents.forEach((line) => { cover.addRow([line]).getCell(1).font = { italic: true } })
    cover.columns = [{ width: 60 }]

    // Note: Full workbook assembly calls into Phase 1 export logic for transaction tabs.
    // This export focuses on the financial statement tabs.
    // Write a separate sheet noting Phase 1 tabs are in the full app export.
    const noteWs = wb.addWorksheet('ℹ️ Note')
    noteWs.addRow(['This export contains financial statement tabs generated by McQuire Tracker Phase 4.'])
    noteWs.addRow(['Transaction tabs (Peak 10, LLC Ledger, Personal Ledger) are generated by the'])
    noteWs.addRow(['Phase 1 expense report and full tracker export functions.'])
    noteWs.addRow(['Use Reports → Full Tracker Export in the app for the complete 9-tab workbook.'])

    return this.writeFile(wb, syncFolder, 'McQuire_FinancialStatements_Full.xlsx')
  }

  // ─── Data query helpers ───────────────────────────────────────────────────────

  private getMonthColumns(): string[] {
    const months: string[] = []
    const start = new Date(2025, 0, 1) // Jan 2025
    const now = new Date()
    const end = new Date(now.getFullYear(), now.getMonth(), 1)

    let cur = new Date(start)
    while (cur <= end) {
      months.push(
        `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`
      )
      cur.setMonth(cur.getMonth() + 1)
    }
    return months
  }

  private fmtMonthLabel(ym: string): string {
    const [year, month] = ym.split('-')
    const d = new Date(parseInt(year), parseInt(month) - 1, 1)
    return d.toLocaleString('en-US', { month: 'short', year: '2-digit' })
  }

  private getRevenueByMonth(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT strftime('%Y-%m', transaction_date) as month, SUM(ABS(amount)) as total
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.account_mask = '2255'
         AND t.bucket = 'Moonsmoke LLC'
         AND t.llc_category LIKE '%Revenue%'
         AND t.bucket != 'Exclude'
         AND ${NOT_SPLIT_PARENT}
         GROUP BY month`
      )
      .all() as Array<{ month: string; total: number }>

    // Also pull from P&L settings if manually entered
    const result: Record<string, number> = {}
    for (const row of rows) result[row.month] = row.total

    // Fallback: check for manually entered revenue in settings
    const manualRevenue = this.db
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'revenue_%'")
      .all() as Array<{ key: string; value: string }>
    for (const r of manualRevenue) {
      const month = r.key.replace('revenue_', '')
      if (!result[month]) result[month] = parseFloat(r.value) || 0
    }

    return result
  }

  private getLLCExpenseCategoriesByMonth(_months: string[]): Array<{
    category: string
    months: Record<string, number>
  }> {
    const rows = this.db
      .prepare(
        `SELECT t.llc_category as category,
                strftime('%Y-%m', t.transaction_date) as month,
                SUM(ABS(t.amount)) as total
         FROM transactions t
         WHERE t.bucket = 'Moonsmoke LLC'
         AND t.llc_category IS NOT NULL
         AND t.review_status != 'pending_review'
         AND ${NOT_SPLIT_PARENT}
         GROUP BY category, month
         ORDER BY category, month`
      )
      .all() as Array<{ category: string; month: string; total: number }>

    const categoryMap = new Map<string, Record<string, number>>()
    for (const row of rows) {
      if (!categoryMap.has(row.category)) categoryMap.set(row.category, {})
      categoryMap.get(row.category)![row.month] = row.total
    }

    return Array.from(categoryMap.entries()).map(([category, monthData]) => ({
      category,
      months: monthData,
    }))
  }

  private getQuarterlySnapshots(): Array<{
    label: string
    key: string
    cash: number | null
    investments: number | null
  }> {
    return [
      { label: 'Q1 2025', key: 'q1_2025', cash: this.getCashBalance('2025-03-31'), investments: null },
      { label: 'Q2 2025', key: 'q2_2025', cash: this.getCashBalance('2025-06-30'), investments: null },
      { label: 'Q3 2025', key: 'q3_2025', cash: this.getCashBalance('2025-09-30'), investments: null },
      { label: 'Q4 2025', key: 'q4_2025', cash: this.getCashBalance('2025-12-31'), investments: null },
    ]
  }

  private getCurrentYearMonths(): string[] {
    const now = new Date()
    const months: string[] = []
    for (let m = 0; m < now.getMonth() + 1; m++) {
      months.push(
        `${now.getFullYear()}-${String(m + 1).padStart(2, '0')}`
      )
    }
    return months
  }

  private getMonthSnapshot(ym: string): { label: string; cash: number | null; investments: number | null } {
    const [year, month] = ym.split('-')
    const lastDay = new Date(parseInt(year), parseInt(month), 0).toISOString().split('T')[0]
    return {
      label: this.fmtMonthLabel(ym),
      cash: this.getCashBalance(lastDay),
      investments: this.getInvestmentBalance(lastDay),
    }
  }

  private getCashBalance(asOf: string): number | null {
    // Get from manual settings (entered by Kyle from Chase BUS 2255 CSV)
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(`cash_balance_${asOf}`) as { value: string } | undefined
    if (row) return parseFloat(row.value)

    // Fallback: compute from transactions
    const result = this.db
      .prepare(
        `SELECT SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE -amount END) as balance
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.account_mask = '2255'
         AND t.transaction_date <= ?
         AND t.bucket != 'Exclude'
         AND ${NOT_SPLIT_PARENT}`
      )
      .get(asOf) as { balance: number | null }
    return result?.balance ?? null
  }

  private getInvestmentBalance(asOf: string): number | null {
    const row = this.db
      .prepare(
        `SELECT SUM(market_value) as total
         FROM investments
         WHERE record_type = 'holding'
         AND snapshot_date <= ?
         ORDER BY snapshot_date DESC
         LIMIT 1`
      )
      .get(asOf) as { total: number | null }
    return row?.total ?? null
  }

  private getCashflowPeriods(): Array<{ key: string; label: string }> {
    const now = new Date()
    const periods: Array<{ key: string; label: string }> = [
      { key: 'q1_2025', label: 'Q1 2025' },
      { key: 'q2_2025', label: 'Q2 2025' },
      { key: 'q3_2025', label: 'Q3 2025' },
      { key: 'q4_2025', label: 'Q4 2025' },
    ]
    // Add 2026 months through current
    for (let m = 1; m <= now.getMonth() + 1 && now.getFullYear() === 2026; m++) {
      const key = `2026-${String(m).padStart(2, '0')}`
      const label = new Date(2026, m - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' })
      periods.push({ key, label })
    }
    return periods
  }

  private getCashflowData(): {
    consulting_revenue: Record<string, number>
    net_salary: Record<string, number>
    employer_taxes: Record<string, number>
    rent: Record<string, number>
    other_operating: Record<string, number>
  } {
    // Payroll schedule from workflow doc (Section 4.6c)
    return {
      consulting_revenue: this.aggregateLLCByCategory('Revenue', true),
      net_salary: {
        q2_2025: 2583.87,   // May 2025 net salary, paid 5/30/2025
        q1_2026: 2595.67 * 6, // Jul–Dec 2025 catch-up, all paid 1/9/2026
      },
      employer_taxes: {
        q2_2025: 438,         // May 2025 employer taxes
        q1_2026: 438 + 432 + 333 + 306 + 306 + 306, // Jul–Dec catch-up
      },
      rent: this.aggregateLLCByCategory('Rent - Business Lodging', true),
      other_operating: this.aggregateLLCByCategory('other', false),
    }
  }

  private aggregateLLCByCategory(
    category: string,
    exact: boolean
  ): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT
           CASE
             WHEN transaction_date BETWEEN '2025-01-01' AND '2025-03-31' THEN 'q1_2025'
             WHEN transaction_date BETWEEN '2025-04-01' AND '2025-06-30' THEN 'q2_2025'
             WHEN transaction_date BETWEEN '2025-07-01' AND '2025-09-30' THEN 'q3_2025'
             WHEN transaction_date BETWEEN '2025-10-01' AND '2025-12-31' THEN 'q4_2025'
             ELSE strftime('%Y-%m', transaction_date)
           END as period,
           SUM(ABS(t.amount)) as total
         FROM transactions t
         WHERE t.bucket = 'Moonsmoke LLC'
         AND t.llc_category ${exact ? "= ?" : "NOT IN ('Payroll - Salary','Taxes - Payroll','Rent - Business Lodging','Revenue')"}
         AND t.review_status != 'pending_review'
         AND ${NOT_SPLIT_PARENT}
         GROUP BY period`
      )
      .all(...(exact ? [category] : [])) as Array<{ period: string; total: number }>

    const result: Record<string, number> = {}
    for (const r of rows) result[r.period] = r.total
    return result
  }

  private getPersonalIncomeBySource(year: number): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT merchant_name, SUM(ABS(amount)) as total
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.bucket = 'Personal'
         AND t.amount < 0
         AND strftime('%Y', t.transaction_date) = ?
         AND (
           t.merchant_name LIKE '%Insperity%'
           OR t.merchant_name LIKE '%UBS%'
           OR t.merchant_name LIKE '%Mobile Deposit%'
           OR t.merchant_name LIKE '%Zelle%'
           OR t.merchant_name LIKE '%Interest%'
         )
         AND ${NOT_SPLIT_PARENT}
         GROUP BY t.merchant_name`
      )
      .all(String(year)) as Array<{ merchant_name: string; total: number }>

    const result: Record<string, number> = {}
    for (const r of rows) {
      const name = r.merchant_name
      const canonical =
        name.includes('Insperity') ? 'Insperity (W2 Payroll — Peak 10)'
        : name.includes('UBS') ? 'UBS Business Sol Payroll (Moonsmoke)'
        : name.includes('Mobile Deposit') ? 'Mobile Deposit'
        : name.includes('Zelle') ? 'Zelle Received'
        : 'Interest Paid'
      result[canonical] = (result[canonical] || 0) + r.total
    }
    return result
  }

  private getPersonalExpensesByCategory(year: number): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT category_source as category, SUM(ABS(amount)) as total
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.bucket = 'Personal'
         AND t.amount > 0
         AND strftime('%Y', t.transaction_date) = ?
         AND t.review_status != 'pending_review'
         AND t.bucket != 'Exclude'
         AND ${NOT_SPLIT_PARENT}
         GROUP BY category
         ORDER BY total DESC`
      )
      .all(String(year)) as Array<{ category: string | null; total: number }>

    const result: Record<string, number> = {}
    for (const r of rows) {
      const cat = r.category || 'Uncategorized'
      result[cat] = (result[cat] || 0) + r.total
    }
    return result
  }

  private getPersonalRefunds(year: number): number {
    const row = this.db
      .prepare(
        `SELECT SUM(amount) as total
         FROM transactions t
         WHERE t.bucket = 'Personal'
         AND t.amount < 0
         AND strftime('%Y', t.transaction_date) = ?
         AND t.merchant_name NOT LIKE '%Insperity%'
         AND t.merchant_name NOT LIKE '%UBS%'
         AND t.merchant_name NOT LIKE '%Mobile Deposit%'
         AND t.merchant_name NOT LIKE '%Zelle%'
         AND t.merchant_name NOT LIKE '%Interest%'
         AND ${NOT_SPLIT_PARENT}`
      )
      .get(String(year)) as { total: number | null }
    return row?.total || 0
  }

  private getPersonalTransfers(): Record<number, number> {
    const rows = this.db
      .prepare(
        `SELECT strftime('%Y', transaction_date) as year, SUM(ABS(amount)) as total
         FROM transactions
         WHERE bucket = 'Exclude'
         GROUP BY year`
      )
      .all() as Array<{ year: string; total: number }>

    const result: Record<number, number> = {}
    for (const r of rows) result[parseInt(r.year)] = r.total
    return result
  }

  // ─── File writer ──────────────────────────────────────────────────────────────

  private async writeFile(
    wb: ExcelJS.Workbook,
    syncFolder: string,
    filename: string
  ): Promise<string> {
    const outDir = path.join(syncFolder, 'exports', 'statements')
    fs.mkdirSync(outDir, { recursive: true })
    const outputPath = path.join(outDir, filename)
    await wb.xlsx.writeFile(outputPath)
    return outputPath
  }
}
