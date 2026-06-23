// electron/services/lock-eval.ts
//
// Pure lock-conflict decision — no electron imports, so it is unit-testable.
//
// The database lives in a OneDrive-synced folder, so the lock exists to stop two
// MACHINES from writing it at once. A recent lock from ANOTHER machine is a real
// "open elsewhere" conflict worth warning about. But a lock from THIS machine is
// a stale leftover (a crash or force-close that didn't release it, or OneDrive
// re-syncing the file) — Electron's single-instance guard already prevents a real
// same-machine clash — so it should be reclaimed silently, NOT shown as a scary
// "in use on another machine" banner. Any lock older than 10 minutes is stale too.

export const LOCK_STALE_MS = 10 * 60 * 1000

export function evaluateLock(
  lock: { hostname?: string; timestamp?: string } | null | undefined,
  myHostname: string,
  nowMs: number
): 'conflict' | 'reclaim' {
  if (!lock || !lock.timestamp) return 'reclaim'
  const ts = Date.parse(lock.timestamp)
  if (Number.isNaN(ts)) return 'reclaim'
  const ageMs = nowMs - ts
  const sameMachine = (lock.hostname ?? '') === myHostname
  // Only a recent lock from a *different* machine is a genuine conflict.
  if (!sameMachine && ageMs < LOCK_STALE_MS) return 'conflict'
  return 'reclaim'
}
