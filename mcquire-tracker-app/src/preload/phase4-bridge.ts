// src/preload/phase4-bridge.ts
//
// contextBridge additions for Phase 4 services.
// Merge all exports into src/preload/index.ts under window.api.

import { ipcRenderer } from 'electron'

// ── Financial Statements ──────────────────────────────────────────────────────

export const statementsBridge = {
  pandl:          (payload?: any) => ipcRenderer.invoke('statements:pandl', payload),
  balanceSheet:   (payload?: any) => ipcRenderer.invoke('statements:balance-sheet', payload),
  cashflow:       (payload?: any) => ipcRenderer.invoke('statements:cashflow', payload),
  personalSummary:(payload?: any) => ipcRenderer.invoke('statements:personal-summary', payload),
  fullTracker:    (payload?: any) => ipcRenderer.invoke('statements:full-tracker', payload),
  openFolder:     () => ipcRenderer.invoke('statements:open-folder'),
  setCashBalance: (payload: { date: string; amount: number }) =>
    ipcRenderer.invoke('statements:set-cash-balance', payload),
  setRevenue: (payload: { month: string; amount: number }) =>
    ipcRenderer.invoke('statements:set-revenue', payload),
  getManualEntries: () => ipcRenderer.invoke('statements:get-manual-entries'),
}

// ── Historical Import ─────────────────────────────────────────────────────────

export const importBridge = {
  selectFile: () => ipcRenderer.invoke('import:select-file'),
  preview:    (filePath: string) => ipcRenderer.invoke('import:preview', filePath),
  run:        (filePath: string) => ipcRenderer.invoke('import:run', filePath),
  onProgress: (callback: (data: any) => void) => {
    ipcRenderer.on('import:progress', (_event, data) => callback(data))
    return () => ipcRenderer.removeAllListeners('import:progress')
  },
}

// ── App Lifecycle ─────────────────────────────────────────────────────────────

export const lifecycleBridge = {
  listBackups:    () => ipcRenderer.invoke('lifecycle:list-backups'),
  runBackup:      () => ipcRenderer.invoke('lifecycle:run-backup'),
  lockStatus:     () => ipcRenderer.invoke('lifecycle:lock-status'),
  overrideLock:   () => ipcRenderer.invoke('lifecycle:override-lock'),
  onUpdateAvailable:  (cb: (info: any) => void) => {
    ipcRenderer.on('update:available', (_e, info) => cb(info))
    return () => ipcRenderer.removeAllListeners('update:available')
  },
  onUpdateDownloaded: (cb: (info: any) => void) => {
    ipcRenderer.on('update:downloaded', (_e, info) => cb(info))
    return () => ipcRenderer.removeAllListeners('update:downloaded')
  },
  onUpdateProgress: (cb: (p: any) => void) => {
    ipcRenderer.on('update:progress', (_e, p) => cb(p))
    return () => ipcRenderer.removeAllListeners('update:progress')
  },
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate:  () => ipcRenderer.invoke('update:install'),
}
