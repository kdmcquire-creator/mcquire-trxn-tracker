// tests/learning.test.ts
// Verifies the learning engine: auto-rule creation after a repeated manual
// decision, and that contradictions only re-queue after a real pattern shift
// (the fix for "reclassify one Shell → every Shell goes to review").

import { describe, it, expect, beforeEach } from 'vitest'
import { learnFromClassification } from '../electron/services/classification-engine'
import { makeDb, applyCoreSchema, applyRulesSchema, insertTx, insertAccount } from './helpers/db'
import type { CompatDb } from '../electron/services/database'

describe('learning engine', () => {
  let db: CompatDb
  const A = 'a'
  beforeEach(async () => {
    db = await makeDb(); applyCoreSchema(db); applyRulesSchema(db); insertAccount(db, A, '5829')
  })

  async function classifyManual(id: string, bucket: string) {
    db.prepare(`UPDATE transactions SET bucket=?, review_status='manually_classified' WHERE id=?`).run(bucket, id)
    return learnFromClassification(db, id)
  }

  it('creates a [Learned] rule after the same merchant is classified twice the same way', async () => {
    const t1 = insertTx(db, { account_id: A, merchant_name: 'acme co', amount: 50, transaction_date: '2025-01-01' })
    const t2 = insertTx(db, { account_id: A, merchant_name: 'acme co', amount: 60, transaction_date: '2025-02-01' })

    const r1 = await classifyManual(t1, 'Peak 10')
    expect(r1.ruleCreated).toBe(false) // only once so far

    const r2 = await classifyManual(t2, 'Peak 10')
    expect(r2.ruleCreated).toBe(true)
    const rule = db.prepare(`SELECT * FROM rules WHERE match_value LIKE '%acme%'`).get() as any
    expect(rule).toBeTruthy()
    expect(rule.bucket).toBe('Peak 10')
  })

  it('does NOT re-queue other charges after a SINGLE reclassification (Shell fix)', async () => {
    // Several Shell charges auto-classified as Peak 10
    const ids = [1, 2, 3].map(i =>
      insertTx(db, { account_id: A, merchant_name: 'shell', amount: 40 + i, transaction_date: `2025-0${i}-10`,
        bucket: 'Peak 10', review_status: 'auto_classified' }))
    // Reclassify exactly ONE to Personal
    const r = await classifyManual(ids[0], 'Personal')
    expect(r.requeuedCount).toBe(0)
    const pending = db.prepare(`SELECT COUNT(*) n FROM transactions WHERE review_status='pending_review'`).get() as { n: number }
    expect(pending.n).toBe(0)
  })

  it('re-queues contradicting auto-classified charges only after 2+ manual reclassifications', async () => {
    const autoIds = [1, 2, 3].map(i =>
      insertTx(db, { account_id: A, merchant_name: 'shell', amount: 40 + i, transaction_date: `2025-0${i}-10`,
        bucket: 'Peak 10', review_status: 'auto_classified' }))
    const manualIds = [4, 5].map(i =>
      insertTx(db, { account_id: A, merchant_name: 'shell', amount: 40 + i, transaction_date: `2025-0${i}-10` }))

    await classifyManual(manualIds[0], 'Personal') // 1st manual → no requeue yet
    const r2 = await classifyManual(manualIds[1], 'Personal') // 2nd → pattern shift
    expect(r2.requeuedCount).toBeGreaterThanOrEqual(1)

    const requeued = db.prepare(
      `SELECT COUNT(*) n FROM transactions WHERE review_status='pending_review' AND id IN (${autoIds.map(()=>'?').join(',')})`
    ).get(...autoIds) as { n: number }
    expect(requeued.n).toBe(3) // all three auto Shell charges now flagged for review
  })

  it('never touches manually classified transactions', async () => {
    const manual = insertTx(db, { account_id: A, merchant_name: 'shell', amount: 40, transaction_date: '2025-01-10',
      bucket: 'Peak 10', review_status: 'manually_classified' })
    const m2 = insertTx(db, { account_id: A, merchant_name: 'shell', amount: 41, transaction_date: '2025-02-10' })
    const m3 = insertTx(db, { account_id: A, merchant_name: 'shell', amount: 42, transaction_date: '2025-03-10' })
    await classifyManual(m2, 'Personal')
    await classifyManual(m3, 'Personal')
    // The pre-existing manual Peak 10 charge must remain manually_classified
    const row = db.prepare(`SELECT review_status, bucket FROM transactions WHERE id=?`).get(manual) as any
    expect(row.review_status).toBe('manually_classified')
    expect(row.bucket).toBe('Peak 10')
  })
})
