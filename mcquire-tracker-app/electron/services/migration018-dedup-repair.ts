// electron/services/migration018-dedup-repair.ts
//
// 2026-06-21 — Migration 018 (reviewed-restore) re-added 48 charges that the
// cross-account de-dup had excluded as duplicates. They had no live twin at the
// time, but the bank kept syncing the SAME charge from a second source (a second
// account record for the same card), so many now duplicate a live copy: same
// amount to the cent, dates within a few days, on a DIFFERENT account.
//
// This re-excludes the 018-restored copy of each CROSS-ACCOUNT duplicate and
// keeps the twin (the de-dup's original keep). Same-ACCOUNT near-amount rows are
// left alone on purpose — those can be real (two gas fill-ups, a fee + its
// reversal), not data duplicates. Idempotent: once re-excluded, the row drops out
// of the candidate set.

import type { CompatDb } from './database'

const WINDOW_DAYS = 3

interface Row { id: string; m: string; amt: number; d: string; ac: string }

const SELECT = (where: string) =>
  `SELECT id, COALESCE(merchant_name, description_raw, '') AS m, ROUND(ABS(amount), 2) AS amt,
          transaction_date AS d, account_id AS ac
   FROM transactions
   WHERE ${where} AND bucket != 'Exclude' AND COALESCE(is_split_child,0)=0`

const dayDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000)

// Generic words shared by unrelated charges (a Wire Fee vs a Monthly Service Fee
// both $15) — ignored so the amount match isn't enough on its own.
const GENERIC = new Set(['fee', 'service', 'monthly', 'payment', 'autopay', 'recurring', 'bill', 'the', 'inc', 'llc', 'co', 'pos'])
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
const sigTokens = (s: string) => new Set(norm(s).split(' ').filter(t => t.length >= 3 && !GENERIC.has(t)))

/** Same merchant captured by two sources: identical/substring strings, or a
 *  shared significant (non-generic) token. Rejects "Wire Fee" vs "…Service Fee". */
function merchantMatch(a: string, b: string): boolean {
  const na = norm(a), nb = norm(b)
  if (!na || !nb) return false
  if (na === nb || na.includes(nb) || nb.includes(na)) return true
  const tb = sigTokens(b)
  for (const t of sigTokens(a)) if (tb.has(t)) return true
  return false
}

export function reExcludeMigration018Duplicates(db: CompatDb): { reExcluded: number; byMerchant: Record<string, number> } {
  const restored = db.prepare(SELECT(`flag_reason LIKE '%migration 018%'`)).all() as Row[]
  const others = db.prepare(SELECT(`COALESCE(flag_reason,'') NOT LIKE '%migration 018%'`)).all() as Row[]

  const result = { reExcluded: 0, byMerchant: {} as Record<string, number> }
  const upd = db.prepare(
    `UPDATE transactions SET bucket='Exclude', p10_category=NULL, llc_category=NULL,
       review_status='auto_classified',
       flag_reason='Re-excluded cross-account duplicate (migration 021); restored by 018 but a live twin exists',
       updated_at=datetime('now')
     WHERE id=?`
  )

  db.transaction(() => {
    for (const r of restored) {
      // Cross-account twin: same amount + same merchant, within the window, on a
      // DIFFERENT account (the second data source for the same card).
      const twin = others.find(o =>
        o.amt === r.amt && o.ac !== r.ac && dayDiff(o.d, r.d) <= WINDOW_DAYS && merchantMatch(o.m, r.m))
      if (!twin) continue
      upd.run(r.id)
      result.reExcluded++
      const key = r.m.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 2).join(' ')
      result.byMerchant[key] = (result.byMerchant[key] ?? 0) + 1
    }
  })()

  return result
}
