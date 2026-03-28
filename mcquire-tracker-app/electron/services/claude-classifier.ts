// electron/services/claude-classifier.ts
// AI-powered transaction classification using Claude API
// Uses Haiku for cost-efficiency (~$0.001 per classification)

import Anthropic from '@anthropic-ai/sdk'
import { safeStorage, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { CompatDb } from './database'
import { P10_CATEGORIES, LLC_CATEGORIES } from '../../src/shared/types'

// ─── Credential storage (same pattern as Plaid) ─────────────────────────────

const CRED_KEY_CLAUDE_API = 'McQuireTracker_claude_api_key'

function getCredentialPath(key: string): string {
  return path.join(app.getPath('userData'), 'creds', key.replace(/[^a-z0-9_-]/gi, '_'))
}

export function saveClaudeApiKey(apiKey: string): void {
  const credPath = getCredentialPath(CRED_KEY_CLAUDE_API)
  fs.mkdirSync(path.dirname(credPath), { recursive: true })
  const encrypted = safeStorage.encryptString(apiKey)
  fs.writeFileSync(credPath, encrypted)
}

export function loadClaudeApiKey(): string | null {
  const credPath = getCredentialPath(CRED_KEY_CLAUDE_API)
  if (!fs.existsSync(credPath)) return null
  try {
    const encrypted = fs.readFileSync(credPath)
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}

export function hasClaudeApiKey(): boolean {
  return loadClaudeApiKey() !== null
}

export function deleteClaudeApiKey(): void {
  const credPath = getCredentialPath(CRED_KEY_CLAUDE_API)
  try { fs.unlinkSync(credPath) } catch {}
}

// ─── Classification suggestion ──────────────────────────────────────────────

export interface ClassificationSuggestion {
  bucket: string
  p10_category: string | null
  llc_category: string | null
  confidence: number
  reasoning: string
}

/** Build a context string from recent manually-classified transactions */
function buildHistoryContext(db: CompatDb, limit: number = 30): string {
  const recent = db.prepare(`
    SELECT merchant_name, amount, bucket, p10_category, llc_category, description_notes
    FROM transactions
    WHERE review_status = 'manually_classified'
      AND bucket IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    merchant_name: string | null
    amount: number
    bucket: string
    p10_category: string | null
    llc_category: string | null
    description_notes: string | null
  }>

  if (recent.length === 0) return 'No recent classification history available.'

  return recent.map(r =>
    `${r.merchant_name ?? 'unknown'} | $${Math.abs(r.amount).toFixed(2)} → ${r.bucket}${r.p10_category ? ` (${r.p10_category})` : ''}${r.llc_category ? ` (${r.llc_category})` : ''}`
  ).join('\n')
}

export async function suggestClassification(
  tx: {
    description_raw: string
    merchant_name?: string | null
    amount: number
    transaction_date: string
    account_mask?: string
    category_source?: string | null
    flag_reason?: string | null
  },
  db: CompatDb
): Promise<ClassificationSuggestion> {
  const apiKey = loadClaudeApiKey()
  if (!apiKey) {
    throw new Error('Claude API key not configured. Add it in Settings → AI Classification.')
  }

  const anthropic = new Anthropic({ apiKey })
  const historyContext = buildHistoryContext(db)

  const p10Cats = P10_CATEGORIES.join(', ')
  const llcCats = LLC_CATEGORIES.join(', ')

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: `You are a financial classification assistant for Kyle McQuire's personal expense tracker. You classify transactions into one of these buckets:

1. **Peak 10** — Kyle's W2 employer. Business meals (with attendees), travel, lodging, office supplies, subscriptions, parking, fuel for Houston-Austin commute. P10 categories: ${p10Cats}

2. **Moonsmoke LLC** — Kyle's S-Corp. Houston apartment rent/utilities, executive wellness (gym, coaching), payroll software, business software, bank fees. LLC categories: ${llcCats}

3. **Personal** — Everything else: groceries, personal dining, personal travel, home internet, personal memberships.

4. **Exclude** — Inter-account transfers, credit card payments, duplicate charges.

Key patterns:
- Mon-Thu restaurant charges ≥$95 on card ending 5829 are likely Peak 10 business meals
- Houston-area restaurants (Postoak, Arnaldo Richards, Toca Madera, Eugene's) are likely Peak 10
- Gexa Energy, Bilt rent, gym memberships → Moonsmoke LLC
- Gas stations, parking, UPS → Peak 10 (commute/office)
- DoorDash, Uber → ask Kyle (could be any bucket)

Recent classification history (most recent first):
${historyContext}

Respond with valid JSON only. Be conservative — if unsure, set confidence below 0.6.`,
    messages: [
      {
        role: 'user',
        content: `Classify this transaction:
Merchant: ${tx.merchant_name ?? tx.description_raw}
Raw description: ${tx.description_raw}
Amount: $${Math.abs(tx.amount).toFixed(2)}${tx.amount < 0 ? ' (credit/refund)' : ''}
Date: ${tx.transaction_date}
Card: ···${tx.account_mask ?? 'unknown'}
${tx.category_source ? `Bank category: ${tx.category_source}` : ''}
${tx.flag_reason ? `Flag: ${tx.flag_reason}` : ''}

Return JSON with: bucket, p10_category (if Peak 10, else null), llc_category (if Moonsmoke LLC, else null), confidence (0-1), reasoning (brief)`
      }
    ],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''

  // Parse JSON from response — handle potential markdown wrapping
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('Failed to parse classification response')
  }

  const parsed = JSON.parse(jsonMatch[0])

  return {
    bucket: parsed.bucket ?? 'Personal',
    p10_category: parsed.p10_category ?? null,
    llc_category: parsed.llc_category ?? null,
    confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
    reasoning: parsed.reasoning ?? '',
  }
}

/** Suggest classifications for multiple transactions (batched for efficiency) */
export async function suggestBatch(
  transactions: Array<{
    id: string
    description_raw: string
    merchant_name?: string | null
    amount: number
    transaction_date: string
    account_mask?: string
    category_source?: string | null
    flag_reason?: string | null
  }>,
  db: CompatDb
): Promise<Record<string, ClassificationSuggestion>> {
  const results: Record<string, ClassificationSuggestion> = {}

  // Process sequentially to avoid rate limits — Haiku is fast enough
  for (const tx of transactions) {
    try {
      results[tx.id] = await suggestClassification(tx, db)
    } catch (err: any) {
      console.error(`[Claude] Failed to classify tx ${tx.id}:`, err.message)
      // Don't add to results — UI will show "no suggestion" for this tx
    }
  }

  return results
}
