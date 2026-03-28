import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
import path from 'path'
import fs from 'fs'

let db: SqlJsDatabase | null = null
let dbPath: string = ''
let saveTimer: ReturnType<typeof setInterval> | null = null

// Compatibility wrapper that gives better-sqlite3-like API on top of sql.js
export interface CompatStatement {
  all(...params: any[]): any[]
  get(...params: any[]): any
  run(...params: any[]): { changes: number }
}

export interface CompatDb {
  prepare(sql: string): CompatStatement
  pragma(pragma: string): any
  exec(sql: string): void
  transaction<T>(fn: () => T): () => T
  close(): void
}

function wrapDb(sqlDb: SqlJsDatabase): CompatDb {
  return {
    prepare(sql: string): CompatStatement {
      return {
        all(...params: any[]): any[] {
          const stmt = sqlDb.prepare(sql)
          const results: any[] = []
          stmt.bind(params.length === 1 && Array.isArray(params[0]) ? params[0] : params)
          while (stmt.step()) {
            const row = stmt.getAsObject()
            results.push(row)
          }
          stmt.free()
          return results
        },
        get(...params: any[]): any {
          const stmt = sqlDb.prepare(sql)
          stmt.bind(params.length === 1 && Array.isArray(params[0]) ? params[0] : params)
          let result = undefined
          if (stmt.step()) {
            result = stmt.getAsObject()
          }
          stmt.free()
          return result
        },
        run(...params: any[]): { changes: number } {
          sqlDb.run(sql, params.length === 1 && Array.isArray(params[0]) ? params[0] : params)
          const changes = sqlDb.getRowsModified()
          saveToDisk()
          return { changes }
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
        // some pragmas don't return values
      }
    },
    exec(sql: string): void {
      sqlDb.exec(sql)
      saveToDisk()
    },
    transaction<T>(fn: () => T): () => T {
      return () => {
        sqlDb.run('BEGIN TRANSACTION')
        try {
          const result = fn()
          sqlDb.run('COMMIT')
          saveToDisk()
          return result
        } catch (err) {
          sqlDb.run('ROLLBACK')
          throw err
        }
      }
    },
    close(): void {
      saveToDiskSync()
      sqlDb.close()
    },
  }
}

function saveToDisk(): void {
  // Debounced — actual save happens on the interval timer
}

function saveToDiskSync(): void {
  if (!db || !dbPath) return
  try {
    const data = db.export()
    fs.writeFileSync(dbPath, Buffer.from(data))
  } catch (err) {
    console.error('[db] Failed to save:', err)
  }
}

let compatDb: CompatDb | null = null

export async function initDb(): Promise<void> {
  if (db) return

  const envPath = process.env.MCQUIRE_DB_PATH
  if (!envPath) {
    throw new Error('MCQUIRE_DB_PATH environment variable not set. Point it to your mcquire.db file.')
  }

  dbPath = path.resolve(envPath)
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found at: ${dbPath}`)
  }

  const SQL = await initSqlJs()
  const fileBuffer = fs.readFileSync(dbPath)
  db = new SQL.Database(fileBuffer)

  compatDb = wrapDb(db)
  compatDb.pragma('journal_mode = WAL')
  compatDb.pragma('foreign_keys = ON')

  // Save to disk every 5 seconds if there were writes
  saveTimer = setInterval(() => saveToDiskSync(), 5000)

  console.log(`[db] Connected to ${dbPath}`)
}

export function getDb(): CompatDb {
  if (!compatDb) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return compatDb
}

export function closeDb(): void {
  if (saveTimer) {
    clearInterval(saveTimer)
    saveTimer = null
  }
  if (compatDb) {
    compatDb.close()
    compatDb = null
    db = null
  }
}
