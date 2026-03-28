// src/preload/plaid-bridge.ts
//
// Additions to the contextBridge for Phase 2 Plaid channels.
// Merge this into your existing src/preload/index.ts contextBridge.exposeInMainWorld call.
//
// In your existing preload/index.ts, add the plaid object to the exposed API:
//
//   contextBridge.exposeInMainWorld('api', {
//     ...existingHandlers,
//     plaid: plaidBridge,           // ← add this
//     syncLog: syncLogBridge,        // ← add this
//     accounts: accountsBridge,      // ← add this
//   })

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/plaid.types'

// ─── Plaid bridge ─────────────────────────────────────────────────────────────

export const plaidBridge = {
  // Configuration
  getConfig: () => ipcRenderer.invoke(IPC.SETTINGS_GET_PLAID_CONFIG),
  saveConfig: (config: { client_id: string; secret: string; env: string }) =>
    ipcRenderer.invoke(IPC.SETTINGS_SAVE_PLAID_CONFIG, config),

  // Link flow
  createLinkToken: () => ipcRenderer.invoke(IPC.PLAID_CREATE_LINK_TOKEN),
  openLink: (linkToken: string) => ipcRenderer.invoke(IPC.PLAID_OPEN_LINK, linkToken),
  exchangeToken: (payload: any) => ipcRenderer.invoke(IPC.PLAID_EXCHANGE_TOKEN, payload),
  reauth: (plaidItemId: string) => ipcRenderer.invoke(IPC.PLAID_REAUTH, plaidItemId),

  // Sync
  syncAll: () => ipcRenderer.invoke(IPC.PLAID_SYNC_ALL),
  syncAccount: (plaidItemId: string) => ipcRenderer.invoke(IPC.PLAID_SYNC_ACCOUNT, plaidItemId),
  getSyncStatus: () => ipcRenderer.invoke(IPC.PLAID_GET_SYNC_STATUS),

  // Items
  listItems: () => ipcRenderer.invoke(IPC.PLAID_ITEMS_LIST),
  deleteItem: (plaidItemId: string) => ipcRenderer.invoke(IPC.PLAID_ITEMS_DELETE, plaidItemId),

  // Schedule
  getSchedule: () => ipcRenderer.invoke(IPC.SETTINGS_GET_SYNC_SCHEDULE),
  saveSchedule: (config: { enabled: boolean; cron: string }) =>
    ipcRenderer.invoke(IPC.SETTINGS_SAVE_SYNC_SCHEDULE, config),

  // Event listeners (main → renderer push events)
  onSyncStarted: (cb: (data: any) => void) => {
    ipcRenderer.on(IPC.EVENT_SYNC_STARTED, (_e, data) => cb(data))
  },
  onSyncProgress: (cb: (data: { message: string }) => void) => {
    ipcRenderer.on(IPC.EVENT_SYNC_PROGRESS, (_e, data) => cb(data))
  },
  onSyncCompleted: (cb: (data: any) => void) => {
    ipcRenderer.on(IPC.EVENT_SYNC_COMPLETED, (_e, data) => cb(data))
  },
  onSyncError: (cb: (data: any) => void) => {
    ipcRenderer.on(IPC.EVENT_SYNC_ERROR, (_e, data) => cb(data))
  },
  onReauthRequired: (cb: (data: any) => void) => {
    ipcRenderer.on(IPC.EVENT_REAUTH_REQUIRED, (_e, data) => cb(data))
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners(IPC.EVENT_SYNC_STARTED)
    ipcRenderer.removeAllListeners(IPC.EVENT_SYNC_PROGRESS)
    ipcRenderer.removeAllListeners(IPC.EVENT_SYNC_COMPLETED)
    ipcRenderer.removeAllListeners(IPC.EVENT_SYNC_ERROR)
    ipcRenderer.removeAllListeners(IPC.EVENT_REAUTH_REQUIRED)
  },
}

// ─── Accounts bridge ──────────────────────────────────────────────────────────

export const accountsBridge = {
  list: () => ipcRenderer.invoke(IPC.ACCOUNTS_LIST),
  update: (account: any) => ipcRenderer.invoke(IPC.ACCOUNTS_UPDATE, account),
  disable: (accountId: string) => ipcRenderer.invoke(IPC.ACCOUNTS_DISABLE, accountId),
  delete: (accountId: string) => ipcRenderer.invoke(IPC.ACCOUNTS_DELETE, accountId),
}

// ─── Sync log bridge ─────────────────────────────────────────────────────────

export const syncLogBridge = {
  list: (limit?: number) => ipcRenderer.invoke(IPC.SYNC_LOG_LIST, limit),
}
