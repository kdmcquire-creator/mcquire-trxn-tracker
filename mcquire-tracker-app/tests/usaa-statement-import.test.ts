// tests/usaa-statement-import.test.ts
// Ingest path for USAA statement PDFs: resolve account, dedup against existing
// same-account rows, classify (transfers → Exclude), insert. Idempotent.

import { describe, it, expect, beforeEach } from 'vitest'
import { HistoricalImportService } from '../electron/services/historical-import.service'
import { makeDb, applyCoreSchema, applyRulesSchema, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

const STMT = `for Account Number: 0060788178
Statement Period: 12/20/2024 to 01/17/2025
Beginning Balance
$1,000.00
1 Deposits/Credits $0.00
3 Withdrawals/Debits $169.37
Ending Balance
$830.63
Transactions
Date Description Debits Credits Balance
12/20 POS DEBIT 122024 ACME STORE
$100.00
0
$900.00
12/21 VENMO PAYMENT 122124 ***********999
$50.00
0
$850.00
01/10 DEBIT CARD PURCHASE 011025 GRUBHUB*WHATABURGER
$19.37
0
$830.63`

describe('USAA statement import', () => {
  let db: CompatDb
  let svc: HistoricalImportService
  beforeEach(async () => {
    db = await makeDb()
    applyCoreSchema(db); applyRulesSchema(db)
    insertAccount(db, 'usaa', '8178')
    // classifier: payments → Exclude; everything else falls through to default
    db.prepare(`INSERT INTO rules (id, rule_name, section, match_type, match_value, bucket, action, priority_order, is_active)
      VALUES ('excl-pay','Payment Exclude','exclusion','contains','payment','Exclude','exclude',8999,1)`).run()
    db.prepare(`INSERT INTO rules (id, rule_name, section, match_type, match_value, bucket, action, priority_order, is_active)
      VALUES ('def','Default','default','contains','','Personal','classify',9000,1)`).run()
    // an existing same-account row the statement re-imports (the Grubhub charge)
    db.prepare(`INSERT INTO transactions (id, account_id, merchant_name, description_raw, amount, transaction_date, bucket, review_status)
      VALUES ('g0','usaa','Grubhub','GRUBHUB*WHATABURGER GRUBHUB.COM NY',19.37,'2025-01-10','Personal','auto_classified')`).run()
    ;(HistoricalImportService as any).instance = null
    svc = HistoricalImportService.getInstance(db)
  })

  it('previews: 1 dup (Grubhub), 1 excluded (Venmo payment), 1 new, totals reconcile', async () => {
    const p = await svc.previewUSAAStatement(STMT)
    expect(p).toMatchObject({
      accountMask: '8178', accountFound: true, total: 3,
      duplicates: 1, newClassified: 1, newExcluded: 1, reconciles: true,
    })
  })

  it('imports: inserts the 2 new rows (Venmo excluded), skips the dup; re-import is idempotent', async () => {
    const res = await svc.importUSAAStatement(STMT)
    expect(res).toMatchObject({ imported: 2, duplicates: 1, excluded: 1 })

    const venmo = db.prepare("SELECT bucket FROM transactions WHERE description_raw LIKE '%VENMO%'").get() as { bucket: string }
    expect(venmo.bucket).toBe('Exclude')
    const total = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id='usaa'").get() as { n: number }
    expect(total.n).toBe(3) // 1 pre-existing + 2 imported

    const again = await svc.importUSAAStatement(STMT)
    expect(again).toMatchObject({ imported: 0, duplicates: 3 })
  })
})
