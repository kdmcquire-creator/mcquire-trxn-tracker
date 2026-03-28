// src/preload/investments-bridge.ts
//
// contextBridge additions for Phase 3 investment data.
// Merge into src/preload/index.ts under window.api:
//
//   contextBridge.exposeInMainWorld('api', {
//     ...existingHandlers,
//     plaid: plaidBridge,
//     accounts: accountsBridge,
//     syncLog: syncLogBridge,
//     investments: investmentsBridge,   // ← add this
//   })

import { ipcRenderer } from 'electron'
import { INVESTMENT_IPC } from '../shared/investments.types'

export const investmentsBridge = {
  // Sync
  syncAll: () => ipcRenderer.invoke(INVESTMENT_IPC.SYNC_ALL),
  syncHoldings: (plaidItemId?: string) =>
    ipcRenderer.invoke(INVESTMENT_IPC.SYNC_HOLDINGS, plaidItemId),
  syncTransactions: (payload?: { plaidItemId?: string; startDate?: string; endDate?: string }) =>
    ipcRenderer.invoke(INVESTMENT_IPC.SYNC_TRANSACTIONS, payload),

  // Read
  getPortfolioSummary: () => ipcRenderer.invoke(INVESTMENT_IPC.GET_PORTFOLIO_SUMMARY),
  getAccountSummaries: () => ipcRenderer.invoke(INVESTMENT_IPC.GET_ACCOUNT_SUMMARIES),
  getHoldings: (accountId?: string) => ipcRenderer.invoke(INVESTMENT_IPC.GET_HOLDINGS, accountId),
  getTransactions: (filters?: {
    accountId?: string
    startDate?: string
    endDate?: string
    txType?: string
  }) => ipcRenderer.invoke(INVESTMENT_IPC.GET_TRANSACTIONS, filters),
  getHistorical: (payload?: { accountId?: string; days?: number }) =>
    ipcRenderer.invoke(INVESTMENT_IPC.GET_HISTORICAL, payload),

  // Export
  exportPortfolio: () => ipcRenderer.invoke(INVESTMENT_IPC.EXPORT_PORTFOLIO),
}
