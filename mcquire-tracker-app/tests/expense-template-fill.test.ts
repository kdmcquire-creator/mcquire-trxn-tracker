// tests/expense-template-fill.test.ts
// Surgical fill of the Peak 10 expense-report template: preserve the Table,
// formulas, and formatting; only the expense rows + title/period change. Covers
// the <87 path (hidden spare rows, totals stay at 98) and the >87 path (rows
// extended, totals/signature shifted down, Table ref widened).

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import JSZip from 'jszip'
import { fillExpenseTemplate, dateToSerial, type ExpenseRow } from '../electron/services/expense-template-fill'

const sample = (n: number): ExpenseRow[] =>
  Array.from({ length: n }, (_, i) => ({
    date: '2025-12-15',
    entity: 'Peak 10 Energy Management',
    account: 'Travel',
    merchant: `Vendor ${i} & Co`,
    notes: i % 2 ? 'biz note' : '',
    amount: 10 + i,
  }))

describe('expense template fill', () => {
  it('date serial matches the template', () => {
    expect(dateToSerial('2024-09-14')).toBe(45549)  // template B11
    expect(dateToSerial('2025-07-08')).toBe(45846)  // template B12
  })

  it('N<87: keeps 87 rows, totals stay at 98, spares hidden, refs unchanged', async () => {
    const buf = await fillExpenseTemplate(sample(5), { title: 'My Title', period: 'Dec2025 - Jan2026' })
    const zip = await JSZip.loadAsync(buf)
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(sheet).toContain('<row r="11"')
    expect(sheet).toContain('<row r="97"')
    expect(sheet).toMatch(/<row r="98"[^>]*>[\s\S]*?SUBTOTAL\(109,Expense\[Amount/)  // totals at 98
    expect((sheet.match(/<row[^>]*hidden="1"/g) || []).length).toBe(82)              // 87-5 spares
    expect(sheet).toContain('Vendor 0 &amp; Co')                                     // XML-escaped
    expect(sheet).toContain('<is><t>My Title</t></is>')                              // B3 title
    const table = await zip.file('xl/tables/table1.xml')!.async('string')
    expect(table).toContain('ref="B10:V98"')                                         // unchanged
    expect(zip.file('xl/calcChain.xml')).toBeNull()                                  // dropped
  })

  it('N>87: extends rows, shifts totals + signature down, widens the Table', async () => {
    const buf = await fillExpenseTemplate(sample(120), { title: 'T', period: 'P' })
    const zip = await JSZip.loadAsync(buf)
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    // 120 data rows → 11..130; totals 98+33 = 131; signature 'Signature:' shifted too
    expect(sheet).toContain('<row r="130"')
    expect(sheet).toMatch(/<row r="131"[^>]*>[\s\S]*?SUBTOTAL\(109,Expense\[Amount/)
    expect((sheet.match(/<row[^>]*hidden="1"/g) || []).length).toBe(0)               // no spares
    const table = await zip.file('xl/tables/table1.xml')!.async('string')
    expect(table).toContain('ref="B10:V131"')
    expect(table).toContain('<autoFilter ref="B10:V130"')

    // Persist for the strict-parser (openpyxl) validation step.
    const dir = path.join(os.tmpdir(), 'claude'); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'fill-120.xlsx'), buf)
  })
})
