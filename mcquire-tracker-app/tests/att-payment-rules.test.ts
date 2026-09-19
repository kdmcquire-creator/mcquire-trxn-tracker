// tests/att-payment-rules.test.ts
// Fix B: AT&T wireless autopay now drafts from checking as an ACH "ATT PAYMENT"
// (not the 5829 card). New seed rules llc-024 / p10-043 / p10-044 must classify it
// as AT&T on ANY account so it isn't swallowed by excl-004 ("payment" → Exclude),
// and a large one must land in a state the AT&T-bill PDF matcher can still auto-split.
// Amounts here are synthetic representatives (dollar figures are not PII).

import { describe, it, expect, beforeEach } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { initDatabase } from '../src/main/schema'
import { classifyTransaction, loadActiveRules } from '../electron/services/classification-engine'
import { matchBillToCharge, type ChargeCandidate } from '../electron/services/att-bill-matcher'
import type { CompatDb } from '../electron/services/database'

describe('AT&T ACH "ATT PAYMENT" classification (Fix B)', () => {
  let db: CompatDb
  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mcq-attpay-${process.pid}-`))
    db = await initDatabase(dir) // full real schema + seed rules + migrations
  })

  const classify = (desc: string, amount: number, mask = '8178') =>
    classifyTransaction(
      { description_raw: desc, amount, transaction_date: '2026-07-21', account_mask: mask },
      loadActiveRules(db), db,
    )

  it('seeds the new att-payment rules', () => {
    const ids = (db.prepare("SELECT id FROM rules WHERE match_value = 'att payment'").all() as Array<{ id: string }>)
      .map(r => r.id).sort()
    expect(ids).toEqual(['llc-024', 'p10-043', 'p10-044'])
  })

  it('routes a large ACH draft to split_flag (NOT Exclude), even on checking …8178', () => {
    const r = classify('ACH WITHDRAWAL 072126 ATT PAYMENT ***********PAYC', 497.51)
    expect(r.bucket).not.toBe('Exclude')
    expect(r.action).toBe('split_flag')
    expect(r.review_status).toBe('pending_review')
    expect(r.rule_id).toBe('p10-044')
  })

  it('routes a small ACH draft to the Moonsmoke LLC business line', () => {
    const r = classify('ACH WITHDRAWAL 082126 ATT PAYMENT ***********MT2L', 40.33)
    expect(r.bucket).toBe('Moonsmoke LLC')
    expect(r.rule_id).toBe('llc-024')
  })

  it('regression: a non-AT&T "payment" is still excluded (excl-004 intact)', () => {
    const r = classify('SOMEBODY ELSE BILL PAYMENT', 500)
    expect(r.bucket).toBe('Exclude')
    expect(r.rule_id).toBe('excl-004')
  })

  it('a split-flagged ACH draft is a candidate the bill matcher auto-splits', () => {
    // As the AT&T-bill matcher sees it after import: bucket null, review pending_review.
    const charge: ChargeCandidate = {
      id: 'c1', amount: 497.51, date: '2026-07-21', bucket: null, review_status: 'pending_review',
    }
    const bill = {
      accountNumber: '287301218152', issueDate: '2026-06-27', autopayDate: '2026-07-20',
      billTotal: 497.51, line0468Amount: 72.57,
    }
    const m = matchBillToCharge(bill, [charge])
    expect(m.action).toBe('split')
    if (m.action === 'split') expect(m.targetId).toBe('c1')
  })
})
