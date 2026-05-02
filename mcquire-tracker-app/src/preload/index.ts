// src/preload/index.ts
// McQuire Financial Tracker — Electron Preload (contextBridge)
// All four phases wired: Phase 1 (core) + Phase 2 (Plaid) + Phase 3 (Investments) + Phase 4 (Polish)

import { contextBridge, ipcRenderer } from 'electron'

// ── Phase 2 bridges ───────────────────────────────────────────────────────────
import { plaidBridge, accountsBridge, syncLogBridge } from './plaid-bridge'

// ── Phase 3 bridge ────────────────────────────────────────────────────────────
import { investmentsBridge } from './investments-bridge'

// ── Phase 4 bridges ───────────────────────────────────────────────────────────
import { statementsBridge, importBridge, lifecycleBridge } from './phase4-bridge'

// ─────────────────────────────────────────────────────────────────────────────
// Main API surface — everything the renderer can call
// ─────────────────────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('api', {

  // ── Phase 1: Core DB + transactions + rules ─────────────────────────────────
  db: {
    getSetting:      (key: string)                   => ipcRenderer.invoke('db:get-setting', key),
    setSetting:      (key: string, value: string)    => ipcRenderer.invoke('db:set-setting', key, value),
    getAllSettings:  ()                              => ipcRenderer.invoke('settings:getAll'),
    getReviewCount:  ()                              => ipcRenderer.invoke('db:get-review-count'),
    getBucketTotals: ()                              => ipcRenderer.invoke('db:get-bucket-totals'),
  },

  transactions: {
    getPending:   ()                                           => ipcRenderer.invoke('transactions:get-pending'),
    classify:     (id: string, update: Record<string, any>)   => ipcRenderer.invoke('transactions:classify', id, update),
    getAll:       (filters?: Record<string, any>)             => ipcRenderer.invoke('transactions:get-all', filters),
    split:        (parentId: string, fragments: any[])        => ipcRenderer.invoke('transactions:split', parentId, fragments),
    runRulesAll:  ()                                          => ipcRenderer.invoke('transactions:run-rules-all'),
    getRecentNotes: (filters?: { category?: string; merchant?: string }) => ipcRenderer.invoke('transactions:get-recent-notes', filters),
  },

  rules: {
    getAll: ()                          => ipcRenderer.invoke('rules:get-all'),
    save:   (rule: Record<string, any>) => ipcRenderer.invoke('rules:save', rule),
    delete: (id: string)                => ipcRenderer.invoke('rules:delete', id),
  },

  trips: {
    getAll: ()          => ipcRenderer.invoke('trips:get-all'),
    save:   (trip: any) => ipcRenderer.invoke('trips:save', trip),
    delete: (id: string) => ipcRenderer.invoke('trips:delete', id),
  },

  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke('shell:open-path', filePath),
  },

  reports: {
    generateExpenseReport:       (payload: any)                                  => ipcRenderer.invoke('reports:generate-expense-report', payload),
    checkExpenseReportReadiness: (payload?: any)                                  => ipcRenderer.invoke('reports:check-expense-report-readiness', payload),
    getBlockerTransactions:      (payload?: { dateFrom?: string; dateTo?: string }) => ipcRenderer.invoke('reports:get-blocker-transactions', payload),
  },

  // ── Phase 2: Plaid sync + account management ────────────────────────────────
  plaid:    plaidBridge,
  accounts: accountsBridge,
  syncLog:  syncLogBridge,

  // ── Phase 3: Investment tracking ────────────────────────────────────────────
  investments: investmentsBridge,

  // ── Phase 4: Financial statements, import wizard, lifecycle ────────────────
  statements: statementsBridge,
  import:     importBridge,
  lifecycle:  lifecycleBridge,

  // ── Phase 4: Email (notifications) ─────────────────────────────────────────
  email: {
    saveSmtp: (config: any) => ipcRenderer.invoke('email:save-smtp', config),
    sendTest: ()            => ipcRenderer.invoke('email:send-test'),
  },

  // ── Settings ───────────────────────────────────────────────────────────────
  settings: {
    getSmtp:   ()            => ipcRenderer.invoke('settings:getSmtp'),
    saveSmtp:  (config: any) => ipcRenderer.invoke('settings:saveSmtp', config),
    testEmail: (email: string) => ipcRenderer.invoke('settings:testEmail', email),
    getAll:    ()            => ipcRenderer.invoke('settings:getAll'),
    set:       (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  },

  // ── Claude AI Classification ─────────────────────────────────────────────
  claude: {
    hasKey:       ()                    => ipcRenderer.invoke('claude:has-key'),
    saveKey:      (apiKey: string)      => ipcRenderer.invoke('claude:save-key', apiKey),
    deleteKey:    ()                    => ipcRenderer.invoke('claude:delete-key'),
    suggest:      (tx: any)             => ipcRenderer.invoke('claude:suggest', tx),
    suggestBatch: (transactions: any[]) => ipcRenderer.invoke('claude:suggest-batch', transactions),
  },

  // ── Ollama Local AI ─────────────────────────────────────────────────────────
  ollama: {
    testConnection: ()                                              => ipcRenderer.invoke('ollama:test-connection'),
    getConfig:      ()                                              => ipcRenderer.invoke('ollama:get-config'),
    setConfig:      (config: { enabled?: boolean; model?: string }) => ipcRenderer.invoke('ollama:set-config', config),
    suggest:        (tx: any)                                       => ipcRenderer.invoke('ollama:suggest', tx),
  },

})

// ─────────────────────────────────────────────────────────────────────────────
// electronAPI — used by the setup wizard for folder selection + DB init
// ─────────────────────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: ()               => ipcRenderer.invoke('app:select-folder'),
  getSyncFolder: ()              => ipcRenderer.invoke('app:get-sync-folder'),
  setSyncFolder: (p: string)     => ipcRenderer.invoke('app:set-sync-folder', p),
  initDatabase:  (folder: string) => ipcRenderer.invoke('app:init-database', folder),
})

// ─────────────────────────────────────────────────────────────────────────────
// electron — raw ipcRenderer access for components that need event listeners
// (e.g. lock conflict modal, import progress, sync events)
// ─────────────────────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    on:                (channel: string, listener: (...args: any[]) => void) =>
                         ipcRenderer.on(channel, listener),
    once:              (channel: string, listener: (...args: any[]) => void) =>
                         ipcRenderer.once(channel, listener),
    removeListener:    (channel: string, listener: (...args: any[]) => void) =>
                         ipcRenderer.removeListener(channel, listener),
    removeAllListeners:(channel: string) =>
                         ipcRenderer.removeAllListeners(channel),
    send:              (channel: string, ...args: any[]) =>
                         ipcRenderer.send(channel, ...args),
  },
})
