// tests/helpers/db.ts
// Spins up a real in-memory database for integration tests.
// Uses the actual sql.js wrapper (no native deps, no Electron).

import { initSqlJsDatabase, type CompatDb } from '../../electron/services/database'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

let counter = 0

/** Create a fresh, isolated DB backed by a throwaway temp file. */
export async function makeDb(): Promise<CompatDb> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mcq-test-${process.pid}-${counter++}-`))
  const dbPath = path.join(dir, 'test.db')
  return initSqlJsDatabase(dbPath)
}

/** Minimal schema sufficient for transaction/dedup/report tests. */
export function applyCoreSchema(db: CompatDb): void {
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      institution TEXT, account_name TEXT, account_mask TEXT,
      account_type TEXT, entity TEXT, default_bucket TEXT,
      import_method TEXT DEFAULT 'plaid', is_active INTEGER DEFAULT 1,
      plaid_item_id TEXT, last_synced_at TEXT
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      plaid_transaction_id TEXT UNIQUE,
      source_row_hash TEXT UNIQUE,
      transaction_date TEXT NOT NULL,
      posting_date TEXT,
      description_raw TEXT DEFAULT '',
      merchant_name TEXT,
      amount REAL NOT NULL,
      category_source TEXT,
      bucket TEXT,
      p10_category TEXT,
      llc_category TEXT,
      description_notes TEXT,
      rule_id TEXT,
      review_status TEXT DEFAULT 'pending_review',
      flag_reason TEXT,
      split_parent_id TEXT,
      is_split_child INTEGER DEFAULT 0,
      period_label TEXT,
      expense_report_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `)
}

let txSeq = 0
export interface SeedTx {
  account_id: string
  merchant_name: string
  amount: number
  transaction_date: string
  bucket?: string | null
  review_status?: string
  p10_category?: string | null
  description_notes?: string | null
  is_split_child?: number
  split_parent_id?: string | null
  flag_reason?: string | null
}

/** Insert a transaction, returning its id. created_at increments so ordering is deterministic. */
export function insertTx(db: CompatDb, t: SeedTx): string {
  const id = `tx-${txSeq++}`
  db.prepare(`
    INSERT INTO transactions
      (id, account_id, merchant_name, description_raw, amount, transaction_date,
       bucket, review_status, p10_category, description_notes, is_split_child,
       split_parent_id, flag_reason, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `).run(
    id, t.account_id, t.merchant_name, t.merchant_name, t.amount, t.transaction_date,
    t.bucket ?? null, t.review_status ?? 'auto_classified',
    t.p10_category ?? null, t.description_notes ?? null, t.is_split_child ?? 0,
    t.split_parent_id ?? null, t.flag_reason ?? null,
    // created_at strictly increasing for deterministic "earlier" comparisons
    `2020-01-01 00:00:${String(txSeq).padStart(2, '0')}`
  )
  return id
}

export function insertAccount(db: CompatDb, id: string, mask: string): void {
  db.prepare(`
    INSERT INTO accounts (id, institution, account_name, account_mask, account_type, entity, default_bucket)
    VALUES (?, 'TestBank', ?, ?, 'credit', 'Personal', '')
  `).run(id, `Acct ${mask}`, mask)
}

/** Adds the rules + vendors tables needed by the learning engine. */
export function applyRulesSchema(db: CompatDb): void {
  db.exec(`
    CREATE TABLE rules (
      id TEXT PRIMARY KEY, rule_name TEXT, section TEXT, match_type TEXT DEFAULT 'contains',
      match_value TEXT, account_mask_filter TEXT, amount_min REAL, amount_max REAL,
      day_of_week_filter TEXT, date_from_filter TEXT, date_to_filter TEXT,
      bucket TEXT, p10_category TEXT, llc_category TEXT, description_notes TEXT,
      flag_reason TEXT, action TEXT DEFAULT 'classify', priority_order INTEGER,
      is_active INTEGER DEFAULT 1, notes TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE vendors (
      id TEXT PRIMARY KEY, raw_name TEXT UNIQUE, canonical_name TEXT, rule_id TEXT,
      times_seen INTEGER DEFAULT 1, last_seen TEXT, is_known INTEGER DEFAULT 0
    );
  `)
}
