// electron/services/att-bill-ipc.ts
// IPC for the AT&T bill auto-split: pick/import PDFs (parse + ingest), list bills,
// and confirm an ambiguous match. PDF→text happens here (main process) via
// pdf-parse; the parse/match/apply logic lives in the tested service modules.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { CompatDb } from './database'
import { parseAttBill } from './att-bill-parser'
import {
  ingestParsedBill, listAttBills, attBillReviewCandidates, confirmAttBillMatch, rematchPendingAttBills,
} from './att-bill-ingest'

export interface AttImportResult { file: string; outcome: string; error?: string }

async function pdfToText(buf: Buffer): Promise<string> {
  // Import the lib directly to skip pdf-parse's index.js debug block.
  const pdfParse = require('pdf-parse/lib/pdf-parse.js')
  const res = await pdfParse(buf)
  return res.text as string
}

async function importPaths(db: CompatDb, paths: string[]): Promise<AttImportResult[]> {
  const out: AttImportResult[] = []
  for (const p of paths) {
    const name = path.basename(p)
    try {
      const text = await pdfToText(fs.readFileSync(p))
      const parsed = parseAttBill(text)
      if (!parsed) { out.push({ file: name, outcome: 'unparsed', error: "Not recognized as an AT&T 8152 bill" }); continue }
      out.push({ file: name, outcome: ingestParsedBill(db, parsed, name).outcome })
    } catch (e: any) {
      out.push({ file: name, outcome: 'error', error: e?.message ?? 'error' })
    }
  }
  return out
}

export function registerAttBillIpc(db: CompatDb, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('att-bill:pick', async () => {
    const win = getWindow()
    const opts: Electron.OpenDialogOptions = {
      title: 'Add AT&T Bill PDFs',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled) return { success: true, data: [] }
    return { success: true, data: await importPaths(db, res.filePaths) }
  })

  // Drag-and-drop sends absolute paths from the renderer.
  ipcMain.handle('att-bill:import-paths', async (_e, paths: string[]) =>
    ({ success: true, data: await importPaths(db, Array.isArray(paths) ? paths : []) }))

  ipcMain.handle('att-bill:list', async () => {
    rematchPendingAttBills(db) // re-check pending bills against current charges on each view
    return { success: true, data: listAttBills(db) }
  })

  ipcMain.handle('att-bill:review-candidates', async (_e, billId: string) =>
    ({ success: true, data: attBillReviewCandidates(db, billId) }))

  ipcMain.handle('att-bill:confirm', async (_e, billId: string, chargeId: string) =>
    confirmAttBillMatch(db, billId, chargeId))
}
