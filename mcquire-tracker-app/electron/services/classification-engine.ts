import type { CompatDb } from './database'
import type { Rule, Bucket } from '../../src/shared/types'
import { createHash } from 'crypto'

// Houston-only restaurant confirmed list
const HOUSTON_ONLY_RESTAURANTS = [
  'postoak', 'arnaldo richards', 'toca madera houston', 'eugenes gulf coast',
  "eugene's gulf coast"
]

interface ClassifyResult {
  bucket: Bucket | null
  p10_category: string | null
  llc_category: string | null
  description_notes: string | null
  rule_id: string | null
  review_status: 'auto_classified' | 'pending_review' | 'flagged'
  flag_reason: string | null
  action: string
}

export function hashRow(row: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex')
}

export function normalizeMerchant(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^tst\*\s*/i, '')
    .replace(/^sq\s+\*\s*/i, '')
    .replace(/^py\s+\*/i, '')
    .replace(/\s+#\d+$/, '')
    .replace(/\s+\d{4,}$/, '')
    .replace(/[^a-z0-9\s&\-'.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function ruleMatches(rule: Rule, tx: {
  merchantNorm: string
  accountMask: string
  amount: number
  dayOfWeek: number
  date: string
  categorySource?: string
  originalDescription?: string
}): boolean {
  // match_value
  const mv = rule.match_value.toLowerCase()

  // Special conditional rules
  if (mv === 'conditional_restaurant') {
    if (!tx.categorySource?.toLowerCase().includes('restaurant') &&
        !tx.categorySource?.toLowerCase().includes('dining')) return false
    // Additional checks are done outside (personal trip dates)
  } else if (mv === 'conditional_houston_restaurant') {
    if (!HOUSTON_ONLY_RESTAURANTS.some(h => tx.merchantNorm.includes(h))) return false
  } else {
    // Normal matching
    switch (rule.match_type) {
      case 'exact':
        if (tx.merchantNorm !== mv) return false
        break
      case 'contains':
        if (!tx.merchantNorm.includes(mv) && !tx.originalDescription?.toLowerCase().includes(mv)) return false
        break
      case 'starts_with':
        if (!tx.merchantNorm.startsWith(mv)) return false
        break
      case 'regex':
        try {
          // Guard against catastrophic backtracking: reject patterns with nested quantifiers
          if (/(\+|\*|\?)\{?\d*,?\d*\}?\)*(\+|\*|\?)/.test(mv)) return false
          if (!new RegExp(mv, 'i').test(tx.merchantNorm)) return false
        } catch {
          // Invalid regex — treat as no match
          return false
        }
        break
    }
  }

  // Account mask filter
  if (rule.account_mask_filter && !tx.accountMask.includes(rule.account_mask_filter)) return false

  // Amount range
  if (rule.amount_min !== null && tx.amount < rule.amount_min) return false
  if (rule.amount_max !== null && tx.amount > rule.amount_max) return false

  // Day of week filter
  if (rule.day_of_week_filter) {
    const days = rule.day_of_week_filter.split(',').map(Number)
    if (!days.includes(tx.dayOfWeek)) return false
  }

  // Date range filters
  if (rule.date_from_filter && tx.date < rule.date_from_filter) return false
  if (rule.date_to_filter && tx.date > rule.date_to_filter) return false

  return true
}

// Cache personal trip dates to avoid querying DB on every conditional restaurant check
let _tripDateCache: { start_date: string; end_date: string }[] | null = null
let _tripDateCacheDb: CompatDb | null = null

function getPersonalTripDates(db: CompatDb): { start_date: string; end_date: string }[] {
  if (_tripDateCache && _tripDateCacheDb === db) return _tripDateCache
  _tripDateCache = db.prepare('SELECT start_date, end_date FROM personal_trip_dates').all() as {
    start_date: string; end_date: string
  }[]
  _tripDateCacheDb = db
  return _tripDateCache
}

/** Call after modifying personal_trip_dates to refresh the cache. */
export function invalidateTripDateCache(): void {
  _tripDateCache = null
  _tripDateCacheDb = null
}

function isPersonalTripDate(db: CompatDb, date: string): boolean {
  return getPersonalTripDates(db).some(t => date >= t.start_date && date <= t.end_date)
}

export function classifyTransaction(
  tx: {
    description_raw: string
    amount: number
    transaction_date: string
    account_mask: string
    category_source?: string
  },
  rules: Rule[],
  db: CompatDb
): ClassifyResult {
  const merchantNorm = normalizeMerchant(tx.description_raw)
  const date = tx.transaction_date
  const dayOfWeek = new Date(date + 'T12:00:00').getDay() // 0=Sun,1=Mon,...,6=Sat
  const amount = Math.abs(tx.amount) // normalize to positive for comparison

  const txCtx = {
    merchantNorm,
    accountMask: tx.account_mask,
    amount,
    dayOfWeek,
    date,
    categorySource: tx.category_source,
    originalDescription: tx.description_raw
  }

  for (const rule of rules) {
    if (!rule.is_active) continue

    if (!ruleMatches(rule, txCtx)) continue

    // Special case: conditional restaurant rule — check personal trip dates
    if (rule.match_value.toLowerCase() === 'conditional_restaurant') {
      if (isPersonalTripDate(db, date)) continue
    }

    // Rule matched
    switch (rule.action) {
      case 'exclude':
        return { bucket: 'Exclude', p10_category: null, llc_category: null,
          description_notes: null, rule_id: rule.id, review_status: 'auto_classified',
          flag_reason: null, action: 'exclude' }

      case 'classify': {
        const flagged = !!rule.flag_reason
        return {
          bucket: rule.bucket as Bucket,
          p10_category: rule.p10_category,
          llc_category: rule.llc_category,
          description_notes: rule.description_notes,
          rule_id: rule.id,
          review_status: flagged ? 'flagged' : 'auto_classified',
          flag_reason: rule.flag_reason,
          action: 'classify'
        }
      }

      case 'ask_kyle':
      case 'split_flag':
        return {
          bucket: null, p10_category: null, llc_category: null,
          description_notes: null, rule_id: rule.id,
          review_status: 'pending_review',
          flag_reason: rule.flag_reason ?? rule.notes ?? `Requires Kyle\'s input: ${rule.rule_name}`,
          action: rule.action
        }
    }
  }

  // No rule matched — default logic
  if (amount <= 25) {
    return { bucket: 'Personal', p10_category: null, llc_category: null,
      description_notes: null, rule_id: null, review_status: 'auto_classified',
      flag_reason: null, action: 'default' }
  }

  return { bucket: null, p10_category: null, llc_category: null,
    description_notes: null, rule_id: null, review_status: 'pending_review',
    flag_reason: null, action: 'default' }
}

export function loadActiveRules(db: CompatDb): Rule[] {
  return db.prepare('SELECT * FROM rules WHERE is_active = 1 ORDER BY priority_order ASC').all() as Rule[]
}

export function classifyAndSave(
  db: CompatDb,
  transactions: Array<{
    id: string
    description_raw: string
    amount: number
    transaction_date: string
    account_mask: string
    category_source?: string
  }>
): { classified: number; queued: number } {
  const rules = loadActiveRules(db)

  const update = db.prepare(`
    UPDATE transactions SET
      merchant_name = ?, bucket = ?, p10_category = ?, llc_category = ?,
      description_notes = ?, rule_id = ?, review_status = ?, flag_reason = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `)

  let classified = 0, queued = 0
  const run = db.transaction(() => {
    for (const tx of transactions) {
      const result = classifyTransaction(tx, rules, db)
      const merchantNorm = normalizeMerchant(tx.description_raw)

      update.run(
        merchantNorm,
        result.bucket,
        result.p10_category,
        result.llc_category,
        result.description_notes,
        result.rule_id,
        result.review_status,
        result.flag_reason,
        tx.id
      )

      // Update vendor table
      upsertVendor(db, tx.description_raw, merchantNorm, result.rule_id)

      if (result.review_status === 'auto_classified') classified++
      else queued++
    }
  })
  run()
  return { classified, queued }
}

function upsertVendor(
  db: CompatDb,
  rawName: string,
  canonicalName: string,
  ruleId: string | null
): void {
  const existing = db.prepare('SELECT id, times_seen FROM vendors WHERE raw_name = ?').get(rawName) as
    { id: string; times_seen: number } | undefined

  if (existing) {
    db.prepare('UPDATE vendors SET times_seen = ?, last_seen = date("now"), is_known = ? WHERE raw_name = ?')
      .run(existing.times_seen + 1, ruleId ? 1 : 0, rawName)
  } else {
    const { v4: uuidv4 } = require('uuid')
    db.prepare('INSERT INTO vendors (id, raw_name, canonical_name, rule_id, times_seen, last_seen, is_known) VALUES (?,?,?,?,1,date("now"),?)')
      .run(uuidv4(), rawName, canonicalName, ruleId, ruleId ? 1 : 0)
  }
}

/**
 * Learning engine: called after every manual classification.
 *
 * 1. If the same merchant has been manually classified to the same bucket 2+ times
 *    AND no active rule covers it, auto-generate a "contains" rule.
 *
 * 2. If this manual classification contradicts how other transactions from the same
 *    merchant were auto-classified, move those to pending_review (ambiguous).
 *
 * Returns a summary of actions taken.
 */
export function learnFromClassification(
  db: CompatDb,
  txId: string
): { ruleCreated: boolean; ruleName?: string; requeuedCount: number } {
  const { v4: uuidv4 } = require('uuid')

  // Load the transaction that was just classified
  const tx = db.prepare(
    `SELECT t.*, a.account_mask FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ?`
  ).get(txId) as {
    id: string; merchant_name: string | null; description_raw: string;
    bucket: string; p10_category: string | null; llc_category: string | null;
    account_mask: string; review_status: string
  } | undefined

  if (!tx || tx.review_status !== 'manually_classified' || !tx.merchant_name) {
    return { ruleCreated: false, requeuedCount: 0 }
  }

  const merchantNorm = tx.merchant_name.toLowerCase().trim()
  let ruleCreated = false
  let ruleName: string | undefined
  let requeuedCount = 0

  // ── Step 1: Check if we should auto-create a rule ──────────────────────
  // Count how many times this merchant has been manually classified to the same bucket
  const sameClassCount = db.prepare(`
    SELECT COUNT(*) as n FROM transactions
    WHERE merchant_name = ? AND bucket = ? AND review_status = 'manually_classified'
  `).get(tx.merchant_name, tx.bucket) as { n: number }

  if (sameClassCount.n >= 2) {
    // Check if an active rule already covers this merchant
    const existingRule = db.prepare(`
      SELECT id FROM rules
      WHERE is_active = 1
        AND (match_value = ? OR (match_type = 'contains' AND ? LIKE '%' || match_value || '%'))
        AND bucket = ?
    `).get(merchantNorm, merchantNorm, tx.bucket) as { id: string } | undefined

    if (!existingRule) {
      // Determine section and priority based on bucket
      let section: string, priority: number
      switch (tx.bucket) {
        case 'Peak 10':                    section = 'p10_always';        priority = 395; break
        case 'Moonsmoke LLC':              section = 'llc_always';        priority = 295; break
        case 'Watersound Investments LLC': section = 'personal_override'; priority = 595; break
        case 'Personal':                   section = 'personal_override'; priority = 595; break
        default:                           section = 'personal_override'; priority = 595
      }

      // Create a short match value by stripping common prefixes
      const matchValue = merchantNorm
        .replace(/^tst\*\s*/i, '')
        .replace(/^sq\s+\*\s*/i, '')
        .replace(/^py\s+\*/i, '')
        .replace(/\s+#\d+$/, '')
        .replace(/\s+\d{4,}$/, '')
        .trim()

      if (matchValue.length >= 3) {
        ruleName = `[Learned] ${tx.merchant_name} → ${tx.bucket}`
        const ruleId = uuidv4()
        db.prepare(`
          INSERT OR IGNORE INTO rules
            (id, rule_name, section, match_type, match_value, account_mask_filter,
             bucket, p10_category, llc_category, description_notes, action,
             priority_order, is_active, notes, created_at, updated_at)
          VALUES (?, ?, ?, 'contains', ?, NULL, ?, ?, ?, NULL, 'classify', ?, 1,
                  'Auto-generated from 2+ manual classifications', datetime('now'), datetime('now'))
        `).run(
          ruleId, ruleName, section, matchValue,
          tx.bucket, tx.p10_category ?? null, tx.llc_category ?? null,
          priority
        )
        ruleCreated = true
        console.log(`[Learning] Created rule: "${ruleName}" (match: contains "${matchValue}")`)
      }
    }
  }

  // ── Step 2: Flag contradicting auto-classified transactions ────────────
  // If we just said "merchant X is Peak 10" but other transactions from merchant X
  // were auto-classified as something else, those are now ambiguous.
  const contradictions = db.prepare(`
    SELECT id FROM transactions
    WHERE merchant_name = ?
      AND bucket != ?
      AND bucket IS NOT NULL
      AND review_status = 'auto_classified'
      AND id != ?
  `).all(tx.merchant_name, tx.bucket, tx.id) as Array<{ id: string }>

  if (contradictions.length > 0) {
    const requeue = db.prepare(`
      UPDATE transactions
      SET review_status = 'pending_review',
          flag_reason = 'Ambiguous: same merchant classified differently — needs review',
          updated_at = datetime('now')
      WHERE id = ?
    `)
    const run = db.transaction(() => {
      for (const row of contradictions) requeue.run(row.id)
    })
    run()
    requeuedCount = contradictions.length
    console.log(`[Learning] Requeued ${requeuedCount} contradicting auto-classified txns for "${tx.merchant_name}"`)
  }

  return { ruleCreated, ruleName, requeuedCount }
}

export function reclassifyPendingAfterRuleChange(db: CompatDb): { resolved: number } {
  const pending = db.prepare(
    "SELECT t.*, a.account_mask FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.review_status = 'pending_review'"
  ).all() as Array<{ id: string; description_raw: string; amount: number; transaction_date: string; account_mask: string; category_source: string | null }>

  if (!pending.length) return { resolved: 0 }

  const rules = loadActiveRules(db)
  let resolved = 0

  const update = db.prepare(`
    UPDATE transactions SET bucket=?, p10_category=?, llc_category=?,
    description_notes=?, rule_id=?, review_status=?, flag_reason=?,
    updated_at=datetime('now') WHERE id=?
  `)

  const run = db.transaction(() => {
    for (const tx of pending) {
      const result = classifyTransaction({
        ...tx, category_source: tx.category_source ?? undefined,
        account_mask: tx.account_mask
      }, rules, db)
      if (result.review_status === 'auto_classified') {
        update.run(result.bucket, result.p10_category, result.llc_category,
          result.description_notes, result.rule_id, result.review_status, result.flag_reason, tx.id)
        resolved++
      }
    }
  })
  run()
  return { resolved }
}
