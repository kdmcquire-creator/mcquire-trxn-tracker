// tests/dedup.test.ts
// Integration tests for cross-account duplicate detection.
// Reproduces the real-world bugs: pending/posted duplicates AND the
// "Bilt rent only shows 2 months" recurring-charge false-positive.

import { describe, it, expect, beforeEach } from 'vitest'
import { isCrossAccountDuplicate, RECURRING_THRESHOLD } from '../electron/services/dedup'
import { makeDb, applyCoreSchema, insertTx, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

describe('cross-account duplicate detection', () => {
  let db: CompatDb
  const A = 'acct-9007'
  const B = 'acct-2419'

  beforeEach(async () => {
    db = await makeDb()
    applyCoreSchema(db)
    insertAccount(db, A, '9007')
    insertAccount(db, B, '2419')
  })

  it('flags a true pending/posted duplicate across two cards (1 day apart)', () => {
    // Existing charge on card A
    insertTx(db, { account_id: A, merchant_name: 'mavis', amount: 225.03, transaction_date: '2026-02-22' })
    // Same charge surfaces on card B one day later
    const dupe = isCrossAccountDuplicate(db, {
      merchantNorm: 'mavis', amount: 225.03, date: '2026-02-23', accountId: B,
    })
    expect(dupe).toBe(true)
  })

  it('flags a duplicate exactly 2 days apart (window boundary)', () => {
    insertTx(db, { account_id: A, merchant_name: 'nicotine product', amount: 161.84, transaction_date: '2026-02-22' })
    expect(isCrossAccountDuplicate(db, {
      merchantNorm: 'nicotine product', amount: 161.84, date: '2026-02-24', accountId: B,
    })).toBe(true)
  })

  it('does NOT flag charges more than 2 days apart', () => {
    insertTx(db, { account_id: A, merchant_name: 'orangebloods', amount: 10.77, transaction_date: '2026-02-22' })
    expect(isCrossAccountDuplicate(db, {
      merchantNorm: 'orangebloods', amount: 10.77, date: '2026-02-26', accountId: B,
    })).toBe(false)
  })

  it('does NOT flag a charge as a duplicate of itself (same account)', () => {
    insertTx(db, { account_id: A, merchant_name: 'target', amount: 61.68, transaction_date: '2026-02-23' })
    expect(isCrossAccountDuplicate(db, {
      merchantNorm: 'target', amount: 61.68, date: '2026-02-23', accountId: A,
    })).toBe(false)
  })

  // ── The Bilt bug ──────────────────────────────────────────────────────────
  it('does NOT dedup recurring monthly rent (Bilt) appearing on two cards', () => {
    // 12 months of identical-amount Bilt rent already imported on card A
    for (let m = 1; m <= 12; m++) {
      insertTx(db, {
        account_id: A, merchant_name: 'bilt', amount: 2850.0,
        transaction_date: `2025-${String(m).padStart(2, '0')}-01`, bucket: 'Moonsmoke LLC',
      })
    }
    // Now the same recurring rent surfaces on card B — must NOT be deduped,
    // because 12 (>= RECURRING_THRESHOLD) identical charges = recurring, not a dupe.
    const flagged = isCrossAccountDuplicate(db, {
      merchantNorm: 'bilt', amount: 2850.0, date: '2025-06-02', accountId: B,
    })
    expect(flagged).toBe(false)
  })

  it('recurring guard activates only at the threshold', () => {
    // Below threshold (2 existing on A), candidate within the date window of one
    // of them → treated as a potential duplicate.
    insertTx(db, { account_id: A, merchant_name: 'gexa energy', amount: 140.0, transaction_date: '2025-01-15' })
    insertTx(db, { account_id: A, merchant_name: 'gexa energy', amount: 140.0, transaction_date: '2025-03-15' })
    expect(RECURRING_THRESHOLD).toBe(3)
    expect(isCrossAccountDuplicate(db, {
      merchantNorm: 'gexa energy', amount: 140.0, date: '2025-03-16', accountId: B,
    })).toBe(true)

    // A third identical charge on A reaches RECURRING_THRESHOLD → now recurring,
    // so even an in-window candidate is no longer treated as a duplicate.
    insertTx(db, { account_id: A, merchant_name: 'gexa energy', amount: 140.0, transaction_date: '2025-04-15' })
    expect(isCrossAccountDuplicate(db, {
      merchantNorm: 'gexa energy', amount: 140.0, date: '2025-03-16', accountId: B,
    })).toBe(false)
  })

  it('ignores already-excluded transactions when counting', () => {
    insertTx(db, { account_id: A, merchant_name: 'doordash', amount: 22.49, transaction_date: '2026-02-23', bucket: 'Exclude' })
    // The only matching charge is excluded, so nothing to dupe against
    expect(isCrossAccountDuplicate(db, {
      merchantNorm: 'doordash', amount: 22.49, date: '2026-02-23', accountId: B,
    })).toBe(false)
  })

  it('treats different amounts as distinct charges', () => {
    insertTx(db, { account_id: A, merchant_name: 'shell', amount: 45.00, transaction_date: '2026-02-22' })
    expect(isCrossAccountDuplicate(db, {
      merchantNorm: 'shell', amount: 4.50, date: '2026-02-22', accountId: B,
    })).toBe(false)
  })
})
