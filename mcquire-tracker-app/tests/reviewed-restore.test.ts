// tests/reviewed-restore.test.ts
// Migration 018: restores the hand-reviewed wrongly-excluded charges to the
// buckets Kyle assigned. Only rows currently in Exclude are touched; everything
// else is left alone; re-running is a no-op.

import { describe, it, expect, beforeEach } from 'vitest'
import { restoreReviewedExclusions, REVIEWED_RESTORES } from '../electron/services/reviewed-restore'
import { makeDb, applyCoreSchema, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

function addTx(db: CompatDb, id: string, merchant: string, amount: number, date: string, bucket: string): void {
  db.prepare(`
    INSERT INTO transactions (id, account_id, merchant_name, description_raw, amount,
      transaction_date, bucket, review_status)
    VALUES (?,?,?,?,?,?,?,'auto_classified')
  `).run(id, 'a', merchant, merchant, amount, date, bucket)
}

describe('reviewed-exclusion restore (migration 018)', () => {
  let db: CompatDb
  beforeEach(async () => {
    db = await makeDb(); applyCoreSchema(db); insertAccount(db, 'a', '1111')
  })

  it('restores excluded rows to their assigned bucket; leaves others alone', () => {
    // Two rows straight from the reviewed list, currently Excluded.
    addTx(db, 'backvac', 'Backvac', 369.99, '2025-12-25', 'Exclude')            // → Moonsmoke LLC
    addTx(db, 'parkhouse', 'Park House Houston', 1002.88, '2026-01-14', 'Exclude') // → Peak 10
    // A genuinely-excluded row NOT in the list — must stay excluded.
    addTx(db, 'other', 'Some Duplicate', 50.0, '2026-01-01', 'Exclude')
    // A row matching a listed (merchant, amount, date) but NOT excluded — must not be touched.
    addTx(db, 'already', 'Backvac', 369.99, '2025-12-25', 'Personal')

    const { restored } = restoreReviewedExclusions(db)
    expect(restored).toBe(2)

    const get = (id: string) => db.prepare('SELECT bucket, review_status FROM transactions WHERE id=?').get(id) as any
    expect(get('backvac')).toEqual({ bucket: 'Moonsmoke LLC', review_status: 'manually_classified' })
    expect(get('parkhouse')).toEqual({ bucket: 'Peak 10', review_status: 'manually_classified' })
    expect(get('other').bucket).toBe('Exclude')
    expect(get('already').bucket).toBe('Personal')
  })

  it('is idempotent', () => {
    addTx(db, 'backvac', 'Backvac', 369.99, '2025-12-25', 'Exclude')
    expect(restoreReviewedExclusions(db).restored).toBe(1)
    expect(restoreReviewedExclusions(db).restored).toBe(0)
  })

  it('the embedded list is the 48 reviewed rows (30 Peak 10, 18 Moonsmoke LLC)', () => {
    expect(REVIEWED_RESTORES).toHaveLength(48)
    expect(REVIEWED_RESTORES.filter(r => r.bucket === 'Peak 10')).toHaveLength(30)
    expect(REVIEWED_RESTORES.filter(r => r.bucket === 'Moonsmoke LLC')).toHaveLength(18)
    // every entry targets a real business bucket
    expect(REVIEWED_RESTORES.every(r => r.bucket === 'Peak 10' || r.bucket === 'Moonsmoke LLC')).toBe(true)
  })
})
