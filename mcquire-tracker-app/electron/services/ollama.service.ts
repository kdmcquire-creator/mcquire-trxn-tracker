/**
 * Ollama Local AI Service
 *
 * Connects to a locally-running Ollama instance (http://localhost:11434)
 * to provide intelligent transaction classification that considers:
 * - Merchant name and normalized form
 * - Which card/account was used
 * - Transaction amount
 * - Day of week and date patterns
 * - Category source from Plaid
 * - Historical classification decisions for similar transactions
 *
 * The LLM builds nuanced patterns: "DoorDash on card 5829 on a weekday
 * over $50 is Peak 10, but DoorDash on card 9007 on a weekend is Personal."
 */

import type { CompatDb } from './database'
import type { Bucket } from '../../src/shared/types'

const OLLAMA_BASE_URL = 'http://localhost:11434'
const DEFAULT_MODEL = 'mistral'

interface OllamaClassification {
  bucket: Bucket
  p10_category: string | null
  llc_category: string | null
  confidence: number
  reasoning: string
}

interface TransactionContext {
  merchant_name: string | null
  description_raw: string
  amount: number
  transaction_date: string
  account_mask: string
  category_source: string | null
  flag_reason: string | null
  day_of_week: string
}

interface HistoricalDecision {
  bucket: string
  p10_category: string | null
  llc_category: string | null
  description_notes: string | null
  account_mask: string
  amount: number
  transaction_date: string
  day_of_week: string
}

// ─── Configuration ────────────────────────────────────────────────────────────

let _ollamaModel: string = DEFAULT_MODEL
let _ollamaEnabled: boolean = false

export function configureOllama(opts: { model?: string; enabled?: boolean }): void {
  if (opts.model !== undefined) _ollamaModel = opts.model
  if (opts.enabled !== undefined) _ollamaEnabled = opts.enabled
}

export function isOllamaEnabled(): boolean {
  return _ollamaEnabled
}

export function getOllamaModel(): string {
  return _ollamaModel
}

// ─── Connection test ──────────────────────────────────────────────────────────

export async function testOllamaConnection(): Promise<{ connected: boolean; models: string[]; error?: string }> {
  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) return { connected: false, models: [], error: `HTTP ${resp.status}` }
    const data = await resp.json()
    const models = (data.models ?? []).map((m: any) => m.name as string)
    return { connected: true, models }
  } catch (err: any) {
    return { connected: false, models: [], error: err.message ?? 'Connection failed' }
  }
}

// ─── Classification ───────────────────────────────────────────────────────────

export async function classifyWithOllama(
  tx: TransactionContext,
  history: HistoricalDecision[],
  availableBuckets: string[],
  p10Categories: readonly string[],
  llcCategories: readonly string[]
): Promise<OllamaClassification | null> {
  if (!_ollamaEnabled) return null

  const prompt = buildClassificationPrompt(tx, history, availableBuckets, p10Categories, llcCategories)

  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: _ollamaModel,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 300 },
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!resp.ok) return null
    const data = await resp.json()
    const response = data.response ?? ''

    return parseClassificationResponse(response, availableBuckets, p10Categories, llcCategories)
  } catch {
    return null
  }
}

// ─── Multi-factor contradiction analysis ──────────────────────────────────────

export async function analyzeContradiction(
  tx: TransactionContext,
  currentBucket: string,
  newBucket: string,
  history: HistoricalDecision[]
): Promise<{ isTrue: boolean; reasoning: string } | null> {
  if (!_ollamaEnabled) return null

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const txDay = dayNames[new Date(tx.transaction_date + 'T12:00:00').getDay()]

  const prompt = `You are a financial transaction classifier for a business executive.

A transaction was auto-classified as "${currentBucket}" but the user just classified a similar transaction as "${newBucket}".

Transaction in question:
- Merchant: ${tx.merchant_name ?? tx.description_raw}
- Amount: $${Math.abs(tx.amount).toFixed(2)}
- Date: ${tx.transaction_date} (${txDay})
- Card: ···${tx.account_mask}
- Plaid category: ${tx.category_source ?? 'unknown'}

The user's recent decisions for this merchant:
${history.slice(0, 10).map(h => `  - ${h.transaction_date} (${h.day_of_week}) card ···${h.account_mask} $${Math.abs(h.amount).toFixed(2)} → ${h.bucket}${h.p10_category ? ' (' + h.p10_category + ')' : ''}`).join('\n')}

Based on the PATTERN of decisions (card used, day of week, amount), is the auto-classification of "${currentBucket}" likely WRONG for this specific transaction?

Respond with ONLY valid JSON:
{"is_contradiction": true/false, "reasoning": "one sentence explanation"}`

  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: _ollamaModel,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 150 },
      }),
      signal: AbortSignal.timeout(20000),
    })

    if (!resp.ok) return null
    const data = await resp.json()
    const response = data.response ?? ''
    const jsonMatch = response.match(/\{[^}]+\}/)
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0])
    return { isTrue: !!parsed.is_contradiction, reasoning: parsed.reasoning ?? '' }
  } catch {
    return null
  }
}

// ─── History loader ───────────────────────────────────────────────────────────

export function loadHistoricalDecisions(db: CompatDb, merchantName: string): HistoricalDecision[] {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  const rows = db.prepare(`
    SELECT t.bucket, t.p10_category, t.llc_category, t.description_notes,
           a.account_mask, t.amount, t.transaction_date
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.merchant_name = ?
      AND t.review_status = 'manually_classified'
    ORDER BY t.transaction_date DESC
    LIMIT 20
  `).all(merchantName) as Array<{
    bucket: string; p10_category: string | null; llc_category: string | null;
    description_notes: string | null; account_mask: string; amount: number; transaction_date: string
  }>

  return rows.map(r => ({
    ...r,
    day_of_week: dayNames[new Date(r.transaction_date + 'T12:00:00').getDay()],
  }))
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildClassificationPrompt(
  tx: TransactionContext,
  history: HistoricalDecision[],
  availableBuckets: string[],
  p10Categories: readonly string[],
  llcCategories: readonly string[]
): string {
  const historyBlock = history.length > 0
    ? `\nHistorical decisions for this merchant:\n${history.map(h =>
        `  - ${h.transaction_date} (${h.day_of_week}) card ···${h.account_mask} $${Math.abs(h.amount).toFixed(2)} → ${h.bucket}${h.p10_category ? ' (' + h.p10_category + ')' : ''}${h.llc_category ? ' (' + h.llc_category + ')' : ''}${h.description_notes ? ' [notes: ' + h.description_notes + ']' : ''}`
      ).join('\n')}`
    : '\nNo historical decisions found for this merchant.'

  return `You are a financial transaction classifier for Kyle McQuire, CEO of Peak 10 Energy (oil & gas company in the Permian Basin). He has multiple entities:

Entities (buckets): ${availableBuckets.join(', ')}

Peak 10 categories: ${p10Categories.join(', ')}
Moonsmoke LLC categories: ${llcCategories.join(', ')}

Key patterns:
- Card ···5829 is the Peak 10 corporate card
- Card ···9007 is a personal card
- Card ···2255 is the Moonsmoke LLC business checking
- Weekday meals at restaurants ≥$95 on card 5829 are usually Peak 10 "Meals & Meetings - external"
- Weekend/personal meals are Personal
- Fitness, coaching, wellness → Moonsmoke LLC "Executive Wellness"
- Gas stations, parking → Peak 10 "Travel"
- Software subscriptions → usually Moonsmoke LLC "Business Services - Software"

Transaction to classify:
- Merchant: ${tx.merchant_name ?? tx.description_raw}
- Raw description: ${tx.description_raw}
- Amount: $${Math.abs(tx.amount).toFixed(2)}
- Date: ${tx.transaction_date} (${tx.day_of_week})
- Card: ···${tx.account_mask}
- Plaid category: ${tx.category_source ?? 'unknown'}
${tx.flag_reason ? `- Flag: ${tx.flag_reason}` : ''}
${historyBlock}

Based on ALL available signals (merchant, card, amount, day of week, history, category), classify this transaction.

Respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{"bucket": "one of: ${availableBuckets.join(', ')}", "p10_category": "category or null", "llc_category": "category or null", "confidence": 0.0-1.0, "reasoning": "one sentence"}`
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parseClassificationResponse(
  response: string,
  availableBuckets: string[],
  p10Categories: readonly string[],
  llcCategories: readonly string[]
): OllamaClassification | null {
  try {
    const jsonMatch = response.match(/\{[^}]*"bucket"[^}]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])
    const bucket = parsed.bucket as string

    if (!availableBuckets.includes(bucket)) return null

    const p10Cat = bucket === 'Peak 10' && parsed.p10_category && p10Categories.includes(parsed.p10_category)
      ? parsed.p10_category : null
    const llcCat = bucket === 'Moonsmoke LLC' && parsed.llc_category && llcCategories.includes(parsed.llc_category)
      ? parsed.llc_category : null

    return {
      bucket: bucket as Bucket,
      p10_category: p10Cat,
      llc_category: llcCat,
      confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0.5)),
      reasoning: parsed.reasoning ?? '',
    }
  } catch {
    return null
  }
}
