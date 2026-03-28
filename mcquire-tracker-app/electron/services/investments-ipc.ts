// electron/services/investments-ipc.ts
//
// IPC handlers for Phase 3 investment tracking.
// Register by calling registerInvestmentsIpcHandlers(db, invService) in main process.

import { ipcMain } from 'electron'
import type { CompatDb } from './database'
import * as path from 'path'
import * as ExcelJS from 'exceljs'
import { PlaidInvestmentsService } from './plaid-investments.service'
import { INVESTMENT_IPC } from '../../src/shared/investments.types'

export function registerInvestmentsIpcHandlers(
  db: CompatDb,
  invService: PlaidInvestmentsService,
  getSyncFolder: () => string
): void {

  // ─── Sync ─────────────────────────────────────────────────────────────────────

  ipcMain.handle(INVESTMENT_IPC.SYNC_HOLDINGS, async (_event, plaidItemId?: string) => {
    try {
      if (plaidItemId) {
        const result = await invService.syncHoldings(plaidItemId)
        return { success: !result.error, data: result, error: result.error }
      }
      // Sync all
      const result = await invService.syncAll()
      return { success: result.errors.length === 0, data: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(
    INVESTMENT_IPC.SYNC_TRANSACTIONS,
    async (_event, payload?: { plaidItemId?: string; startDate?: string; endDate?: string }) => {
      try {
        if (payload?.plaidItemId) {
          const result = await invService.syncTransactions(
            payload.plaidItemId,
            payload.startDate,
            payload.endDate
          )
          return { success: !result.error, data: result, error: result.error }
        }
        const result = await invService.syncAll()
        return { success: true, data: result }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  ipcMain.handle(INVESTMENT_IPC.SYNC_ALL, async () => {
    try {
      const result = await invService.syncAll()
      return { success: result.errors.length === 0, data: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ─── Read queries ─────────────────────────────────────────────────────────────

  ipcMain.handle(INVESTMENT_IPC.GET_PORTFOLIO_SUMMARY, async () => {
    try {
      return { success: true, data: invService.getPortfolioSummary() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(INVESTMENT_IPC.GET_ACCOUNT_SUMMARIES, async () => {
    try {
      return { success: true, data: invService.getAccountSummaries() }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(
    INVESTMENT_IPC.GET_HOLDINGS,
    async (_event, accountId?: string) => {
      try {
        return { success: true, data: invService.getHoldings(accountId) }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  ipcMain.handle(
    INVESTMENT_IPC.GET_TRANSACTIONS,
    async (
      _event,
      filters?: { accountId?: string; startDate?: string; endDate?: string; txType?: string }
    ) => {
      try {
        return {
          success: true,
          data: invService.getTransactions(
            filters?.accountId,
            filters?.startDate,
            filters?.endDate,
            filters?.txType
          ),
        }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  ipcMain.handle(
    INVESTMENT_IPC.GET_HISTORICAL,
    async (_event, payload?: { accountId?: string; days?: number }) => {
      try {
        return {
          success: true,
          data: invService.getHistoricalSnapshots(payload?.accountId, payload?.days),
        }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  // ─── Portfolio Excel export ───────────────────────────────────────────────────

  ipcMain.handle(INVESTMENT_IPC.EXPORT_PORTFOLIO, async () => {
    try {
      const outputPath = await generatePortfolioExcel(db, invService, getSyncFolder())
      return { success: true, data: outputPath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}

// ─── Portfolio Excel generation ───────────────────────────────────────────────

async function generatePortfolioExcel(
  _db: CompatDb,
  invService: PlaidInvestmentsService,
  syncFolder: string
): Promise<string> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'McQuire Tracker'
  wb.created = new Date()

  const summary = invService.getPortfolioSummary()
  const accountSummaries = invService.getAccountSummaries()
  const holdings = invService.getHoldings()
  const transactions = invService.getTransactions(undefined, undefined, undefined, undefined)

  // ── Colors ──────────────────────────────────────────────────────────────────
  const NAVY       = '1F3864'
  const LBLUE      = 'DCE6F1'
  const WHITE      = 'FFFFFF'
  const HEADER_FONT = { bold: true, color: { argb: 'FF' + WHITE } }

  function headerRow(_ws: ExcelJS.Worksheet, row: ExcelJS.Row, bgColor: string) {
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bgColor } }
      cell.font = HEADER_FONT
      cell.alignment = { vertical: 'middle' }
    })
    row.height = 18
  }

  function stripeRow(_ws: ExcelJS.Worksheet, row: ExcelJS.Row, idx: number) {
    const bg = idx % 2 === 0 ? LBLUE : WHITE
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bg } }
    })
  }

  function currencyFmt(cell: ExcelJS.Cell, value: number | null) {
    cell.value = value
    cell.numFmt = '$#,##0.00'
    if (value !== null && value < 0) cell.font = { color: { argb: 'FFC00000' } }
  }

  function pctFmt(cell: ExcelJS.Cell, value: number | null) {
    cell.value = value !== null ? value / 100 : null
    cell.numFmt = '0.00%'
    if (value !== null && value < 0) cell.font = { color: { argb: 'FFC00000' } }
  }

  // ── Sheet 1: Portfolio Summary ───────────────────────────────────────────────
  const wsSummary = wb.addWorksheet('Portfolio Summary')
  wsSummary.columns = [
    { header: '', key: 'label', width: 32 },
    { header: '', key: 'value', width: 20 },
  ]

  const summaryTitle = wsSummary.addRow(['McQuire Investment Portfolio', ''])
  summaryTitle.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF' + NAVY } }
  wsSummary.addRow(['As of', summary.as_of_date])
  wsSummary.addRow(['Generated', new Date().toLocaleDateString()])
  wsSummary.addRow([])

  const addSummaryRow = (label: string, value: any, fmt?: 'currency' | 'pct') => {
    const row = wsSummary.addRow([label, ''])
    row.getCell(1).font = { bold: true }
    if (fmt === 'currency') currencyFmt(row.getCell(2), value)
    else if (fmt === 'pct') pctFmt(row.getCell(2), value)
    else row.getCell(2).value = value
    return row
  }

  addSummaryRow('Total Market Value', summary.total_market_value, 'currency')
  if (summary.total_cost_basis !== null) {
    addSummaryRow('Total Cost Basis', summary.total_cost_basis, 'currency')
    addSummaryRow('Unrealized Gain / Loss', summary.total_gain_loss, 'currency')
    addSummaryRow('Gain / Loss %', summary.total_gain_loss_pct, 'pct')
  } else {
    addSummaryRow('Cost Basis', '⚠️ Not available — verify with brokerage statements')
  }
  wsSummary.addRow([])
  addSummaryRow('Accounts', summary.account_count)
  addSummaryRow('Positions', summary.holdings_count)

  if (summary.has_incomplete_cost_basis) {
    wsSummary.addRow([])
    const warn = wsSummary.addRow(['⚠️ Cost basis data is incomplete for one or more holdings. Verify against brokerage statements before use in tax calculations.'])
    warn.getCell(1).font = { italic: true, color: { argb: 'FFC00000' } }
  }

  // ── Sheet 2: Holdings by Account ─────────────────────────────────────────────
  const wsHoldings = wb.addWorksheet('Holdings')
  wsHoldings.columns = [
    { key: 'institution', width: 14 },
    { key: 'account',     width: 28 },
    { key: 'ticker',      width: 10 },
    { key: 'security',    width: 38 },
    { key: 'qty',         width: 14 },
    { key: 'price',       width: 14 },
    { key: 'market_val',  width: 16 },
    { key: 'cost_basis',  width: 16 },
    { key: 'gain_loss',   width: 16 },
    { key: 'gain_pct',    width: 12 },
  ]

  const hHeader = wsHoldings.addRow([
    'Institution', 'Account', 'Ticker', 'Security',
    'Quantity', 'Price', 'Market Value', 'Cost Basis', 'Gain / Loss', 'G/L %',
  ])
  headerRow(wsHoldings, hHeader, NAVY)

  holdings.forEach((h, idx) => {
    const row = wsHoldings.addRow([
      h.institution,
      `${h.account_name} ···${h.account_mask}`,
      h.ticker || '',
      h.security_name || '',
      h.quantity,
      null, null, null, null, null,
    ])
    stripeRow(wsHoldings, row, idx)
    row.getCell(5).numFmt = '#,##0.0000'
    currencyFmt(row.getCell(6), h.price)
    currencyFmt(row.getCell(7), h.market_value)
    if (h.cost_basis !== null) {
      currencyFmt(row.getCell(8), h.cost_basis)
      currencyFmt(row.getCell(9), h.gain_loss)
      pctFmt(row.getCell(10), h.gain_loss_pct)
    } else {
      row.getCell(8).value = '⚠️'
      row.getCell(8).font = { italic: true, color: { argb: 'FFC00000' } }
    }
  })

  // Totals row
  wsHoldings.addRow([])
  const hTotals = wsHoldings.addRow([
    '', 'TOTAL', '', '',
    null,
    null,
    summary.total_market_value,
    summary.total_cost_basis,
    summary.total_gain_loss,
    summary.total_gain_loss_pct,
  ])
  hTotals.getCell(1).font = { bold: true }
  hTotals.getCell(2).font = { bold: true }
  currencyFmt(hTotals.getCell(7), summary.total_market_value)
  if (summary.total_cost_basis !== null) {
    currencyFmt(hTotals.getCell(8), summary.total_cost_basis)
    currencyFmt(hTotals.getCell(9), summary.total_gain_loss)
    pctFmt(hTotals.getCell(10), summary.total_gain_loss_pct)
  }

  // ── Sheet 3: Account Summaries ───────────────────────────────────────────────
  const wsAccounts = wb.addWorksheet('By Account')
  wsAccounts.columns = [
    { key: 'institution', width: 16 },
    { key: 'account',     width: 28 },
    { key: 'positions',   width: 12 },
    { key: 'market_val',  width: 18 },
    { key: 'cost_basis',  width: 18 },
    { key: 'last_sync',   width: 22 },
  ]

  const aHeader = wsAccounts.addRow([
    'Institution', 'Account', 'Positions', 'Market Value', 'Cost Basis', 'Last Synced',
  ])
  headerRow(wsAccounts, aHeader, NAVY)

  accountSummaries.forEach((a, idx) => {
    const row = wsAccounts.addRow([
      a.institution,
      `${a.account_name} ···${a.account_mask}`,
      a.holding_count,
      null,
      null,
      a.last_synced_at ? new Date(a.last_synced_at).toLocaleDateString() : 'Never',
    ])
    stripeRow(wsAccounts, row, idx)
    currencyFmt(row.getCell(4), a.market_value)
    if (a.cost_basis !== null) currencyFmt(row.getCell(5), a.cost_basis)
    else row.getCell(5).value = '⚠️ CPA review'
  })

  // ── Sheet 4: Investment Transactions ─────────────────────────────────────────
  const wsTx = wb.addWorksheet('Transactions')
  wsTx.columns = [
    { key: 'date',        width: 14 },
    { key: 'institution', width: 14 },
    { key: 'account',     width: 28 },
    { key: 'type',        width: 14 },
    { key: 'ticker',      width: 10 },
    { key: 'security',    width: 36 },
    { key: 'qty',         width: 14 },
    { key: 'price',       width: 14 },
    { key: 'amount',      width: 16 },
  ]

  const tHeader = wsTx.addRow([
    'Date', 'Institution', 'Account', 'Type', 'Ticker', 'Security',
    'Quantity', 'Price', 'Amount',
  ])
  headerRow(wsTx, tHeader, NAVY)

  transactions.forEach((t, idx) => {
    const row = wsTx.addRow([
      t.transaction_date,
      t.institution,
      `${t.account_name} ···${t.account_mask}`,
      t.transaction_type || '',
      t.ticker || '',
      t.security_name || '',
      t.quantity,
      null,
      null,
    ])
    stripeRow(wsTx, row, idx)
    if (t.quantity) row.getCell(7).numFmt = '#,##0.0000'
    currencyFmt(row.getCell(8), t.price ?? null)
    currencyFmt(row.getCell(9), t.transaction_amount ?? null)
  })

  // ── Write file ────────────────────────────────────────────────────────────────
  const fileName = `Investment_Portfolio_${summary.as_of_date}.xlsx`
  const outputPath = path.join(syncFolder, 'exports', 'statements', fileName)

  const { mkdirSync } = require('fs')
  mkdirSync(path.dirname(outputPath), { recursive: true })
  await wb.xlsx.writeFile(outputPath)

  return outputPath
}
