// electron/services/transaction-split.ts
//
// Split one transaction into N child transactions. Extracted from the
// `transactions:split` IPC handler so it can be unit-tested.
//
// ROOT CAUSE this fixes: the renderer (AssignmentWizard) sends each fragment as
// { bucket, amount, p10_category?, llc_category?, description_notes? } — the same
// shape the classify path and the DB columns use. The old handler read the stale
// shape `frag.category` / `frag.notes`, so `frag.category` was ALWAYS undefined,
// and `frag.bucket === 'Peak 10' ? frag.category : null` bound `undefined` for any
// fragment sent to Peak 10 / Moonsmoke LLC. sql.js rejects undefined →
// "Wrong API use : tried to bind a value of an unknown type (undefined)".
// (It also silently dropped each fragment's notes.) Aligning to the renderer's
// shape — with `?? null` for the optional fields — fixes both.

import type { CompatDb } from './database'

export interface SplitFragment {
  bucket: string
  amount: number
  p10_category?: string | null
  llc_category?: string | null
  description_notes?: string | null
}

export interface SplitResult { success: boolean; error?: string; created?: number }

export function splitTransaction(db: CompatDb, parentId: string, fragments: SplitFragment[]): SplitResult {
  if (!parentId) return { success: false, error: 'Missing parent transaction id' }

  // Drop malformed fragments (no entity / non-numeric amount) and require ≥2.
  const clean = (fragments ?? []).filter(f => f && f.bucket && Number.isFinite(f.amount))
  if (clean.length < 2) {
    return { success: false, error: 'A split needs at least 2 fragments, each with an entity and a numeric amount.' }
  }

  const { v4: uuidv4 } = require('uuid')
  const insertChild = db.prepare(
    `INSERT INTO transactions
       (id, account_id, transaction_date, description_raw, merchant_name, amount,
        bucket, p10_category, llc_category, description_notes, review_status,
        split_parent_id, is_split_child, created_at, updated_at)
     SELECT ?, account_id, transaction_date, description_raw, merchant_name, ?,
        ?, ?, ?, ?, 'manually_classified', ?, 1, datetime('now'), datetime('now')
     FROM transactions WHERE id = ?`
  )

  const run = db.transaction(() => {
    // The parent stays as the record-of-origin but is superseded by its children
    // in every total (all sum queries exclude a tx that HAS split children).
    db.prepare(
      "UPDATE transactions SET is_split_child = 0, review_status = 'manually_classified', updated_at = datetime('now') WHERE id = ?"
    ).run(parentId)

    for (const f of clean) {
      insertChild.run(
        uuidv4(), f.amount, f.bucket,
        f.p10_category ?? null, f.llc_category ?? null, f.description_notes ?? null,
        parentId, parentId
      )
    }
  })
  run()

  return { success: true, created: clean.length }
}
