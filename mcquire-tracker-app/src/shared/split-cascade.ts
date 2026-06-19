// src/shared/split-cascade.ts
//
// Auto-balance cascade for the split-transaction fragments. Pure + framework-free
// so the renderer can call it and vitest can test it.
//
// Model: every fragment EXCEPT the last is a fixed amount the user entered; the
// LAST fragment always holds the remaining balance (total − sum of the fixed
// ones). Run this after a fragment's amount is committed (on blur):
//   • editing a non-last fragment → clamp it so the fixed amounts never exceed
//     the total, then re-fill the last fragment with the new remainder;
//   • editing the last fragment to LESS than the remainder → commit it at that
//     value and append a NEW last fragment holding the new remainder.
// Amounts never go below 0 and the running total never exceeds `total`.

export interface SplitRow {
  entity: string
  amount: string
  category: string
  notes: string
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const num = (s: string): number => {
  const v = parseFloat(s)
  return Number.isFinite(v) ? v : 0
}
const EPS = 0.004

export function applySplitCascade(rows: SplitRow[], total: number, editedIndex: number): SplitRow[] {
  const T = r2(Math.abs(total))
  const out = rows.map(r => ({ ...r }))
  const lastIdx = out.length - 1
  if (lastIdx < 0) return out

  // Sum of the fixed fragments (everything except the last).
  const fixedSumExcept = (skip: number): number =>
    out.slice(0, lastIdx).reduce((s, r, idx) => (idx === skip ? s : s + num(r.amount)), 0)

  if (editedIndex < lastIdx) {
    // Non-last edit: clamp so the fixed fragments stay within the total.
    const max = r2(T - fixedSumExcept(editedIndex))
    if (out[editedIndex].amount !== '') {
      const v = Math.max(0, Math.min(num(out[editedIndex].amount), max))
      out[editedIndex].amount = String(v)
    }
    // Re-fill the last fragment with whatever remains.
    const bal = r2(T - fixedSumExcept(-1))
    out[lastIdx].amount = bal > EPS ? String(bal) : ''
    return out
  }

  // Editing the last (auto-balance) fragment.
  if (out[lastIdx].amount === '') return out
  const bal = r2(T - fixedSumExcept(-1)) // the most this fragment can hold
  const v = Math.max(0, Math.min(num(out[lastIdx].amount), bal))
  out[lastIdx].amount = String(v)
  if (v < bal - EPS) {
    // Took only part of the balance → spawn a new last fragment for the rest.
    out.push({ entity: '', amount: String(r2(bal - v)), category: '', notes: '' })
  }
  return out
}
