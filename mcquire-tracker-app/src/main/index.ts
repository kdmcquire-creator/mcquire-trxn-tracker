// src/main/index.ts
// McQuire Financial Tracker — Electron Main Process
// Thin orchestrator: delegates to schema.ts, ipc-handlers.ts, and service modules.

import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import * as path from 'path'
import * as fs from 'fs'
import type { CompatDb } from '../../electron/services/database'

// ── Service imports ──────────────────────────────────────────────────────────
import { PlaidService } from '../../electron/services/plaid.service'
import { SyncScheduler } from '../../electron/services/sync-scheduler.service'
import { registerPlaidIpcHandlers } from '../../electron/services/plaid-ipc'
import { PlaidInvestmentsService } from '../../electron/services/plaid-investments.service'
import { registerInvestmentsIpcHandlers } from '../../electron/services/investments-ipc'
import { registerFinancialStatementsHandlers } from '../../electron/services/financial-statements-ipc'
import { registerHistoricalImportHandlers } from '../../electron/services/historical-import.service'
import { AppLifecycleService } from '../../electron/services/app-lifecycle.service'
import { registerAttBillIpc } from '../../electron/services/att-bill-ipc'
import { rematchPendingAttBills } from '../../electron/services/att-bill-ingest'

// ── Local modules ────────────────────────────────────────────────────────────
import { initDatabase } from './schema'
import { registerAppIpcHandlers } from './ipc-handlers'

// ─────────────────────────────────────────────────────────────────────────────
// Protocol registration (must happen before app.whenReady)
// ─────────────────────────────────────────────────────────────────────────────
app.setAsDefaultProtocolClient('mcquire-tracker')

// ─────────────────────────────────────────────────────────────────────────────
// App state
// ─────────────────────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null
let db: CompatDb | null = null
let syncFolderPath: string = ''
let lifecycleRef: AppLifecycleService | null = null

// ─────────────────────────────────────────────────────────────────────────────
// Application menu (File → Quit) + reliable quit
// ─────────────────────────────────────────────────────────────────────────────
function forceQuit(): void {
  if (lifecycleRef) {
    lifecycleRef.quitApp()
  } else {
    // First run (no sync folder yet) — no tray/lock to tear down.
    ;(app as any).isQuiting = true
    app.quit()
  }
}

function setupApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Quit McQuire Tracker', accelerator: 'CmdOrCtrl+Q', click: () => forceQuit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for Updates', click: () => lifecycleRef?.checkForUpdatesNow() },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync folder config — loaded from userData config, or set during setup wizard
// ─────────────────────────────────────────────────────────────────────────────
function loadSyncFolderPath(): string {
  const configPath = path.join(app.getPath('userData'), 'config.json')
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      return config.syncFolder || ''
    } catch {
      return ''
    }
  }
  return ''
}

function saveSyncFolderPath(folder: string): void {
  const configPath = path.join(app.getPath('userData'), 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ syncFolder: folder }, null, 2))
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync folder directory structure
// ─────────────────────────────────────────────────────────────────────────────
function initSyncFolderStructure(folder: string): void {
  const dirs = [
    path.join(folder, 'db'),
    path.join(folder, 'exports', 'expense_reports'),
    path.join(folder, 'exports', 'statements'),
    path.join(folder, 'imports', 'usaa'),
    path.join(folder, 'imports', 'usaa', 'processed'),
    path.join(folder, 'imports', 'apple_card'),
    path.join(folder, 'imports', 'apple_card', 'processed'),
    path.join(folder, 'backups'),
  ]
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Create main window
// ─────────────────────────────────────────────────────────────────────────────
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#F9FAFB',
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools()
  } else {
    win.loadFile(join(__dirname, '../../dist/index.html'))
  }

  return win
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap all services — called once DB is ready
// ─────────────────────────────────────────────────────────────────────────────
let _servicesBootstrapped = false

async function bootstrapServices(folder: string): Promise<void> {
  if (_servicesBootstrapped) {
    console.warn('[Main] Services already bootstrapped — reinitializing DB only')
    db = await initDatabase(folder)
    return
  }
  _servicesBootstrapped = true

  initSyncFolderStructure(folder)
  db = await initDatabase(folder)

  // ── Phase 2: Plaid sync ─────────────────────────────────────────────────
  const plaidService = PlaidService.getInstance(db)
  const syncScheduler = SyncScheduler.getInstance(db, plaidService, () => mainWindow)
  registerPlaidIpcHandlers(db, plaidService, syncScheduler)

  // ── Phase 3: Investment tracking ────────────────────────────────────────
  const invService = PlaidInvestmentsService.getInstance(db, plaidService)
  registerInvestmentsIpcHandlers(db, invService, () => folder)

  // Extend the SyncScheduler to also snapshot investments on each sync
  const originalRunSync = (syncScheduler as any).runSync?.bind(syncScheduler)
  if (originalRunSync) {
    ;(syncScheduler as any).runSync = async () => {
      await originalRunSync()
      try {
        await invService.syncAll()
      } catch (err) {
        console.warn('[Main] Investment sync during auto-sync failed:', err)
      }
    }
  }

  // ── Phase 4: Financial statements + import wizard + lifecycle ───────────
  registerFinancialStatementsHandlers(db, () => folder)
  registerHistoricalImportHandlers(db, () => mainWindow)
  registerAttBillIpc(db, () => mainWindow)

  const lifecycle = AppLifecycleService.getInstance(folder, () => mainWindow)
  lifecycleRef = lifecycle
  const { lockConflict, lockInfo } = await lifecycle.initialize()
  lifecycle.registerIpcHandlers()

  if (lockConflict && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow!.webContents.send('lifecycle:lock-conflict', { lockInfo })
    })
  }

  const iconPath = path.join(__dirname, '../../resources/icon.ico')
  lifecycle.setupTray(iconPath, () => { syncScheduler.syncNow().catch(console.error) })

  app.on('before-quit', () => {
    ;(app as any).isQuiting = true
    lifecycle.releaseLock()
  })

  mainWindow?.once('ready-to-show', async () => {
    await syncScheduler.onAppReady()
  })

  // File watcher for USAA + Apple Card drop folders
  registerWatchedFolderHandlers(db, folder)

  // Apply any AT&T bills whose autopay charge already exists.
  try { rematchPendingAttBills(db) } catch (e) { console.warn('[Main] startup AT&T re-match failed:', e) }

  console.log('[Main] All services bootstrapped for sync folder:', folder)
}

// ─────────────────────────────────────────────────────────────────────────────
// Watched folder import — chokidar watches USAA + Apple Card folders
// ─────────────────────────────────────────────────────────────────────────────
function registerWatchedFolderHandlers(database: CompatDb, folder: string): void {
  try {
    const chokidar = require('chokidar')

    const watchedDirs = [
      { dir: path.join(folder, 'imports', 'usaa'), type: 'USAA' },
      { dir: path.join(folder, 'imports', 'apple_card'), type: 'Apple Card' },
    ]

    for (const { dir, type } of watchedDirs) {
      const watcher = chokidar.watch(dir, {
        ignored: [/(^|[/\\])\../, /processed\//],
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
      })

      watcher.on('add', async (filePath: string) => {
        const ext = path.extname(filePath).toLowerCase()
        if (!['.csv', '.ofx'].includes(ext)) return

        console.log(`[Watcher] New ${type} file detected:`, filePath)

        try {
          const { HistoricalImportService } = require('../../electron/services/historical-import.service')
          const importSvc = HistoricalImportService.getInstance(database)
          const result = await importSvc.importCSV(filePath, (progress: any) => {
            mainWindow?.webContents.send('import:progress', progress)
          })

          const processedDir = path.join(path.dirname(filePath), 'processed')
          fs.mkdirSync(processedDir, { recursive: true })
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
          const processedPath = path.join(processedDir, `${timestamp}_${path.basename(filePath)}`)
          fs.renameSync(filePath, processedPath)

          console.log(`[Watcher] ${type} import complete:`, result)
          mainWindow?.webContents.send('import:watched-folder-complete', {
            type,
            file: path.basename(filePath),
            ...result,
          })
          // A newly-imported charge may complete a pending AT&T bill split.
          try { rematchPendingAttBills(database) } catch (e) { console.warn('[Watcher] AT&T re-match failed:', e) }
        } catch (err) {
          console.error(`[Watcher] ${type} import failed:`, err)
        }
      })
    }

    console.log('[Main] File watchers started for USAA and Apple Card folders.')
  } catch (err) {
    console.warn('[Main] Could not start file watchers (chokidar not available):', err)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// App startup
// ─────────────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  setupApplicationMenu()
  mainWindow = createWindow()

  syncFolderPath = loadSyncFolderPath()

  if (syncFolderPath && fs.existsSync(syncFolderPath)) {
    await bootstrapServices(syncFolderPath)
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow!.show()
  })

  // Register app-level IPC handlers via the extracted module
  registerAppIpcHandlers({
    db: () => db,
    mainWindow: () => mainWindow,
    syncFolderPath: () => syncFolderPath,
    setSyncFolderPath: (folder: string) => { syncFolderPath = folder },
    saveSyncFolderPath,
    bootstrapServices,
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
