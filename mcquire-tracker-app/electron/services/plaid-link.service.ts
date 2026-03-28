// electron/services/plaid-link.service.ts
//
// Opens a child BrowserWindow that loads the local Plaid Link HTML page,
// waits for the user to complete (or close) the flow, then resolves/rejects.
//
// WHY CDP + session UA:
//   session.setUserAgent() patches the User-Agent HTTP header and
//   navigator.userAgent, but NOT navigator.userAgentData (structured UA
//   Client Hints). Plaid's SDK checks navigator.userAgentData.brands and
//   sees "Electron" → shows "System Requirements not met".
//   Emulation.setUserAgentOverride via Chrome DevTools Protocol overwrites
//   BOTH navigator.userAgent AND navigator.userAgentData in the JS runtime,
//   making Plaid see "Google Chrome 132" everywhere it looks.
//   We apply the override to the Plaid Link window AND to any popup window
//   it opens (Chase OAuth page) via did-create-window.

import { BrowserWindow, ipcMain, app, session } from 'electron'
import path from 'path'
import type { PlaidLinkResult } from '../../src/shared/plaid.types'

const CHROME_VER = '132'
const CHROME_FULL = '132.0.6834.83'

const UA_METADATA = {
  brands: [
    { brand: 'Not A Brand', version: '8' },
    { brand: 'Chromium', version: CHROME_VER },
    { brand: 'Google Chrome', version: CHROME_VER },
  ],
  fullVersionList: [
    { brand: 'Not A Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: CHROME_FULL },
    { brand: 'Google Chrome', version: CHROME_FULL },
  ],
  platform: 'Windows',
  platformVersion: '10.0.0',
  architecture: 'x86',
  model: '',
  mobile: false,
  bitness: '64',
  wow64: false,
}

function getPreloadPath(): string {
  return path.join(app.getAppPath(), 'dist-electron', 'preload', 'plaid-link-preload.js')
}

function getHtmlPath(): string {
  return path.join(app.getAppPath(), 'resources', 'plaid-link.html')
}

/** Apply CDP user-agent override to a webContents so navigator.userAgentData shows Chrome. */
async function applyCdpUaOverride(webContents: Electron.WebContents, cleanUA: string): Promise<void> {
  try {
    webContents.debugger.attach('1.3')
  } catch {
    // Already attached — fine, continue
  }
  try {
    await webContents.debugger.sendCommand('Emulation.setUserAgentOverride', {
      userAgent: cleanUA,
      acceptLanguage: 'en-US,en;q=0.9',
      platform: 'Win32',
      userAgentMetadata: UA_METADATA,
    })
  } catch (e) {
    console.warn('[PlaidLink] CDP UA override failed:', e)
  }
}

export async function openPlaidLink(
  linkToken: string,
  institutionNameHint?: string
): Promise<PlaidLinkResult> {
  return new Promise<PlaidLinkResult>((resolve, reject) => {
    // ── Dedicated in-memory session ───────────────────────────────────────────
    const partitionKey = `plaid-link-${Date.now()}`
    const plaidSession = session.fromPartition(partitionKey, { cache: false })

    // Patch the UA string (HTTP header + navigator.userAgent)
    const rawUA = plaidSession.getUserAgent()
    const cleanUA = rawUA
      .replace(/\s*Electron\/[\d.]+/, '')
      .replace(/Chrome\/[\d.]+/, `Chrome/${CHROME_FULL}`)

    plaidSession.setUserAgent(cleanUA)

    // Patch Sec-CH-UA HTTP headers for every request in this session
    plaidSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders }
      for (const key of Object.keys(headers)) {
        const lk = key.toLowerCase()
        if (lk === 'sec-ch-ua') {
          headers[key] = `"Not A Brand";v="8", "Chromium";v="${CHROME_VER}", "Google Chrome";v="${CHROME_VER}"`
        } else if (lk === 'sec-ch-ua-full-version-list') {
          headers[key] = `"Not A Brand";v="8.0.0.0", "Chromium";v="${CHROME_FULL}", "Google Chrome";v="${CHROME_FULL}"`
        }
      }
      callback({ requestHeaders: headers })
    })

    // ── Create the Plaid Link window ──────────────────────────────────────────
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      resizable: false,
      center: true,
      title: institutionNameHint ? `Connect ${institutionNameHint}` : 'Connect Bank Account',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: getPreloadPath(),
        partition: partitionKey,
      },
    })

    // Apply CDP UA override so navigator.userAgentData shows Google Chrome
    applyCdpUaOverride(win.webContents, cleanUA)

    // When Plaid opens a popup (e.g. Chase OAuth), patch that window too
    win.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          partition: partitionKey,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
        },
      },
    }))

    win.webContents.on('did-create-window', (childWin) => {
      applyCdpUaOverride(childWin.webContents, cleanUA)
    })

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    let settled = false

    function settle(fn: () => void) {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    function cleanup() {
      ipcMain.removeListener('plaid-link:success', onSuccess)
      ipcMain.removeListener('plaid-link:exit', onExit)
      ipcMain.removeListener('plaid-link:error', onError)
      if (!win.isDestroyed()) win.close()
    }

    const onSuccess = (_event: Electron.IpcMainEvent, result: PlaidLinkResult) => {
      settle(() => resolve(result))
    }

    const onExit = () => {
      settle(() => reject(new Error('Plaid Link window was closed without completing')))
    }

    const onError = (_event: Electron.IpcMainEvent, message: string) => {
      settle(() => reject(new Error(message)))
    }

    ipcMain.on('plaid-link:success', onSuccess)
    ipcMain.on('plaid-link:exit', onExit)
    ipcMain.on('plaid-link:error', onError)

    win.on('closed', () => {
      settle(() => reject(new Error('Plaid Link window was closed without completing')))
    })

    const htmlPath = getHtmlPath()
    win.loadURL(`file://${htmlPath}?token=${encodeURIComponent(linkToken)}`)
  })
}
