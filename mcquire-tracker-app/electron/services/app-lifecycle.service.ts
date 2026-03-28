// electron/services/app-lifecycle.service.ts
//
// Phase 4 — App lifecycle services:
//   1. Lock file — prevents simultaneous writes from multiple machines
//   2. Nightly backup — copies mcquire.db to backups/ with 30-day retention
//   3. System tray — minimizes to tray, right-click menu
//   4. Auto-updater — electron-updater checks for new versions on launch

import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as path from 'path'
import * as fs from 'fs'
import * as cron from 'node-cron'

export class AppLifecycleService {
  private static instance: AppLifecycleService | null = null
  private syncFolder: string
  private getMainWindow: () => BrowserWindow | null
  private tray: Tray | null = null
  private lockPath: string

  private constructor(
    syncFolder: string,
    getMainWindow: () => BrowserWindow | null
  ) {
    this.syncFolder = syncFolder
    this.getMainWindow = getMainWindow
    this.lockPath = path.join(syncFolder, '.lock')
  }

  static getInstance(
    syncFolder: string,
    getMainWindow: () => BrowserWindow | null
  ): AppLifecycleService {
    if (!AppLifecycleService.instance) {
      AppLifecycleService.instance = new AppLifecycleService(syncFolder, getMainWindow)
    }
    return AppLifecycleService.instance
  }

  // ─── Initialize all lifecycle services ───────────────────────────────────────

  async initialize(): Promise<{ lockConflict: boolean; lockInfo: string | null }> {
    const lockResult = this.checkAndWriteLock()
    this.startBackupCron()
    this.setupAutoUpdater()
    return lockResult
  }

  // ─── Lock file ───────────────────────────────────────────────────────────────

  checkAndWriteLock(): { lockConflict: boolean; lockInfo: string | null } {
    let lockConflict = false
    let lockInfo: string | null = null

    if (fs.existsSync(this.lockPath)) {
      try {
        const lockContent = fs.readFileSync(this.lockPath, 'utf-8')
        const lockData = JSON.parse(lockContent)
        const lockAge = Date.now() - new Date(lockData.timestamp).getTime()

        // Lock older than 10 minutes is likely stale (app crashed without cleanup)
        if (lockAge < 10 * 60 * 1000) {
          lockConflict = true
          lockInfo = `Lock created by ${lockData.hostname} at ${new Date(lockData.timestamp).toLocaleString()}`
        } else {
          // Stale lock — remove it
          fs.unlinkSync(this.lockPath)
        }
      } catch {
        fs.unlinkSync(this.lockPath) // Corrupt lock file — remove
      }
    }

    // Write our lock
    const lockData = {
      hostname: require('os').hostname(),
      pid: process.pid,
      timestamp: new Date().toISOString(),
    }
    try {
      fs.writeFileSync(this.lockPath, JSON.stringify(lockData, null, 2))
    } catch (err) {
      console.error('[Lock] Failed to write lock file:', err)
    }

    return { lockConflict, lockInfo }
  }

  releaseLock(): void {
    try {
      if (fs.existsSync(this.lockPath)) {
        const content = fs.readFileSync(this.lockPath, 'utf-8')
        const data = JSON.parse(content)
        if (data.pid === process.pid) {
          fs.unlinkSync(this.lockPath)
          console.log('[Lock] Lock released.')
        }
      }
    } catch {
      // Non-fatal
    }
  }

  overrideLock(): void {
    try {
      fs.unlinkSync(this.lockPath)
      this.checkAndWriteLock()
    } catch {
      // Ignore
    }
  }

  // ─── Nightly backup ───────────────────────────────────────────────────────────

  private startBackupCron(): void {
    // Run at 3:00 AM daily (1 hour after default sync)
    cron.schedule('0 3 * * *', () => {
      this.runBackup()
    })
    console.log('[Backup] Nightly backup cron started (3:00 AM).')
  }

  runBackup(): { success: boolean; path?: string; error?: string } {
    const dbPath = path.join(this.syncFolder, 'db', 'mcquire.db')
    if (!fs.existsSync(dbPath)) {
      return { success: false, error: 'Database file not found.' }
    }

    const backupDir = path.join(this.syncFolder, 'backups')
    fs.mkdirSync(backupDir, { recursive: true })

    const today = new Date().toISOString().split('T')[0]
    const backupPath = path.join(backupDir, `mcquire_${today}.db`)

    try {
      fs.copyFileSync(dbPath, backupPath)
      console.log(`[Backup] Backed up to ${backupPath}`)

      // Prune backups older than 30 days
      this.pruneBackups(backupDir, 30)

      return { success: true, path: backupPath }
    } catch (err: any) {
      console.error('[Backup] Failed:', err)
      return { success: false, error: err.message }
    }
  }

  private pruneBackups(backupDir: string, maxDays: number): void {
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000
    try {
      const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'))
      for (const file of files) {
        const fullPath = path.join(backupDir, file)
        const stat = fs.statSync(fullPath)
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath)
          console.log(`[Backup] Pruned old backup: ${file}`)
        }
      }
    } catch (err) {
      console.error('[Backup] Prune error:', err)
    }
  }

  listBackups(): Array<{ filename: string; date: string; size_kb: number }> {
    const backupDir = path.join(this.syncFolder, 'backups')
    if (!fs.existsSync(backupDir)) return []

    return fs
      .readdirSync(backupDir)
      .filter((f) => f.endsWith('.db'))
      .sort()
      .reverse()
      .map((f) => {
        const stat = fs.statSync(path.join(backupDir, f))
        return {
          filename: f,
          date: f.replace('mcquire_', '').replace('.db', ''),
          size_kb: Math.round(stat.size / 1024),
        }
      })
  }

  // ─── System tray ─────────────────────────────────────────────────────────────

  setupTray(iconPath: string, onSyncNow: () => void): void {
    // Load icon (fall back to a simple placeholder if icon not found)
    let icon: Electron.NativeImage
    try {
      icon = nativeImage.createFromPath(iconPath)
      if (icon.isEmpty()) {
        // Create a 16x16 blue icon as fallback
        icon = nativeImage.createEmpty()
      }
    } catch {
      icon = nativeImage.createEmpty()
    }

    this.tray = new Tray(icon)
    this.tray.setToolTip('McQuire Tracker')

    const buildMenu = () =>
      Menu.buildFromTemplate([
        {
          label: 'McQuire Tracker',
          enabled: false,
        },
        { type: 'separator' },
        {
          label: 'Open',
          click: () => {
            const win = this.getMainWindow()
            if (win) {
              win.show()
              win.focus()
            }
          },
        },
        {
          label: 'Sync Now',
          click: () => {
            onSyncNow()
            const win = this.getMainWindow()
            if (win) {
              win.show()
              win.focus()
            }
          },
        },
        {
          label: 'Run Backup Now',
          click: () => {
            const result = this.runBackup()
            if (result.success) {
              dialog.showMessageBox({
                type: 'info',
                title: 'Backup Complete',
                message: `Database backed up to:\n${result.path}`,
              })
            } else {
              dialog.showErrorBox('Backup Failed', result.error || 'Unknown error')
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Quit McQuire Tracker',
          click: () => {
            this.releaseLock()
            app.quit()
          },
        },
      ])

    this.tray.setContextMenu(buildMenu())

    // Double-click to open
    this.tray.on('double-click', () => {
      const win = this.getMainWindow()
      if (win) {
        win.show()
        win.focus()
      }
    })

    // Minimize to tray instead of closing
    const win = this.getMainWindow()
    if (win) {
      win.on('close', (event) => {
        // Only minimize to tray if we're not actually quitting
        if (!(app as any).isQuiting) {
          event.preventDefault()
          win.hide()
          this.tray?.displayBalloon({
            title: 'McQuire Tracker',
            content: 'Still running in the background. Right-click the tray icon to quit.',
          })
        }
      })
    }
  }

  destroyTray(): void {
    this.tray?.destroy()
    this.tray = null
  }

  // ─── Auto-updater ─────────────────────────────────────────────────────────────

  private setupAutoUpdater(): void {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => {
      console.log('[Updater] Checking for updates…')
    })

    autoUpdater.on('update-available', (info) => {
      console.log(`[Updater] Update available: ${info.version}`)
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:available', info)
      }
    })

    autoUpdater.on('update-not-available', () => {
      console.log('[Updater] App is up to date.')
    })

    autoUpdater.on('download-progress', (progress) => {
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:progress', progress)
      }
    })

    autoUpdater.on('update-downloaded', (info) => {
      console.log('[Updater] Update downloaded.')
      const win = this.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:downloaded', info)
      }
    })

    autoUpdater.on('error', (err) => {
      console.error('[Updater] Error:', err)
    })

    // Check for updates 5 seconds after launch (non-blocking)
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {
        // Network unavailable or update server unreachable — silently ignore
      })
    }, 5000)
  }

  downloadUpdate(): void {
    autoUpdater.downloadUpdate().catch(console.error)
  }

  quitAndInstall(): void {
    ;(app as any).isQuiting = true
    autoUpdater.quitAndInstall()
  }

  // ─── IPC registration ─────────────────────────────────────────────────────────

  registerIpcHandlers(): void {
    ipcMain.handle('lifecycle:list-backups', async () => {
      return { success: true, data: this.listBackups() }
    })

    ipcMain.handle('lifecycle:run-backup', async () => {
      const result = this.runBackup()
      return result.success
        ? { success: true, data: result.path }
        : { success: false, error: result.error }
    })

    ipcMain.handle('lifecycle:lock-status', async () => {
      const exists = fs.existsSync(this.lockPath)
      if (!exists) return { success: true, data: { conflict: false } }
      try {
        const content = fs.readFileSync(this.lockPath, 'utf-8')
        const data = JSON.parse(content)
        const isOurs = data.pid === process.pid
        return { success: true, data: { conflict: !isOurs, info: data } }
      } catch {
        return { success: true, data: { conflict: false } }
      }
    })

    ipcMain.handle('lifecycle:override-lock', async () => {
      this.overrideLock()
      return { success: true }
    })

    ipcMain.handle('update:download', async () => {
      this.downloadUpdate()
      return { success: true }
    })

    ipcMain.handle('update:install', async () => {
      this.quitAndInstall()
      return { success: true }
    })
  }
}
