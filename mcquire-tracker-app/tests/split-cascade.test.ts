// tests/split-cascade.test.ts
// The auto-balance cascade for split fragments (Kyle's spec): the next fragment
// auto-fills with the remaining balance, and lowering it spawns another.

import { describe, it, expect } from 'vitest'
import { applySplitCascade, type SplitRow } from '../src/shared/split-cascade'

const row = (amount = '', entity = ''): SplitRow => ({ entity, amount, category: '', notes: '' })
const amounts = (rows: SplitRow[]) => rows.map(r => r.amount)

describe('split amount cascade', () => {
  it('auto-fills the second fragment with the remaining balance', () => {
    // $200 transaction; user puts $80 in fragment 1.
    const out = applySplitCascade([row('80'), row('')], 200, 0)
    expect(amounts(out)).toEqual(['80', '120'])
  })

  it('spawns a third fragment when the second is lowered below the remaining', () => {
    // From [80, 120-auto], user overrides fragment 2 to $50 → fragment 3 = $70.
    const out = applySplitCascade([row('80'), row('50')], 200, 1)
    expect(amounts(out)).toEqual(['80', '50', '70'])
  })

  it('does NOT spawn when the last fragment takes the full remaining balance', () => {
    const out = applySplitCascade([row('80'), row('120')], 200, 1)
    expect(amounts(out)).toEqual(['80', '120'])
  })

  it('cascades deeper as each fragment is partially filled', () => {
    const out = applySplitCascade([row('80'), row('50'), row('30')], 200, 2)
    expect(amounts(out)).toEqual(['80', '50', '30', '40'])
  })

  it('re-balances the last fragment when an earlier one is edited', () => {
    // [80, 50, 70] → raise fragment 1 to $100 → last re-balances to $50.
    const out = applySplitCascade([row('100'), row('50'), row('70')], 200, 0)
    expect(amounts(out)).toEqual(['100', '50', '50'])
  })

  it('clamps a non-last fragment so the fixed amounts never exceed the total', () => {
    // Over-allocate fragment 1 to $250 on a $200 txn → clamped to $200, last empty.
    const out = applySplitCascade([row('250'), row('')], 200, 0)
    expect(amounts(out)).toEqual(['200', ''])
  })

  it('keeps the running total exact (uses abs of the transaction amount)', () => {
    const out = applySplitCascade([row('66.67'), row('66.67')], 200, 1)
    // last auto-absorbs the rounding remainder so the parts sum to 200.00
    const sum = out.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
    expect(Math.round(sum * 100) / 100).toBe(200)
    expect(out).toHaveLength(3)
  })

  it('clears the last fragment when nothing remains', () => {
    const out = applySplitCascade([row('120'), row('80')], 200, 1)
    // 120 fixed + 80 = 200 exactly → no spawn, last stays 80
    expect(amounts(out)).toEqual(['120', '80'])
  })
})
