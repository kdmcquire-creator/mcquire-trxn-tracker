// src/main/schema.ts
// Database schema creation, migrations, and rule seeding

import * as path from 'path'
import * as fs from 'fs'
import { createHash } from 'crypto'
import { initSqlJsDatabase, type CompatDb } from '../../electron/services/database'
import { normalizeMerchant } from '../../electron/services/classification-engine'

// ─────────────────────────────────────────────────────────────────────────────
// Database initialization
// Creates all tables, sets pragmas, seeds classification rules on first run.
// ─────────────────────────────────────────────────────────────────────────────
export async function initDatabase(folder: string): Promise<CompatDb> {
  const dbDir = path.join(folder, 'db')
  fs.mkdirSync(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, 'mcquire.db')

  const database = await initSqlJsDatabase(dbPath)

  database.exec(`
    -- Accounts
    CREATE TABLE IF NOT EXISTS accounts (
      id                  TEXT PRIMARY KEY,
      plaid_item_id       TEXT NULL,
      plaid_account_id    TEXT NULL,
      institution         TEXT NOT NULL,
      account_name        TEXT NOT NULL,
      account_mask        TEXT NOT NULL,
      account_type        TEXT NOT NULL,
      entity              TEXT NOT NULL,
      default_bucket      TEXT NOT NULL,
      import_method       TEXT NOT NULL DEFAULT 'watched_folder',
      watched_folder_path TEXT NULL,
      is_active           INTEGER NOT NULL DEFAULT 1,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      last_synced_at      TEXT NULL,
      notes               TEXT NULL
    );

    -- Transactions
    CREATE TABLE IF NOT EXISTS transactions (
      id                    TEXT PRIMARY KEY,
      account_id            TEXT NOT NULL REFERENCES accounts(id),
      plaid_transaction_id  TEXT NULL UNIQUE,
      source_row_hash       TEXT NULL UNIQUE,
      transaction_date      TEXT NOT NULL,
      posting_date          TEXT NULL,
      description_raw       TEXT NOT NULL DEFAULT '',
      merchant_name         TEXT NULL,
      amount                REAL NOT NULL,
      category_source       TEXT NULL,
      bucket                TEXT NULL,
      p10_category          TEXT NULL,
      llc_category          TEXT NULL,
      description_notes     TEXT NULL,
      rule_id               TEXT NULL,
      review_status         TEXT NOT NULL DEFAULT 'pending_review',
      flag_reason           TEXT NULL,
      split_parent_id       TEXT NULL,
      is_split_child        INTEGER NOT NULL DEFAULT 0,
      period_label          TEXT NULL,
      expense_report_id     TEXT NULL,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Classification rules
    CREATE TABLE IF NOT EXISTS rules (
      id                  TEXT PRIMARY KEY,
      rule_name           TEXT NOT NULL,
      section             TEXT NOT NULL,
      match_type          TEXT NOT NULL DEFAULT 'contains',
      match_value         TEXT NOT NULL,
      account_mask_filter TEXT NULL,
      amount_min          REAL NULL,
      amount_max          REAL NULL,
      day_of_week_filter  TEXT NULL,
      date_from_filter    TEXT NULL,
      date_to_filter      TEXT NULL,
      bucket              TEXT NOT NULL,
      p10_category        TEXT NULL,
      llc_category        TEXT NULL,
      description_notes   TEXT NULL,
      flag_reason         TEXT NULL,
      action              TEXT NOT NULL DEFAULT 'classify',
      priority_order      INTEGER NOT NULL,
      is_active           INTEGER NOT NULL DEFAULT 1,
      notes               TEXT NULL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rules_priority ON rules(priority_order) WHERE is_active = 1;

    -- Performance indices for common queries
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(transaction_date);
    CREATE INDEX IF NOT EXISTS idx_tx_bucket ON transactions(bucket);
    CREATE INDEX IF NOT EXISTS idx_tx_review ON transactions(review_status);
    CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_tx_split_parent ON transactions(split_parent_id) WHERE split_parent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tx_merchant ON transactions(merchant_name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_plaid_id ON transactions(plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_hash ON transactions(source_row_hash) WHERE source_row_hash IS NOT NULL;

    -- Vendors (merchant normalization)
    CREATE TABLE IF NOT EXISTS vendors (
      id             TEXT PRIMARY KEY,
      raw_name       TEXT NOT NULL UNIQUE,
      canonical_name TEXT NOT NULL,
      rule_id        TEXT NULL,
      times_seen     INTEGER NOT NULL DEFAULT 1,
      last_seen      TEXT NOT NULL,
      is_known       INTEGER NOT NULL DEFAULT 0
    );

    -- Investments
    CREATE TABLE IF NOT EXISTS investments (
      id                                TEXT PRIMARY KEY,
      account_id                        TEXT NOT NULL REFERENCES accounts(id),
      plaid_investment_transaction_id   TEXT NULL UNIQUE,
      record_type                       TEXT NOT NULL,
      security_name                     TEXT NULL,
      ticker                            TEXT NULL,
      quantity                          REAL NULL,
      price                             REAL NULL,
      market_value                      REAL NULL,
      cost_basis                        REAL NULL,
      transaction_type                  TEXT NULL,
      transaction_amount                REAL NULL,
      transaction_date                  TEXT NULL,
      snapshot_date                     TEXT NULL,
      currency                          TEXT NOT NULL DEFAULT 'USD',
      created_at                        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Expense reports
    CREATE TABLE IF NOT EXISTS expense_reports (
      id                TEXT PRIMARY KEY,
      report_period     TEXT NOT NULL,
      date_generated    TEXT NOT NULL,
      file_path         TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'draft',
      total_amount      REAL NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      notes             TEXT NULL
    );

    -- Plaid items (one per institution connection)
    CREATE TABLE IF NOT EXISTS plaid_items (
      id                   TEXT PRIMARY KEY,
      institution_id       TEXT NOT NULL,
      institution_name     TEXT NOT NULL,
      plaid_item_id        TEXT NOT NULL UNIQUE,
      status               TEXT NOT NULL DEFAULT 'active',
      error_code           TEXT NULL,
      consent_expiry       TEXT NULL,
      last_successful_sync TEXT NULL,
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Sync log
    CREATE TABLE IF NOT EXISTS sync_log (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type               TEXT NOT NULL,
      account_id              TEXT NULL,
      source_file             TEXT NULL,
      transactions_found      INTEGER NOT NULL DEFAULT 0,
      transactions_new        INTEGER NOT NULL DEFAULT 0,
      transactions_duplicate  INTEGER NOT NULL DEFAULT 0,
      transactions_classified INTEGER NOT NULL DEFAULT 0,
      transactions_queued     INTEGER NOT NULL DEFAULT 0,
      status                  TEXT NOT NULL DEFAULT 'success',
      error_message           TEXT NULL,
      started_at              TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at            TEXT NULL
    );

    -- Personal trip exclusion dates (for Mon-Thu restaurant rule)
    CREATE TABLE IF NOT EXISTS personal_trip_dates (
      id         TEXT PRIMARY KEY,
      trip_name  TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date   TEXT NOT NULL
    );

    -- Settings (key-value)
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Migration tracking
    CREATE TABLE IF NOT EXISTS migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Seed default settings
  const insertSetting = database.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  )
  insertSetting.run('plaid_env', 'development')
  insertSetting.run('auto_sync_enabled', '1')
  insertSetting.run('auto_sync_cron', '0 2 * * *')
  insertSetting.run('review_email_threshold', '1')
  insertSetting.run('peak10_already_reimbursed_through', '2025-11-30')

  // Seed NYC personal trip exclusion
  database.prepare(
    `INSERT OR IGNORE INTO personal_trip_dates (id, trip_name, start_date, end_date)
     VALUES ('nyc-nov-2025', 'NYC Trip (Personal)', '2025-11-24', '2025-11-28')`
  ).run()

  // Seed all classification rules (from workflow doc Section 4)
  seedClassificationRules(database)

  // Run one-time data migrations
  runMigrations(database)

  return database
}

// ─────────────────────────────────────────────────────────────────────────────
// One-time migrations — safe to run on every startup (INSERT OR IGNORE guards)
// ─────────────────────────────────────────────────────────────────────────────
function runMigrations(database: CompatDb): void {
  const applied = (id: string) =>
    !!database.prepare('SELECT id FROM migrations WHERE id = ?').get(id)

  // Migration 001: fix conditional restaurant rule match_value
  if (!applied('001-conditional-restaurant-fix')) {
    database
      .prepare("UPDATE rules SET match_value = 'conditional_restaurant' WHERE id = 'p10-cond-001' AND match_value = 'restaurant'")
      .run()
    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('001-conditional-restaurant-fix')
  }

  // Migration 002: fix CSV-imported transaction amounts
  if (!applied('002-csv-amount-sign-fix')) {
    const result = database
      .prepare(`
        UPDATE transactions
        SET amount = -amount, updated_at = datetime('now')
        WHERE source_row_hash IS NOT NULL
          AND plaid_transaction_id IS NULL
      `)
      .run()
    console.log(`[Migration 002] Flipped signs on ${result.changes} CSV-imported transactions`)
    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('002-csv-amount-sign-fix')
  }

  // Migration 003: deduplicate CSV vs Plaid overlap (superseded by 004)
  if (!applied('003-csv-plaid-dedup')) {
    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('003-csv-plaid-dedup')
  }

  // Migration 004: deduplicate CSV vs Plaid overlap, matching on account_mask
  if (!applied('004-csv-plaid-dedup-by-mask')) {
    const csvDuplicates = database.prepare(`
      SELECT c.id
      FROM transactions c
      JOIN accounts ca ON ca.id = c.account_id
      WHERE c.source_row_hash IS NOT NULL
        AND c.plaid_transaction_id IS NULL
        AND c.review_status != 'manually_classified'
        AND (
          SELECT COUNT(*)
          FROM transactions p
          JOIN accounts pa ON pa.id = p.account_id
          WHERE p.plaid_transaction_id IS NOT NULL
            AND p.source_row_hash IS NULL
            AND pa.account_mask = ca.account_mask
            AND p.amount = c.amount
            AND ABS(julianday(p.transaction_date) - julianday(c.transaction_date)) <= 5
        ) = 1
    `).all() as Array<{ id: string }>

    if (csvDuplicates.length > 0) {
      const exclude = database.prepare(`
        UPDATE transactions
        SET bucket = 'Exclude', review_status = 'auto_classified', updated_at = datetime('now')
        WHERE id = ?
      `)
      const run = database.transaction(() => {
        for (const row of csvDuplicates) exclude.run(row.id)
      })
      run()
      console.log(`[Migration 004] Excluded ${csvDuplicates.length} CSV records superseded by Plaid`)
    }

    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('004-csv-plaid-dedup-by-mask')
  }

  // Migration 005: detect and exclude cross-account duplicate transactions
  if (!applied('005-cross-account-dedup')) {
    const dupes = database.prepare(`
      SELECT t2.id
      FROM transactions t1
      JOIN transactions t2
        ON t2.merchant_name = t1.merchant_name
        AND t2.amount = t1.amount
        AND t2.transaction_date = t1.transaction_date
        AND t2.account_id != t1.account_id
        AND t2.id != t1.id
      WHERE t1.bucket != 'Exclude'
        AND t2.bucket != 'Exclude'
        AND t1.merchant_name IS NOT NULL
        AND t1.created_at < t2.created_at
    `).all() as Array<{ id: string }>

    if (dupes.length > 0) {
      const excludeDupe = database.prepare(`
        UPDATE transactions
        SET bucket = 'Exclude', review_status = 'auto_classified',
            flag_reason = 'Cross-account duplicate (migration 005)',
            updated_at = datetime('now')
        WHERE id = ?
      `)
      const run = database.transaction(() => {
        for (const row of dupes) excludeDupe.run(row.id)
      })
      run()
      console.log(`[Migration 005] Excluded ${dupes.length} cross-account duplicate transactions`)
    }

    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('005-cross-account-dedup')
  }

  // Migration 006: backfill source_row_hash for Plaid transactions
  if (!applied('006-backfill-source-row-hash')) {
    const txsWithoutHash = database.prepare(`
      SELECT t.id, t.transaction_date, t.amount, t.merchant_name, a.account_mask
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.source_row_hash IS NULL
        AND t.plaid_transaction_id IS NOT NULL
    `).all() as Array<{ id: string; transaction_date: string; amount: number; merchant_name: string; account_mask: string }>

    if (txsWithoutHash.length > 0) {
      const updateHash = database.prepare('UPDATE transactions SET source_row_hash = ? WHERE id = ?')
      const run = database.transaction(() => {
        for (const tx of txsWithoutHash) {
          const hash = createHash('sha256')
            .update(JSON.stringify({
              date: tx.transaction_date,
              amount: tx.amount,
              merchant: tx.merchant_name,
              account_mask: tx.account_mask,
            }))
            .digest('hex')
          try {
            updateHash.run(hash, tx.id)
          } catch {
            // Skip — duplicate hash means duplicate transaction
          }
        }
      })
      run()
      console.log(`[Migration 006] Backfilled source_row_hash for ${txsWithoutHash.length} Plaid transactions`)
    }

    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('006-backfill-source-row-hash')
  }

  // Migration 007: rehash CSV-imported transactions to match Plaid hash format,
  // then exclude any that collide with an existing Plaid record.
  // This fixes the DoorDash (and similar) duplicate bug where CSV and Plaid
  // produced different hashes for the same transaction.
  if (!applied('007-csv-rehash-dedup')) {
    const normMerch = normalizeMerchant

    // Find all CSV-imported transactions (have source_row_hash, no plaid_transaction_id)
    const csvTxs = database.prepare(`
      SELECT t.id, t.transaction_date, t.amount, t.merchant_name,
             t.description_raw, a.account_mask, t.review_status
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.plaid_transaction_id IS NULL
        AND t.source_row_hash IS NOT NULL
        AND t.bucket != 'Exclude'
        AND t.review_status != 'manually_classified'
    `).all() as Array<{
      id: string; transaction_date: string; amount: number;
      merchant_name: string; description_raw: string;
      account_mask: string; review_status: string
    }>

    let rehashed = 0
    let deduped = 0
    const updateHash = database.prepare('UPDATE transactions SET source_row_hash = ? WHERE id = ?')
    const excludeTx = database.prepare(`
      UPDATE transactions
      SET bucket = 'Exclude', review_status = 'auto_classified',
          flag_reason = 'CSV/Plaid duplicate (migration 007)',
          updated_at = datetime('now')
      WHERE id = ?
    `)

    const run = database.transaction(() => {
      for (const tx of csvTxs) {
        // Recompute hash using the Plaid-compatible format
        const merchantNorm = normMerch(tx.description_raw || tx.merchant_name)
        const newHash = createHash('sha256')
          .update(JSON.stringify({
            date: tx.transaction_date,
            amount: tx.amount,
            merchant: merchantNorm,
            account_mask: tx.account_mask,
          }))
          .digest('hex')

        // Check if a Plaid transaction already holds this hash
        const plaidMatch = database.prepare(
          'SELECT id FROM transactions WHERE source_row_hash = ? AND plaid_transaction_id IS NOT NULL'
        ).get(newHash) as { id: string } | undefined

        if (plaidMatch) {
          // Plaid version exists → exclude the CSV copy
          excludeTx.run(tx.id)
          deduped++
        } else {
          // No collision — update hash to the normalized format
          try { updateHash.run(newHash, tx.id); rehashed++ } catch { /* hash conflict — another CSV row already has this hash */ }
        }
      }
    })
    run()

    if (rehashed > 0 || deduped > 0) {
      console.log(`[Migration 007] Rehashed ${rehashed} CSV transactions, excluded ${deduped} duplicates`)
    }

    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('007-csv-rehash-dedup')
  }

  // Migration 008: exclude cross-account duplicates with ±1 day date tolerance
  // Catches pending-vs-posted duplicates (e.g., card 9007 pending on day N,
  // card 2419 posted on day N+1, same merchant + same amount)
  if (!applied('008-fuzzy-date-cross-account-dedup')) {
    const fuzzyDupes = database.prepare(`
      SELECT t2.id
      FROM transactions t1
      JOIN transactions t2
        ON t2.merchant_name = t1.merchant_name
        AND t2.amount = t1.amount
        AND ABS(julianday(t2.transaction_date) - julianday(t1.transaction_date)) <= 1
        AND t2.account_id != t1.account_id
        AND t2.id != t1.id
      WHERE t1.bucket != 'Exclude'
        AND t2.bucket != 'Exclude'
        AND t1.merchant_name IS NOT NULL
        AND t1.review_status IN ('auto_classified', 'manually_classified')
        AND t2.review_status IN ('auto_classified', 'pending_review')
        AND t1.created_at < t2.created_at
    `).all() as Array<{ id: string }>

    const uniqueIds = [...new Set(fuzzyDupes.map(d => d.id))]

    if (uniqueIds.length > 0) {
      const excludeDupe = database.prepare(`
        UPDATE transactions
        SET bucket = 'Exclude', review_status = 'auto_classified',
            flag_reason = 'Cross-account duplicate ±1 day (migration 008)',
            updated_at = datetime('now')
        WHERE id = ?
      `)
      const run = database.transaction(() => {
        for (const id of uniqueIds) excludeDupe.run(id)
      })
      run()
      console.log(`[Migration 008] Excluded ${uniqueIds.length} cross-account duplicates (±1 day tolerance)`)
    }

    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('008-fuzzy-date-cross-account-dedup')
  }

  // Migration 009: widen cross-account dedup to ±2 days (catches pending-to-posted gaps > 1 day)
  if (!applied('009-fuzzy-date-2day-dedup')) {
    const fuzzyDupes = database.prepare(`
      SELECT t2.id
      FROM transactions t1
      JOIN transactions t2
        ON t2.merchant_name = t1.merchant_name
        AND t2.amount = t1.amount
        AND ABS(julianday(t2.transaction_date) - julianday(t1.transaction_date)) <= 2
        AND t2.account_id != t1.account_id
        AND t2.id != t1.id
      WHERE t1.bucket != 'Exclude'
        AND t2.bucket != 'Exclude'
        AND t1.merchant_name IS NOT NULL
        AND t1.review_status IN ('auto_classified', 'manually_classified')
        AND t2.review_status IN ('auto_classified', 'pending_review')
        AND t1.created_at < t2.created_at
    `).all() as Array<{ id: string }>

    const uniqueIds = [...new Set(fuzzyDupes.map(d => d.id))]

    if (uniqueIds.length > 0) {
      const excludeDupe = database.prepare(`
        UPDATE transactions
        SET bucket = 'Exclude', review_status = 'auto_classified',
            flag_reason = 'Cross-account duplicate ±2 days (migration 009)',
            updated_at = datetime('now')
        WHERE id = ?
      `)
      const run = database.transaction(() => {
        for (const id of uniqueIds) excludeDupe.run(id)
      })
      run()
      console.log(`[Migration 009] Excluded ${uniqueIds.length} cross-account duplicates (±2 day tolerance)`)
    }

    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('009-fuzzy-date-2day-dedup')
  }

  // Migration 010: comprehensive cross-account dedup ±2 days
  // Previous migrations missed some because they filtered on review_status.
  // This one catches ALL remaining dupes: same merchant + same amount +
  // different account + within 2 days. Keeps the earlier-created transaction,
  // excludes the later one regardless of its current status.
  if (!applied('010-comprehensive-cross-account-dedup')) {
    const allDupes = database.prepare(`
      SELECT t2.id
      FROM transactions t1
      JOIN transactions t2
        ON t2.merchant_name = t1.merchant_name
        AND t2.amount = t1.amount
        AND ABS(julianday(t2.transaction_date) - julianday(t1.transaction_date)) <= 2
        AND t2.account_id != t1.account_id
        AND t2.id != t1.id
      WHERE t1.bucket != 'Exclude'
        AND t2.bucket != 'Exclude'
        AND t1.merchant_name IS NOT NULL
        AND t1.merchant_name != ''
        AND t1.created_at <= t2.created_at
    `).all() as Array<{ id: string }>

    const uniqueIds = [...new Set(allDupes.map(d => d.id))]

    if (uniqueIds.length > 0) {
      const excludeDupe = database.prepare(`
        UPDATE transactions
        SET bucket = 'Exclude', review_status = 'auto_classified',
            flag_reason = 'Cross-account duplicate ±2 days (migration 010)',
            updated_at = datetime('now')
        WHERE id = ?
      `)
      const run = database.transaction(() => {
        for (const id of uniqueIds) excludeDupe.run(id)
      })
      run()
      console.log(`[Migration 010] Excluded ${uniqueIds.length} remaining cross-account duplicates (±2 days, all statuses)`)
    }

    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('010-comprehensive-cross-account-dedup')
  }

  // Migration 011: reset expense_report_id on all transactions and clear
  // draft expense reports. No reports were actually submitted — the old
  // code tagged transactions immediately on generation, before the
  // draft/submit workflow existed.
  if (!applied('011-reset-expense-report-tags')) {
    const cleared = database.prepare(`
      UPDATE transactions SET expense_report_id = NULL, updated_at = datetime('now')
      WHERE expense_report_id IS NOT NULL
    `).run()
    database.prepare("DELETE FROM expense_reports").run()
    console.log(`[Migration 011] Reset expense_report_id on ${cleared.changes} transactions, cleared all draft reports`)
    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('011-reset-expense-report-tags')
  }

  // Migration 012: un-exclude transactions that were incorrectly caught by
  // cross-account dedup migrations (005, 008, 009, 010).
  // The ±2 day same-amount rule was too aggressive for recurring charges
  // (rent, subscriptions, utilities) that legitimately appear at the same
  // amount every month. This restores them and reclassifies.
  if (!applied('012-restore-false-positive-dedup')) {
    const falseDupes = database.prepare(`
      SELECT id, merchant_name, description_raw, amount, transaction_date, account_id
      FROM transactions
      WHERE bucket = 'Exclude'
        AND flag_reason LIKE '%Cross-account duplicate%migration%'
    `).all() as Array<{
      id: string; merchant_name: string; description_raw: string;
      amount: number; transaction_date: string; account_id: string
    }>

    if (falseDupes.length > 0) {
      // Restore: set back to pending_review so they get reclassified
      const restore = database.prepare(`
        UPDATE transactions
        SET bucket = NULL, review_status = 'pending_review',
            flag_reason = 'Restored from false-positive dedup (migration 012)',
            updated_at = datetime('now')
        WHERE id = ?
      `)
      const run = database.transaction(() => {
        for (const tx of falseDupes) restore.run(tx.id)
      })
      run()
      console.log(`[Migration 012] Restored ${falseDupes.length} false-positive dedup exclusions for reclassification`)
    }

    database.prepare("INSERT OR IGNORE INTO migrations (id) VALUES (?)").run('012-restore-false-positive-dedup')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed classification rules (all rules from the workflow document)
// Uses INSERT OR IGNORE so re-runs are safe.
// ─────────────────────────────────────────────────────────────────────────────
function seedClassificationRules(database: CompatDb): void {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO rules
      (id, rule_name, section, match_type, match_value, account_mask_filter,
       amount_min, amount_max, day_of_week_filter, date_from_filter, date_to_filter,
       bucket, p10_category, llc_category, description_notes, flag_reason, action, priority_order, notes)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const seed = database.transaction((rules: any[]) => {
    for (const r of rules) insert.run(...r)
  })

  seed([
    // ── Exclusions (100–199) ─────────────────────────────────────────────────
    ['excl-001','CC Payment Exclude','exclusion','contains','credit card payment',null,null,null,null,null,null,'Exclude',null,null,null,null,'exclude',100,''],
    ['excl-002','Transfer Exclude','exclusion','contains','transfer',null,null,null,null,null,null,'Exclude',null,null,null,null,'exclude',101,''],
    ['excl-003','Apple Card Payment Exclude','exclusion','contains','apple card payment',null,null,null,null,null,null,'Exclude',null,null,null,null,'exclude',102,''],
    ['excl-004','Payment Category Exclude','exclusion','contains','payment',null,null,null,null,null,null,'Exclude',null,null,null,null,'exclude',103,''],

    // ── LLC Always (200–299) ─────────────────────────────────────────────────
    ['llc-001','Gexa Energy','llc_always','contains','gexa energy',null,null,null,null,null,null,'Moonsmoke LLC',null,'Utilities - Home Office',null,null,'classify',200,'Houston apt electricity'],
    ['llc-002','Bilt Rent','llc_always','contains','bilt',null,null,null,null,null,null,'Moonsmoke LLC',null,'Rent - Business Lodging',null,null,'classify',201,'Houston apt rent while working away from Austin'],
    ['llc-003','Bowen River Oak','llc_always','contains','bowen river',null,null,null,null,null,null,'Moonsmoke LLC',null,'Lodging - Business Housing',null,null,'classify',202,''],
    ['llc-004','Nickson','llc_always','contains','nickson',null,null,null,null,null,null,'Moonsmoke LLC',null,'Lodging - Business Housing',null,null,'classify',203,''],
    ['llc-005','Rvefit','llc_always','contains','rvefit',null,null,null,null,null,null,'Moonsmoke LLC',null,'Executive Wellness',null,null,'classify',204,''],
    ['llc-006','TrueCoach','llc_always','contains','truecoach',null,null,null,null,null,null,'Moonsmoke LLC',null,'Executive Wellness',null,null,'classify',205,'See backdating rule 4.6a'],
    ['llc-007','Lifetime Fitness','llc_always','contains','lifetime fitness',null,null,null,null,null,null,'Moonsmoke LLC',null,'Executive Wellness',null,null,'classify',206,''],
    ['llc-008','LTFitness','llc_always','contains','ltfitness',null,null,null,null,null,null,'Moonsmoke LLC',null,'Executive Wellness',null,null,'classify',207,''],
    ['llc-009','Clubcorp','llc_always','contains','clubcorp',null,null,null,null,null,null,'Moonsmoke LLC',null,'Executive Wellness',null,null,'classify',208,'Country club executive wellness'],
    ['llc-010','Patriot Software 2255','llc_always','contains','patriot software','2255',null,null,null,null,null,'Moonsmoke LLC',null,'Business Services - Payroll',null,null,'classify',209,'Monthly payroll processing fee'],
    ['llc-011','AT&T Business Line Small','llc_always','exact','at&t','5829',null,99.99,null,null,null,'Moonsmoke LLC',null,'Telephone - Business Line',null,null,'classify',210,'Supplemental line < $100'],
    ['llc-012','Backvac','llc_always','contains','backvac',null,null,null,null,null,null,'Moonsmoke LLC',null,'Business Expenses - Other',null,null,'classify',211,''],
    ['llc-013','Apple App Store','llc_always','contains','apple.com',null,null,null,null,null,null,'Moonsmoke LLC',null,'Business Services - Software',null,null,'classify',212,'All Apple charges'],
    ['llc-014','App Store','llc_always','contains','app store',null,null,null,null,null,null,'Moonsmoke LLC',null,'Business Services - Software',null,null,'classify',213,''],
    ['llc-015','Google One','llc_always','contains','google one',null,null,null,null,null,null,'Moonsmoke LLC',null,'Business Services - Software',null,null,'classify',214,'Cloud storage — not Google Fiber'],
    ['llc-016','Microsoft','llc_always','contains','microsoft',null,null,null,null,null,null,'Moonsmoke LLC',null,'Business Services - Software',null,null,'classify',215,'Microsoft 365'],
    ['llc-017','BeenVerified','llc_always','contains','beenverified',null,null,null,null,null,null,'Moonsmoke LLC',null,'Business Services - Other',null,null,'classify',216,''],
    ['llc-018','Chase Monthly Fee 2255','llc_always','contains','monthly service fee','2255',null,null,null,null,null,'Moonsmoke LLC',null,'Bank Fees',null,null,'classify',217,'Chase BUS 2255 monthly fee'],
    ['llc-019','Chase ATM Fee 2255','llc_always','contains','atm fee','2255',null,null,null,null,null,'Moonsmoke LLC',null,'Bank Fees',null,null,'classify',218,''],
    ['llc-020','Chase Wire Fee 2255','llc_always','contains','wire fee','2255',null,null,null,null,null,'Moonsmoke LLC',null,'Bank Fees',null,null,'classify',219,''],

    // ── P10 Always (300–399) ─────────────────────────────────────────────────
    ['p10-001','Park House Houston','p10_always','contains','park house',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',300,''],
    ['p10-002','Houston Club Parkhouse','p10_always','contains','houston club',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',301,''],
    ['p10-003','Briar Club Jan 2026+','p10_always','contains','briar club',null,null,null,null,'2026-01-01',null,'Peak 10','Meals & Meetings - external',null,null,'⚠️ Confirm split with Kyle','split_flag',302,'Split flag — ask Kyle for P10 vs personal allocation'],
    ['p10-004','P Fitness','p10_always','contains','p fitness',null,null,null,null,null,null,'Peak 10','Other - Executive Wellness',null,null,null,'classify',303,''],
    ['p10-005','CSC Service Works','p10_always','contains','csc service works',null,null,null,null,null,null,'Peak 10','Other - Executive Wellness',null,null,null,'classify',304,''],
    ['p10-006','Fjorn Consulting','p10_always','contains','fjorn',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,'Recruiting',null,'classify',305,''],
    ['p10-007','Hart Energy','p10_always','contains','hart energy',null,null,null,null,null,null,'Peak 10','Dues & Subscriptions',null,null,null,'classify',306,''],
    ['p10-008','Bari Houston','p10_always','contains','bari houston',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,'⚠️ Add attendee names','classify',307,''],
    ['p10-009','TST Bari','p10_always','contains','tst* bari',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,'⚠️ Add attendee names','classify',308,''],
    ['p10-010','Mexta','p10_always','contains','mexta',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',309,''],
    ['p10-011','Ducky McShweeney','p10_always','contains','ducky',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',310,''],
    ['p10-012','Melrose','p10_always','contains','melrose',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',311,''],
    ['p10-013','Topgolf','p10_always','contains','topgolf',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',312,''],
    ['p10-014','Texas Richmond Corp','p10_always','contains','texas richmond',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',313,''],
    ['p10-015','Adobe 5829','p10_always','contains','adobe','5829',null,null,null,null,null,'Peak 10','Office Supplies & Expenses',null,null,null,'classify',314,''],
    ['p10-016','Bloomberg','p10_always','contains','bloomberg',null,null,null,null,null,null,'Peak 10','Dues & Subscriptions',null,null,null,'classify',315,''],
    ['p10-017','Wall Street Journal','p10_always','contains','wall street journal',null,null,null,null,null,null,'Peak 10','Dues & Subscriptions',null,null,null,'classify',316,''],
    ['p10-018','Anthropic Claude','p10_always','contains','anthropic',null,null,null,null,null,null,'Peak 10','Office Supplies & Expenses',null,null,null,'classify',317,'Claude subscription'],
    ['p10-019','Alamo Rent-A-Car','p10_always','contains','alamo rent',null,null,null,null,null,null,'Peak 10','Travel',null,null,null,'classify',318,'Not Alamo Toll'],
    ['p10-020','Hilton Hotels 5829','p10_always','contains','hilton','5829',null,null,null,null,null,'Peak 10','Lodging',null,null,null,'classify',319,''],
    ['p10-021','Four Seasons 5829','p10_always','contains','four seasons','5829',null,null,null,null,null,'Peak 10','Lodging',null,null,null,'classify',320,''],
    ['p10-022','Four Points Boat 5829','p10_always','contains','four points boat','5829',null,null,null,null,null,'Peak 10','Travel',null,null,null,'classify',321,''],
    ['p10-023','Kasa Living','p10_always','contains','kasa living',null,null,null,null,null,null,'Peak 10','Lodging',null,null,null,'classify',322,''],
    ['p10-024','AT&T Work Line 5829','p10_always','exact','at&t','5829',100,299,null,null,null,'Peak 10','Telephone & Communication',null,'Work line ~$199',null,'classify',323,''],
    ['p10-025','AT&T Large Bill Split','p10_always','exact','at&t','5829',300,null,null,null,null,'Peak 10','Telephone & Communication',null,null,'⚠️ AT&T split required — pull 832-687-0468 line cost from att.com','split_flag',324,''],
    ['p10-026','Payrix Numero 28 Austin','p10_always','contains','numero 28 austin','5829',null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',325,''],
    ['p10-027','Annual Membership Sep 2025','p10_always','contains','annual membership fee','5829',299,299,null,'2025-09-01','2025-09-30','Peak 10','Dues & Subscriptions',null,null,null,'classify',326,''],
    ['p10-028','W 2nd Street Parking','p10_always','contains','2nd street parking',null,null,null,null,null,null,'Peak 10','Travel',null,'Office parking',null,'classify',327,''],
    ['p10-029','W 2nd St Garage','p10_always','contains','2nd st garage',null,null,null,null,null,null,'Peak 10','Travel',null,'Office parking',null,'classify',328,''],
    ['p10-030','UPS','p10_always','contains','ups',null,null,null,null,null,null,'Peak 10','Office Supplies & Expenses',null,null,null,'classify',329,''],
    ['p10-031','ParkMobile','p10_always','contains','parkmobile',null,null,null,null,null,null,'Peak 10','Travel',null,null,null,'classify',330,''],
    ['p10-032','Shell Gas','p10_always','contains','shell',null,null,null,null,null,null,'Peak 10','Travel',null,'Fuel',null,'classify',331,''],
    ['p10-033','ExxonMobil','p10_always','contains','exxon',null,null,null,null,null,null,'Peak 10','Travel',null,'Fuel',null,'classify',332,''],
    ['p10-034','Buc-ees','p10_always','contains',"buc-ee",null,null,null,null,null,null,'Peak 10','Travel',null,'Fuel',null,'classify',333,''],
    ['p10-035','7-Eleven Gas','p10_always','contains','7-eleven',null,null,null,null,null,null,'Peak 10','Travel',null,'Fuel',null,'classify',334,''],
    ['p10-036','Chevron','p10_always','contains','chevron',null,null,null,null,null,null,'Peak 10','Travel',null,'Fuel',null,'classify',335,''],
    ['p10-037','Valero','p10_always','contains','valero',null,null,null,null,null,null,'Peak 10','Travel',null,'Fuel',null,'classify',336,''],

    // ── P10 Conditional (400–499) ────────────────────────────────────────────
    ['p10-cond-001','Mon-Thu Restaurant ≥$95','p10_conditional','contains','conditional_restaurant','5829',95,null,'1,2,3,4',null,null,'Peak 10','Meals & Meetings - external',null,null,'⚠️ Add attendee names','classify',400,'Mon=1 Tue=2 Wed=3 Thu=4; Monarch category = Restaurants & Bars'],
    ['p10-cond-002','Postoak Houston','p10_conditional','contains','postoak',null,45,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',401,'Houston-only venue'],
    ['p10-cond-003','Arnaldo Richards','p10_conditional','contains','arnaldo',null,45,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',402,'Houston-only venue'],
    ['p10-cond-004','Toca Madera Houston','p10_conditional','contains','toca madera',null,45,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',403,'Houston-only venue'],
    ['p10-cond-005','Eugenes Gulf Coast','p10_conditional','contains','eugene',null,45,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',404,'Houston-only venue'],
    ['p10-cond-006','Balboa Surf Club','p10_conditional','contains','balboa surf',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',405,''],
    ['p10-cond-007','Remedy Austin','p10_conditional','contains','remedy austin',null,null,null,null,null,null,'Peak 10','Meals & Meetings - external',null,null,null,'classify',406,''],

    // ── Personal Overrides (500–599) ─────────────────────────────────────────
    ['pers-001','Westlake Market','personal_override','contains','westlake market',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',500,'Personal grocery'],
    ['pers-002','Briar Club Pre-2026','personal_override','contains','briar club',null,null,null,null,null,'2025-12-31','Personal',null,null,null,null,'classify',501,'Personal membership pre-Jan 2026'],
    ['pers-003','Hotel ZaZa','personal_override','contains','zazaa',null,null,null,null,null,null,'Personal',null,null,null,null,'ask_kyle',502,'Ask Kyle: P10 business or personal?'],
    ['pers-004','Alamo Toll','personal_override','contains','alamo toll',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',503,'Driving toll — not Alamo Rent-A-Car'],
    ['pers-005','Covert Cadillac','personal_override','contains','covert cadillac',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',504,'Personal auto'],
    ['pers-006','Google Fiber','personal_override','contains','google fiber',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',505,'Home internet — not Google One'],
    ['pers-007','Stan Taylor','personal_override','contains','stan taylor',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',506,''],
    ['pers-008','Relaxing Thai Massage','personal_override','contains','relaxing thai',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',507,''],
    ['pers-009','Gimmersta','personal_override','contains','gimmersta',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',508,''],
    ['pers-010','ATX Bikes','personal_override','contains','atx bikes',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',509,''],
    ['pers-011','Mod Bikes','personal_override','contains','mod bikes',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',510,''],
    ['pers-012','Gray Taxidermy','personal_override','contains','gray taxidermy',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',511,''],
    ['pers-013','Emerald Point Ship Store','personal_override','contains','emerald point',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',512,''],
    ['pers-014','Toolsons','personal_override','contains','toolsons',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',513,''],
    ['pers-015','Onsite Partners','personal_override','contains','onsite partners',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',514,''],
    ['pers-016','Legendary Dec 2025','personal_override','contains','legendary',null,null,null,'2025-12-01','2025-12-31',null,'Personal',null,null,null,null,'classify',515,''],
    ['pers-017','Payrix Eanes ISD 9007','personal_override','contains','eanes isd','9007',null,null,null,null,null,'Personal',null,null,null,null,'classify',516,'School lunch'],
    ['pers-018','Payrix Longhorn Boat 9007','personal_override','contains','longhorn boat','9007',null,null,null,null,null,'Personal',null,null,null,null,'classify',517,'Summer camp'],
    ['pers-019','Annual Membership 9007 695','personal_override','contains','annual membership fee','9007',695,695,null,null,null,'Personal',null,null,null,null,'classify',518,'Personal club membership'],
    ['pers-020','Crosswell Counseling','personal_override','contains','crosswell',null,null,null,null,null,null,'Moonsmoke LLC',null,'Executive Wellness',null,null,'classify',519,'LLC executive wellness — not personal override despite name'],

    // ── Split Flags (700–799) ────────────────────────────────────────────────
    ['split-001','Southwest Airlines','special','contains','southwest airlines',null,null,null,null,null,null,'Peak 10',null,null,null,'⚠️ Southwest: P10 business or personal trip? Confirm per flight.','split_flag',700,''],
    ['split-002','Hotel ZaZa Split','special','contains','hotel zaza',null,null,null,null,null,null,'Peak 10',null,null,null,'⚠️ Hotel ZaZa: P10 business or personal stay?','split_flag',701,''],
    ['split-003','Payrix General','special','contains','payrix',null,null,null,null,null,null,'Peak 10',null,null,null,'⚠️ Payrix: confirm venue — school lunch (personal), camp (personal), or business meal?','ask_kyle',702,'Except 5829 Numero 28 Austin (rule p10-026) and 9007 rules above'],

    // ── Ask Kyle (800–899) ───────────────────────────────────────────────────
    ['ask-001','The Wayback','ask_kyle','contains','wayback',null,null,null,null,null,null,'Personal',null,null,null,'⚠️ Ask Kyle: P10 business meal or LLC meals & entertainment?','ask_kyle',800,''],
    ['ask-002','Sway West Lake','ask_kyle','contains','sway',null,null,null,null,null,null,'Personal',null,null,null,'⚠️ Ask Kyle: P10 or LLC business meal?','ask_kyle',801,''],
    ['ask-003','Sammies Italian','ask_kyle','contains','sammie',null,null,null,null,null,null,'Personal',null,null,null,'⚠️ Ask Kyle: P10 or LLC business meal?','ask_kyle',802,''],
    ['ask-004','Bartletts','ask_kyle','contains','bartlett',null,null,null,null,null,null,'Personal',null,null,null,'⚠️ Ask Kyle: P10 or LLC business meal?','ask_kyle',803,''],
    ['ask-005','Perlas Seafood','ask_kyle','contains','perlas',null,null,null,null,null,null,'Personal',null,null,null,'⚠️ Ask Kyle: P10 or LLC business meal?','ask_kyle',804,''],
    ['ask-006','Austin Proper Hotel','ask_kyle','contains','austin proper',null,null,null,null,null,null,'Personal',null,null,null,'⚠️ Ask Kyle: P10 lodging or LLC business housing?','ask_kyle',805,''],
    ['ask-007','DoorDash','ask_kyle','contains','doordash',null,null,null,null,null,null,'Personal',null,null,null,'⚠️ Ask Kyle: P10 business meal, LLC, or personal?','ask_kyle',806,''],
    ['ask-008','Pak Mail','ask_kyle','contains','pak mail',null,null,null,null,null,null,'Personal',null,null,null,'⚠️ Ask Kyle: P10 shipping, LLC, or personal?','ask_kyle',807,''],
    ['ask-009','Uber','ask_kyle','contains','uber',null,null,null,null,null,null,'Personal',null,null,null,'⚠️ Ask Kyle: P10 travel, LLC, or personal?','ask_kyle',808,''],

    // ── Default fallback (9000) ───────────────────────────────────────────────
    ['default-001','Default Personal','default','contains','',null,null,null,null,null,null,'Personal',null,null,null,null,'classify',9000,'Unknown vendor → Personal, flag for review if > $25'],
  ])
}
