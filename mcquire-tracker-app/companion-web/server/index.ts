import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { getDb, closeDb, initDb } from './db.js'
// Dynamic import to handle CJS/ESM interop (classification-engine lives outside
// companion-web's "type":"module" boundary)
const classificationEngine = await import('../../electron/services/classification-engine')
const reclassifyPendingAfterRuleChange = classificationEngine.reclassifyPendingAfterRuleChange ?? (classificationEngine as any).default?.reclassifyPendingAfterRuleChange
const loadActiveRules = classificationEngine.loadActiveRules ?? (classificationEngine as any).default?.loadActiveRules
const classifyTransaction = classificationEngine.classifyTransaction ?? (classificationEngine as any).default?.classifyTransaction
const normalizeMerchant = classificationEngine.normalizeMerchant ?? (classificationEngine as any).default?.normalizeMerchant

// Load .env manually (avoid extra dependency)
const envPath = path.join(import.meta.dirname, '..', '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim()
      if (!process.env[key]) process.env[key] = val
    }
  }
}

const app = express()
const PORT = parseInt(process.env.PORT ?? '3000', 10)
const PIN = process.env.MCQUIRE_PIN ?? '1234'

// In-memory session tokens
const validTokens = new Set<string>()

app.use(express.json())
app.use(cookieParser())

// ── Auth ────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body
  if (pin !== PIN) {
    res.status(401).json({ success: false, error: 'Invalid PIN' })
    return
  }
  const token = crypto.randomUUID()
  validTokens.add(token)
  res.json({ success: true, token })
})

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token) validTokens.delete(token)
  res.json({ success: true })
})

// Auth middleware for all other /api routes
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login') return next()
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token || !validTokens.has(token)) {
    res.status(401).json({ success: false, error: 'Not authenticated' })
    return
  }
  next()
})

// ── Dashboard ───────────────────────────────────────────────────────────────

app.get('/api/dashboard', (_req, res) => {
  try {
    const db = getDb()

    const bucketRows = db.prepare(`
      SELECT t.bucket, SUM(ABS(t.amount)) as total, COUNT(*) as count
      FROM transactions t
      WHERE t.bucket != 'Exclude' AND t.bucket IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM transactions _sp WHERE _sp.split_parent_id = t.id)
      GROUP BY t.bucket
    `).all() as Array<{ bucket: string; total: number; count: number }>

    const buckets: Record<string, { total: number; count: number }> = {}
    for (const r of bucketRows) buckets[r.bucket] = { total: r.total, count: r.count }

    const reviewCount = (db.prepare(
      "SELECT COUNT(*) as n FROM transactions WHERE review_status IN ('pending_review', 'flagged')"
    ).get() as { n: number }).n

    const flaggedCount = (db.prepare(
      "SELECT COUNT(*) as n FROM transactions WHERE review_status = 'flagged'"
    ).get() as { n: number }).n

    const recentTx = db.prepare(`
      SELECT t.*, a.institution, a.account_name, a.account_mask
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE (t.bucket != 'Exclude' OR t.bucket IS NULL)
        AND NOT EXISTS (SELECT 1 FROM transactions _sp WHERE _sp.split_parent_id = t.id)
      ORDER BY t.transaction_date DESC
      LIMIT 8
    `).all()

    res.json({
      success: true,
      data: { buckets, reviewCount, flaggedCount, recentTx },
    })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ── Transactions ────────────────────────────────────────────────────────────

app.get('/api/transactions/pending', (_req, res) => {
  try {
    const db = getDb()
    const rows = db.prepare(`
      SELECT t.*, a.institution, a.account_name, a.account_mask
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.review_status IN ('pending_review', 'flagged')
        AND t.is_split_child = 0
      ORDER BY t.transaction_date DESC
      LIMIT 200
    `).all()
    res.json({ success: true, data: rows })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/transactions', (req, res) => {
  try {
    const db = getDb()
    const { bucket, startDate, endDate, search, limit } = req.query
    let sql = `
      SELECT t.*, a.institution, a.account_name, a.account_mask
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE (t.bucket != 'Exclude' OR t.bucket IS NULL)
        AND NOT EXISTS (SELECT 1 FROM transactions _sp WHERE _sp.split_parent_id = t.id)`
    const params: any[] = []
    if (bucket) { sql += ' AND t.bucket = ?'; params.push(bucket) }
    if (startDate) { sql += ' AND t.transaction_date >= ?'; params.push(startDate) }
    if (endDate) { sql += ' AND t.transaction_date <= ?'; params.push(endDate) }
    if (search) { sql += ' AND t.merchant_name LIKE ?'; params.push(`%${search}%`) }
    const limitVal = Math.max(1, Math.min(Math.floor(Number(limit) || 200), 2000))
    sql += ' ORDER BY t.transaction_date DESC LIMIT ?'
    params.push(limitVal)
    const rows = db.prepare(sql).all(...params)
    res.json({ success: true, data: rows })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post('/api/transactions/classify', (req, res) => {
  try {
    const db = getDb()
    const { id, update } = req.body
    if (!id || !update) {
      res.status(400).json({ success: false, error: 'Missing id or update' })
      return
    }
    const allowed = ['bucket', 'p10_category', 'llc_category', 'description_notes', 'review_status', 'flag_reason']
    const fields = Object.keys(update).filter(k => allowed.includes(k))
    if (fields.length === 0) {
      res.status(400).json({ success: false, error: 'No valid fields' })
      return
    }
    const set = fields.map(f => `${f} = ?`).join(', ')
    db.prepare(`UPDATE transactions SET ${set}, updated_at = datetime('now') WHERE id = ?`)
      .run(...fields.map(f => update[f]), id)
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post('/api/transactions/run-rules', (_req, res) => {
  try {
    const db = getDb()
    const result = reclassifyPendingAfterRuleChange(db)
    res.json({ success: true, ...result })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post('/api/transactions/split', (req, res) => {
  try {
    const db = getDb()
    const { parentId, fragments } = req.body
    if (!parentId || !Array.isArray(fragments) || fragments.length < 2) {
      res.status(400).json({ success: false, error: 'Missing parentId or fragments' })
      return
    }
    const run = db.transaction(() => {
      db.prepare(
        "UPDATE transactions SET is_split_child = 0, review_status = 'manually_classified', updated_at = datetime('now') WHERE id = ?"
      ).run(parentId)
      for (const frag of fragments) {
        const fragId = crypto.randomUUID()
        db.prepare(`
          INSERT INTO transactions
            (id, account_id, transaction_date, description_raw, merchant_name, amount,
             bucket, p10_category, llc_category, description_notes, review_status,
             split_parent_id, is_split_child, created_at, updated_at)
          SELECT ?, account_id, transaction_date, description_raw, merchant_name, ?,
            ?, ?, ?, ?, 'manually_classified', ?, 1, datetime('now'), datetime('now')
          FROM transactions WHERE id = ?
        `).run(
          fragId, frag.amount, frag.bucket,
          frag.bucket === 'Peak 10' ? (frag.category ?? null) : null,
          frag.bucket === 'Moonsmoke LLC' ? (frag.category ?? null) : null,
          frag.notes ?? null, parentId, parentId
        )
      }
    })
    run()
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ── Static files (production) ───────────────────────────────────────────────

const distPath = path.join(import.meta.dirname, '..', 'dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

// ── Start ───────────────────────────────────────────────────────────────────

// Initialize DB (async for sql.js) then start server
initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[companion-web] Running on http://0.0.0.0:${PORT}`)
      console.log(`[companion-web] PIN auth enabled`)
    })
  })
  .catch((err: any) => {
    console.error('[companion-web] Failed to start:', err.message)
    process.exit(1)
  })

process.on('SIGINT', () => { closeDb(); process.exit(0) })
process.on('SIGTERM', () => { closeDb(); process.exit(0) })
