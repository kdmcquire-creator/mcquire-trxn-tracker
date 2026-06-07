// tests/recurring-repair.test.ts
// Proves the self-healing repair restores recurring charges (Bilt) that dedup
// wrongly excluded, while leaving genuine one-off duplicates excluded.

import { describe, it, expect, beforeEach } from 'vitest'
import { restoreRecurringExclusions, recurringMerchantVerdict } from '../electron/services/recurring-repair'
import { makeDb, applyCoreSchema, insertTx, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

describe('recurring-charge repair', () => {
  let db: CompatDb
  const A = 'a', B = 'b'
  beforeEach(async () => {
    db = await makeDb(); applyCoreSchema(db)
    insertAccount(db, A, '9007'); insertAccount(db, B, '2419')
  })

  it('restores recurring Bilt rent wrongly excluded by dedup', () => {
    // 12 months of Bilt; 10 of them were wrongly Excluded by old dedup,
    // 2 survived (the "June & Nov only" symptom).
    for (let m = 1; m <= 12; m++) {
      const excluded = m !== 6 && m !== 11
      insertTx(db, {
        account_id: A, merchant_name: 'bilt', amount: 2850,
        transaction_date: `2025-${String(m).padStart(2, '0')}-01`,
        bucket: excluded ? 'Exclude' : 'Moonsmoke LLC',
        flag_reason: excluded ? 'Cross-account duplicate' : null,
        review_status: 'auto_classified',
      })
    }
    const restored = restoreRecurringExclusions(db)
    expect(restored).toBe(10)

    // All 12 months are now visible (none Excluded)
    const visible = db.prepare(
      `SELECT COUNT(DISTINCT substr(transaction_date,1,7)) n FROM transactions
       WHERE merchant_name='bilt' AND (bucket IS NULL OR bucket!='Exclude')`
    ).get() as { n: number }
    expect(visible.n).toBe(12)
  })

  it('does NOT restore a genuine one-off duplicate', () => {
    // Mavis charged twice within 2 days on two cards — a true duplicate, only
    // appears in ONE month, so it is NOT recurring and must stay excluded.
    insertTx(db, { account_id: A, merchant_name: 'mavis', amount: 225.03, transaction_date: '2026-02-22', bucket: 'Personal' })
    insertTx(db, { account_id: B, merchant_name: 'mavis', amount: 225.03, transaction_date: '2026-02-23',
      bucket: 'Exclude', flag_reason: 'Cross-account duplicate' })

    expect(restoreRecurringExclusions(db)).toBe(0)
    const stillExcluded = db.prepare(
      `SELECT COUNT(*) n FROM transactions WHERE merchant_name='mavis' AND bucket='Exclude'`
    ).get() as { n: number }
    expect(stillExcluded.n).toBe(1)
  })

  it('only touches dedup-flagged exclusions, not manual ones', () => {
    // A user manually excluded a recurring charge for their own reason — leave it.
    for (let m = 1; m <= 4; m++) {
      insertTx(db, { account_id: A, merchant_name: 'nickson', amount: 500,
        transaction_date: `2025-0${m}-10`, bucket: 'Exclude',
        flag_reason: 'Not a business expense — user decision' })
    }
    expect(restoreRecurringExclusions(db)).toBe(0)
  })

  it('verdict reports distinct-month coverage (data-gap detector)', () => {
    insertTx(db, { account_id: A, merchant_name: 'bilt', amount: 2850, transaction_date: '2025-06-01', bucket: 'Moonsmoke LLC' })
    insertTx(db, { account_id: A, merchant_name: 'bilt', amount: 2850, transaction_date: '2025-11-01', bucket: 'Moonsmoke LLC' })
    const [v] = recurringMerchantVerdict(db, ['bilt'])
    expect(v.total).toBe(2)
    expect(v.months).toBe(2) // only 2 months exist at all → data gap, not dedup
    expect(v.excluded).toBe(0)
  })
})
