// electron/services/database.ts
// Compatibility wrapper that provides a better-sqlite3-like API on top of sql.js.
// sql.js is pure JS/WASM — no native compilation needed (no Python, no node-gyp).

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
import * as fs from 'fs'

// ─── Public types ────────────────────────────────────────────────────────────

export interface CompatStatement {
  all(...params: any[]): any[]
  get(...params: any[]): any
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint }
}

export interface CompatDb {
  prepare(sql: string): CompatStatement
  pragma(pragma: string): any
  exec(sql: string): void
  transaction<T extends (...args: any[]) => any>(fn: T): T
  close(): void
}

// ─── Internal state ──────────────────────────────────────────────────────────

let _sqlDb: SqlJsDatabase | null = null
let _dbPath: string = ''
let _inTransaction = false
let _saveTimer: ReturnType<typeof setInterval> | null = null
let _dirty = false

// ─── Persistence ─────────────────────────────────────────────────────────────

function saveToDiskSync(): void {
  if (!_sqlDb || !_dbPath) return
  try {
    const data = _sqlDb.export()
    const tmpPath = _dbPath + '.tmp'
    fs.writeFileSync(tmpPath, Buffer.from(data))
    fs.renameSync(tmpPath, _dbPath)
    _dirty = false
  } catch (err) {
    console.error('[database] Failed to save:', err)
  }
}

function markDirty(): void {
  _dirty = true
  // Save immediately if not in a transaction (transactions batch writes)
  if (!_inTransaction) {
    saveToDiskSync()
  }
}

// ─── Wrapper ─────────────────────────────────────────────────────────────────

function wrapDb(sqlDb: SqlJsDatabase): CompatDb {
  return {
    prepare(sql: string): CompatStatement {
      return {
        all(...params: any[]): any[] {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params
          const stmt = sqlDb.prepare(sql)
          const results: any[] = []
          // sql.js bind() expects undefined for no params, or an array
          if (flatParams.length > 0) {
            stmt.bind(flatParams)
          }
          while (stmt.step()) {
            results.push(stmt.getAsObject())
          }
          stmt.free()
          return results
        },

        get(...params: any[]): any {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params
          const stmt = sqlDb.prepare(sql)
          if (flatParams.length > 0) {
            stmt.bind(flatParams)
          }
          let result = undefined
          if (stmt.step()) {
            result = stmt.getAsObject()
          }
          stmt.free()
          return result
        },

        run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
          const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params
          sqlDb.run(sql, flatParams)
          const changes = sqlDb.getRowsModified()
          // Get last_insert_rowid via a lightweight query
          const ridResult = sqlDb.exec('SELECT last_insert_rowid() as rid')
          const lastInsertRowid = ridResult.length > 0 && ridResult[0].values.length > 0
            ? (ridResult[0].values[0][0] as number)
            : 0
          markDirty()
          return { changes, lastInsertRowid }
        },
      }
    },

    pragma(pragma: string): any {
      try {
        const results = sqlDb.exec(`PRAGMA ${pragma}`)
        if (results.length > 0 && results[0].values.length > 0) {
          return results[0].values[0][0]
        }
      } catch {
        // Some pragmas don't return values
      }
    },

    exec(sql: string): void {
      sqlDb.exec(sql)
      markDirty()
    },

    transaction<T extends (...args: any[]) => any>(fn: T): T {
      // Return a function with the same signature that wraps fn in BEGIN/COMMIT
      const wrapper = ((...args: any[]) => {
        const wasAlreadyInTransaction = _inTransaction
        if (!wasAlreadyInTransaction) {
          sqlDb.run('BEGIN TRANSACTION')
          _inTransaction = true
        }
        try {
          const result = fn(...args)
          if (!wasAlreadyInTransaction) {
            sqlDb.run('COMMIT')
            _inTransaction = false
            // Save to disk once at the end of the transaction
            saveToDiskSync()
          }
          return result
        } catch (err) {
          if (!wasAlreadyInTransaction) {
            try { sqlDb.run('ROLLBACK') } catch { /* already rolled back */ }
            _inTransaction = false
          }
          throw err
        }
      }) as unknown as T
      return wrapper
    },

    close(): void {
      saveToDiskSync()
      sqlDb.close()
      _sqlDb = null
      if (_saveTimer) {
        clearInterval(_saveTimer)
        _saveTimer = null
      }
    },
  }
}

// ─── Initialization ──────────────────────────────────────────────────────────

let _compatDb: CompatDb | null = null

/**
 * Initialize the database using sql.js.
 * Returns a CompatDb that mirrors the better-sqlite3 API.
 * Must be called with `await` since sql.js WASM init is async.
 */
export async function initSqlJsDatabase(dbPath: string): Promise<CompatDb> {
  // Initialize sql.js WASM engine
  const SQL = await initSqlJs()

  let sqlDb: SqlJsDatabase
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath)
    sqlDb = new SQL.Database(fileBuffer)
  } else {
    // Create new empty database
    sqlDb = new SQL.Database()
  }

  _sqlDb = sqlDb
  _dbPath = dbPath

  _compatDb = wrapDb(sqlDb)

  // Set pragmas
  _compatDb.pragma('journal_mode = DELETE') // WAL not supported in sql.js (in-memory)
  _compatDb.pragma('foreign_keys = ON')

  // Periodic safety save every 10 seconds (in case of crash during rapid writes)
  if (_saveTimer) clearInterval(_saveTimer)
  _saveTimer = setInterval(() => {
    if (_dirty) saveToDiskSync()
  }, 10000)

  return _compatDb
}

/**
 * Get the current CompatDb instance (throws if not initialized).
 */
export function getCompatDb(): CompatDb {
  if (!_compatDb) {
    throw new Error('Database not initialized. Call initSqlJsDatabase() first.')
  }
  return _compatDb
}
