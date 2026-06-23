// tests/lock-eval.test.ts
// The "database in use on another machine" banner should only fire for a RECENT
// lock from a DIFFERENT machine. This machine's own lock (a crash/force-close
// leftover, or a OneDrive re-sync) is reclaimed silently; so is any stale lock.

import { describe, it, expect } from 'vitest'
import { evaluateLock, LOCK_STALE_MS } from '../electron/services/lock-eval'

const NOW = Date.parse('2026-06-21T12:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

describe('evaluateLock', () => {
  it('reclaims this machine\'s own recent lock (the false-positive banner case)', () => {
    expect(evaluateLock({ hostname: 'KDM_Surface', timestamp: iso(1000) }, 'KDM_Surface', NOW)).toBe('reclaim')
  })

  it('flags a recent lock from another machine', () => {
    expect(evaluateLock({ hostname: 'OTHER_PC', timestamp: iso(60_000) }, 'KDM_Surface', NOW)).toBe('conflict')
  })

  it('reclaims a stale lock from another machine (> 10 min)', () => {
    expect(evaluateLock({ hostname: 'OTHER_PC', timestamp: iso(LOCK_STALE_MS + 1000) }, 'KDM_Surface', NOW)).toBe('reclaim')
  })

  it('reclaims this machine\'s stale lock', () => {
    expect(evaluateLock({ hostname: 'KDM_Surface', timestamp: iso(LOCK_STALE_MS + 1) }, 'KDM_Surface', NOW)).toBe('reclaim')
  })

  it('reclaims on corrupt / missing data', () => {
    expect(evaluateLock(null, 'KDM_Surface', NOW)).toBe('reclaim')
    expect(evaluateLock({ hostname: 'X' }, 'KDM_Surface', NOW)).toBe('reclaim')
    expect(evaluateLock({ hostname: 'X', timestamp: 'not-a-date' }, 'KDM_Surface', NOW)).toBe('reclaim')
  })
})
