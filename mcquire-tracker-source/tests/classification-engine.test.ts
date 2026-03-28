// tests/classification-engine.test.ts
// Unit tests for the classification engine — normalization, rule matching, and classify logic

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { normalizeMerchant, hashRow, ruleMatches, classifyTransaction } from '../electron/services/classification-engine'
import type { Rule } from '../src/shared/types'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a minimal Rule object with sensible defaults */
function makeRule(overrides: Partial<Rule> & { id: string; match_value: string; bucket: string }): Rule {
  return {
    rule_name: overrides.rule_name ?? 'Test Rule',
    section: overrides.section ?? 'p10_always',
    match_type: overrides.match_type ?? 'contains',
    account_mask_filter: null,
    amount_min: null,
    amount_max: null,
    day_of_week_filter: null,
    date_from_filter: null,
    date_to_filter: null,
    p10_category: null,
    llc_category: null,
    description_notes: null,
    flag_reason: null,
    action: overrides.action ?? 'classify',
    priority_order: overrides.priority_order ?? 100,
    is_active: 1,
    notes: null,
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
    ...overrides,
  }
}

/** Create a minimal tx context for ruleMatches */
function makeTxCtx(overrides: Partial<{
  merchantNorm: string
  accountMask: string
  amount: number
  dayOfWeek: number
  date: string
  categorySource: string
  originalDescription: string
}> = {}) {
  return {
    merchantNorm: overrides.merchantNorm ?? 'park house houston',
    accountMask: overrides.accountMask ?? '5829',
    amount: overrides.amount ?? 150,
    dayOfWeek: overrides.dayOfWeek ?? 2, // Tuesday
    date: overrides.date ?? '2025-06-10',
    categorySource: overrides.categorySource,
    originalDescription: overrides.originalDescription,
  }
}

/** Create a mock DB that returns empty trip dates */
function mockDb(tripDates: Array<{ start_date: string; end_date: string }> = []) {
  return {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue(tripDates),
      get: vi.fn(),
      run: vi.fn(),
    }),
    transaction: vi.fn((fn: Function) => fn),
  } as any
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeMerchant
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeMerchant', () => {
  it('lowercases input', () => {
    expect(normalizeMerchant('PARK HOUSE')).toBe('park house')
  })

  it('strips TST* prefix', () => {
    expect(normalizeMerchant('TST* BARI HOUSTON #1')).toBe('bari houston')
  })

  it('strips SQ * prefix', () => {
    expect(normalizeMerchant('SQ *SOME VENDOR')).toBe('some vendor')
  })

  it('strips PY * prefix', () => {
    expect(normalizeMerchant('PY *PATRIOT SOFTWARE')).toBe('patriot software')
  })

  it('removes trailing store numbers', () => {
    expect(normalizeMerchant('Starbucks #1234')).toBe('starbucks')
  })

  it('removes trailing card/ref numbers', () => {
    expect(normalizeMerchant('Shell Gas 98765')).toBe('shell gas')
  })

  it('preserves ampersands and hyphens', () => {
    expect(normalizeMerchant("AT&T")).toBe("at&t")
    expect(normalizeMerchant("Buc-ee's")).toBe("buc-ee's")
  })

  it('collapses multiple spaces', () => {
    expect(normalizeMerchant('  Park   House   ')).toBe('park house')
  })

  it('handles empty string', () => {
    expect(normalizeMerchant('')).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// hashRow
// ─────────────────────────────────────────────────────────────────────────────
describe('hashRow', () => {
  it('produces a consistent SHA256 hex string', () => {
    const hash = hashRow({ date: '2025-01-01', amount: 100, merchant: 'test' })
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns different hashes for different inputs', () => {
    const h1 = hashRow({ a: 1 })
    const h2 = hashRow({ a: 2 })
    expect(h1).not.toBe(h2)
  })

  it('returns same hash for same input', () => {
    const h1 = hashRow({ date: '2025-01-01', amount: 50 })
    const h2 = hashRow({ date: '2025-01-01', amount: 50 })
    expect(h1).toBe(h2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ruleMatches — match types
// ─────────────────────────────────────────────────────────────────────────────
describe('ruleMatches', () => {
  describe('match types', () => {
    it('contains: matches substring', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park house', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx())).toBe(true)
    })

    it('contains: rejects non-matching', () => {
      const rule = makeRule({ id: 'r1', match_value: 'starbucks', bucket: 'Personal' })
      expect(ruleMatches(rule, makeTxCtx())).toBe(false)
    })

    it('contains: also checks originalDescription', () => {
      const rule = makeRule({ id: 'r1', match_value: 'original desc', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx({
        merchantNorm: 'something else',
        originalDescription: 'ORIGINAL DESC HERE',
      }))).toBe(true)
    })

    it('exact: matches exact string', () => {
      const rule = makeRule({ id: 'r1', match_value: "at&t", match_type: 'exact', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx({ merchantNorm: "at&t" }))).toBe(true)
    })

    it('exact: rejects partial match', () => {
      const rule = makeRule({ id: 'r1', match_value: "at&t", match_type: 'exact', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx({ merchantNorm: "at&t wireless" }))).toBe(false)
    })

    it('starts_with: matches prefix', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park', match_type: 'starts_with', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx())).toBe(true)
    })

    it('starts_with: rejects non-prefix', () => {
      const rule = makeRule({ id: 'r1', match_value: 'house', match_type: 'starts_with', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx())).toBe(false)
    })

    it('regex: matches pattern', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park.*houston', match_type: 'regex', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx())).toBe(true)
    })

    it('regex: rejects invalid regex gracefully', () => {
      const rule = makeRule({ id: 'r1', match_value: '(unclosed', match_type: 'regex', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx())).toBe(false)
    })

    it('regex: rejects catastrophic backtracking patterns', () => {
      const rule = makeRule({ id: 'r1', match_value: '(a+)+b', match_type: 'regex', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx({ merchantNorm: 'aaaaaaaaaaaaa' }))).toBe(false)
    })
  })

  describe('filters', () => {
    it('account_mask_filter: accepts matching mask', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park house', bucket: 'Peak 10', account_mask_filter: '5829' })
      expect(ruleMatches(rule, makeTxCtx({ accountMask: '5829' }))).toBe(true)
    })

    it('account_mask_filter: rejects non-matching mask', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park house', bucket: 'Peak 10', account_mask_filter: '2255' })
      expect(ruleMatches(rule, makeTxCtx({ accountMask: '5829' }))).toBe(false)
    })

    it('amount_min: rejects below minimum', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park house', bucket: 'Peak 10', amount_min: 200 })
      expect(ruleMatches(rule, makeTxCtx({ amount: 150 }))).toBe(false)
    })

    it('amount_max: rejects above maximum', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park house', bucket: 'Peak 10', amount_max: 100 })
      expect(ruleMatches(rule, makeTxCtx({ amount: 150 }))).toBe(false)
    })

    it('amount range: accepts within range', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park house', bucket: 'Peak 10', amount_min: 100, amount_max: 200 })
      expect(ruleMatches(rule, makeTxCtx({ amount: 150 }))).toBe(true)
    })

    it('day_of_week_filter: accepts matching day', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park house', bucket: 'Peak 10', day_of_week_filter: '1,2,3,4' })
      expect(ruleMatches(rule, makeTxCtx({ dayOfWeek: 2 }))).toBe(true) // Tuesday
    })

    it('day_of_week_filter: rejects non-matching day', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park house', bucket: 'Peak 10', day_of_week_filter: '1,2,3,4' })
      expect(ruleMatches(rule, makeTxCtx({ dayOfWeek: 6 }))).toBe(false) // Saturday
    })

    it('date_from_filter: rejects before start', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park house', bucket: 'Peak 10', date_from_filter: '2026-01-01' })
      expect(ruleMatches(rule, makeTxCtx({ date: '2025-12-15' }))).toBe(false)
    })

    it('date_to_filter: rejects after end', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park house', bucket: 'Peak 10', date_to_filter: '2025-12-31' })
      expect(ruleMatches(rule, makeTxCtx({ date: '2026-01-05' }))).toBe(false)
    })

    it('date range: accepts within range', () => {
      const rule = makeRule({ id: 'r1', match_value: 'park house', bucket: 'Peak 10', date_from_filter: '2025-01-01', date_to_filter: '2025-12-31' })
      expect(ruleMatches(rule, makeTxCtx({ date: '2025-06-15' }))).toBe(true)
    })
  })

  describe('special conditional rules', () => {
    it('conditional_restaurant: matches when category includes restaurant', () => {
      const rule = makeRule({ id: 'r1', match_value: 'conditional_restaurant', bucket: 'Peak 10',
        account_mask_filter: '5829', amount_min: 95, day_of_week_filter: '1,2,3,4' })
      expect(ruleMatches(rule, makeTxCtx({
        categorySource: 'Restaurants & Bars',
        amount: 120,
        dayOfWeek: 2,
        accountMask: '5829',
      }))).toBe(true)
    })

    it('conditional_restaurant: rejects when category is not restaurant', () => {
      const rule = makeRule({ id: 'r1', match_value: 'conditional_restaurant', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx({ categorySource: 'Groceries' }))).toBe(false)
    })

    it('conditional_houston_restaurant: matches Houston venue', () => {
      const rule = makeRule({ id: 'r1', match_value: 'conditional_houston_restaurant', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx({ merchantNorm: 'postoak hotel bar' }))).toBe(true)
    })

    it('conditional_houston_restaurant: rejects non-Houston venue', () => {
      const rule = makeRule({ id: 'r1', match_value: 'conditional_houston_restaurant', bucket: 'Peak 10' })
      expect(ruleMatches(rule, makeTxCtx({ merchantNorm: 'starbucks downtown' }))).toBe(false)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// classifyTransaction
// ─────────────────────────────────────────────────────────────────────────────
describe('classifyTransaction', () => {
  const db = mockDb()

  it('first matching rule wins (by priority)', () => {
    const rules: Rule[] = [
      makeRule({ id: 'high', match_value: 'park house', bucket: 'Peak 10', priority_order: 100, p10_category: 'Lodging' }),
      makeRule({ id: 'low', match_value: 'park', bucket: 'Personal', priority_order: 500 }),
    ]
    const result = classifyTransaction({
      description_raw: 'Park House Houston',
      amount: 200,
      transaction_date: '2025-06-10',
      account_mask: '5829',
    }, rules, db)
    expect(result.bucket).toBe('Peak 10')
    expect(result.rule_id).toBe('high')
    expect(result.review_status).toBe('auto_classified')
  })

  it('exclusion rule returns Exclude bucket', () => {
    const rules: Rule[] = [
      makeRule({ id: 'excl', match_value: 'credit card payment', bucket: 'Exclude', action: 'exclude', priority_order: 100 }),
    ]
    const result = classifyTransaction({
      description_raw: 'Credit Card Payment',
      amount: 500,
      transaction_date: '2025-06-10',
      account_mask: '5829',
    }, rules, db)
    expect(result.bucket).toBe('Exclude')
    expect(result.review_status).toBe('auto_classified')
    expect(result.action).toBe('exclude')
  })

  it('classify with flag_reason returns flagged status', () => {
    const rules: Rule[] = [
      makeRule({ id: 'flag', match_value: 'bari houston', bucket: 'Peak 10', action: 'classify',
        flag_reason: '⚠️ Add attendee names', priority_order: 307 }),
    ]
    const result = classifyTransaction({
      description_raw: 'Bari Houston',
      amount: 120,
      transaction_date: '2025-06-10',
      account_mask: '5829',
    }, rules, db)
    expect(result.bucket).toBe('Peak 10')
    expect(result.review_status).toBe('flagged')
    expect(result.flag_reason).toBe('⚠️ Add attendee names')
  })

  it('ask_kyle action returns pending_review', () => {
    const rules: Rule[] = [
      makeRule({ id: 'ask', match_value: 'doordash', bucket: 'Personal', action: 'ask_kyle',
        flag_reason: 'Ask Kyle: P10 or personal?', priority_order: 806 }),
    ]
    const result = classifyTransaction({
      description_raw: 'DoorDash',
      amount: 45,
      transaction_date: '2025-06-10',
      account_mask: '5829',
    }, rules, db)
    expect(result.review_status).toBe('pending_review')
    expect(result.action).toBe('ask_kyle')
  })

  it('split_flag action returns pending_review', () => {
    const rules: Rule[] = [
      makeRule({ id: 'split', match_value: 'southwest airlines', bucket: 'Peak 10', action: 'split_flag',
        flag_reason: 'Confirm per flight', priority_order: 700 }),
    ]
    const result = classifyTransaction({
      description_raw: 'Southwest Airlines',
      amount: 400,
      transaction_date: '2025-06-10',
      account_mask: '5829',
    }, rules, db)
    expect(result.review_status).toBe('pending_review')
    expect(result.action).toBe('split_flag')
  })

  it('skips inactive rules', () => {
    const rules: Rule[] = [
      { ...makeRule({ id: 'inactive', match_value: 'park house', bucket: 'Peak 10', priority_order: 100 }), is_active: 0 },
    ]
    const result = classifyTransaction({
      description_raw: 'Park House Houston',
      amount: 200,
      transaction_date: '2025-06-10',
      account_mask: '5829',
    }, rules, db)
    // No rule matched, amount > $25 → pending_review
    expect(result.review_status).toBe('pending_review')
    expect(result.rule_id).toBeNull()
  })

  describe('default fallback behavior', () => {
    it('amount <= $25 with no matching rule → Personal, auto_classified', () => {
      const result = classifyTransaction({
        description_raw: 'Unknown Small Vendor',
        amount: 15,
        transaction_date: '2025-06-10',
        account_mask: '5829',
      }, [], db)
      expect(result.bucket).toBe('Personal')
      expect(result.review_status).toBe('auto_classified')
      expect(result.rule_id).toBeNull()
    })

    it('amount > $25 with no matching rule → pending_review', () => {
      const result = classifyTransaction({
        description_raw: 'Unknown Large Vendor',
        amount: 100,
        transaction_date: '2025-06-10',
        account_mask: '5829',
      }, [], db)
      expect(result.bucket).toBeNull()
      expect(result.review_status).toBe('pending_review')
      expect(result.rule_id).toBeNull()
    })

    it('negative amounts are normalized (absolute value)', () => {
      // A -$10 refund should have |amount| = $10 < $25 → Personal
      const result = classifyTransaction({
        description_raw: 'Refund From Vendor',
        amount: -10,
        transaction_date: '2025-06-10',
        account_mask: '5829',
      }, [], db)
      expect(result.bucket).toBe('Personal')
      expect(result.review_status).toBe('auto_classified')
    })
  })

  it('conditional_restaurant suppressed during personal trip', () => {
    const tripDb = mockDb([{ start_date: '2025-06-09', end_date: '2025-06-12' }])
    const rules: Rule[] = [
      makeRule({ id: 'cond', match_value: 'conditional_restaurant', bucket: 'Peak 10',
        account_mask_filter: '5829', amount_min: 95, day_of_week_filter: '1,2,3,4',
        flag_reason: '⚠️ Add attendee names', priority_order: 400 }),
    ]
    const result = classifyTransaction({
      description_raw: 'Some Restaurant',
      amount: 150,
      transaction_date: '2025-06-10',
      account_mask: '5829',
      category_source: 'Restaurants & Bars',
    }, rules, tripDb)
    // Should NOT match the conditional rule because it's during a personal trip
    expect(result.rule_id).not.toBe('cond')
  })
})
