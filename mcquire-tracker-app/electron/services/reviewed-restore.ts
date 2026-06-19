// electron/services/reviewed-restore.ts
//
// Migration 018 — one-time restoration of business charges the cross-account
// dedup wrongly excluded (no real duplicate). Kyle reviewed each against his
// statements on 2026-06-08 and assigned the bucket. Embedded as data so a DB
// rebuild reproduces the decisions. Matched by (date, amount, merchant);
// idempotent — once a row is no longer in Exclude it is skipped.

import type { CompatDb } from './database'

export interface ReviewedRestore { date: string; amount: number; merchant: string; bucket: string }

export const REVIEWED_RESTORES: ReviewedRestore[] = [
  { date: '2025-12-25', amount: 369.99, merchant: 'Backvac', bucket: 'Moonsmoke LLC' },
  { date: '2025-12-05', amount: 310.19, merchant: 'Ltfitness Product Services', bucket: 'Moonsmoke LLC' },
  { date: '2026-02-13', amount: 105.19, merchant: 'Rvefit.com', bucket: 'Moonsmoke LLC' },
  { date: '2026-01-13', amount: 105.19, merchant: 'Rvefit.com', bucket: 'Moonsmoke LLC' },
  { date: '2025-12-13', amount: 105.19, merchant: 'Rvefit.com', bucket: 'Moonsmoke LLC' },
  { date: '2026-06-05', amount: 103.65, merchant: 'shell shell', bucket: 'Moonsmoke LLC' },
  { date: '2026-02-26', amount: 100.0, merchant: 'Truecoach Remote Prog', bucket: 'Moonsmoke LLC' },
  { date: '2026-02-12', amount: 100.0, merchant: 'Truecoach Remote Prog', bucket: 'Moonsmoke LLC' },
  { date: '2026-01-29', amount: 100.0, merchant: 'Truecoach Remote Prog', bucket: 'Moonsmoke LLC' },
  { date: '2026-01-15', amount: 100.0, merchant: 'Truecoach Remote Prog', bucket: 'Moonsmoke LLC' },
  { date: '2026-05-02', amount: 88.97, merchant: 'shell shell', bucket: 'Peak 10' },
  { date: '2026-06-07', amount: 61.79, merchant: 'shell shell', bucket: 'Peak 10' },
  { date: '2026-05-02', amount: 15.56, merchant: 'shell shell', bucket: 'Peak 10' },
  { date: '2026-02-27', amount: 15.0, merchant: 'Monthly Service Fee', bucket: 'Moonsmoke LLC' },
  { date: '2026-01-30', amount: 15.0, merchant: 'Monthly Service Fee', bucket: 'Moonsmoke LLC' },
  { date: '2026-01-08', amount: 15.0, merchant: 'Wire Fee', bucket: 'Peak 10' },
  { date: '2025-12-31', amount: 15.0, merchant: 'Monthly Service Fee', bucket: 'Moonsmoke LLC' },
  { date: '2026-05-03', amount: 12.64, merchant: 'shell shell', bucket: 'Moonsmoke LLC' },
  { date: '2026-05-02', amount: 11.13, merchant: 'shell shell', bucket: 'Moonsmoke LLC' },
  { date: '2026-02-21', amount: 3000.0, merchant: 'P Fitness', bucket: 'Peak 10' },
  { date: '2025-12-21', amount: 2073.04, merchant: 'Four Seasons', bucket: 'Peak 10' },
  { date: '2026-01-14', amount: 1002.88, merchant: 'Park House Houston', bucket: 'Peak 10' },
  { date: '2025-12-03', amount: 719.0, merchant: 'Hart Energy Premium', bucket: 'Peak 10' },
  { date: '2025-12-15', amount: 420.0, merchant: 'Four Points Boat', bucket: 'Moonsmoke LLC' },
  { date: '2026-01-12', amount: 358.33, merchant: 'Park House Houston', bucket: 'Peak 10' },
  { date: '2026-01-20', amount: 307.02, merchant: 'Park House Houston', bucket: 'Peak 10' },
  { date: '2026-02-25', amount: 272.66, merchant: 'Park House Houston', bucket: 'Peak 10' },
  { date: '2026-02-04', amount: 229.56, merchant: 'Park House Houston', bucket: 'Peak 10' },
  { date: '2025-12-15', amount: 207.65, merchant: 'Hilton Hotels', bucket: 'Peak 10' },
  { date: '2026-02-18', amount: 200.0, merchant: 'Park House Houston', bucket: 'Peak 10' },
  { date: '2025-12-11', amount: 184.28, merchant: 'Kasa Living Inc', bucket: 'Moonsmoke LLC' },
  { date: '2026-01-30', amount: 179.8, merchant: 'Park House Houston', bucket: 'Peak 10' },
  { date: '2026-02-11', amount: 164.16, merchant: 'Park House Houston', bucket: 'Peak 10' },
  { date: '2026-02-26', amount: 90.65, merchant: 'Park House Houston', bucket: 'Peak 10' },
  { date: '2026-02-11', amount: 69.26, merchant: 'Park House Houston', bucket: 'Peak 10' },
  { date: '2026-01-30', amount: 48.05, merchant: 'Payrix', bucket: 'Peak 10' },
  { date: '2026-01-13', amount: 40.0, merchant: 'Bloomberg Lei', bucket: 'Peak 10' },
  { date: '2026-02-05', amount: 36.0, merchant: 'W 2nd Street Parking', bucket: 'Peak 10' },
  { date: '2026-03-27', amount: 36.0, merchant: '500 w 2nd street parking', bucket: 'Peak 10' },
  { date: '2026-02-03', amount: 33.22, merchant: 'Park House Houston', bucket: 'Peak 10' },
  { date: '2026-02-20', amount: 33.0, merchant: 'W 2nd Street Parking', bucket: 'Peak 10' },
  { date: '2026-01-15', amount: 21.0, merchant: 'W 2nd Street Parking', bucket: 'Peak 10' },
  { date: '2025-12-12', amount: 21.0, merchant: 'W 2nd Street Parking', bucket: 'Peak 10' },
  { date: '2025-12-18', amount: 18.16, merchant: 'Four Seasons', bucket: 'Peak 10' },
  { date: '2026-02-12', amount: 18.0, merchant: 'W 2nd Street Parking', bucket: 'Peak 10' },
  { date: '2026-02-27', amount: 12.0, merchant: 'W 2nd Street Parking', bucket: 'Peak 10' },
  { date: '2025-12-12', amount: 10.0, merchant: 'W 2nd Street Parking', bucket: 'Peak 10' },
  { date: '2026-05-01', amount: 9.19, merchant: 'shell shell', bucket: 'Moonsmoke LLC' },
]

export function restoreReviewedExclusions(db: CompatDb): { restored: number } {
  const find = db.prepare(
    `SELECT id FROM transactions WHERE bucket='Exclude' AND transaction_date=? AND ABS(amount-?)<0.005 AND merchant_name=?`
  )
  const upd = db.prepare(
    `UPDATE transactions SET bucket=?, review_status='manually_classified',
       flag_reason='Restored from manual review (migration 018)', updated_at=datetime('now') WHERE id=?`
  )
  let restored = 0
  db.transaction(() => {
    for (const r of REVIEWED_RESTORES) {
      const hits = find.all(r.date, r.amount, r.merchant) as Array<{ id: string }>
      for (const h of hits) { upd.run(r.bucket, h.id); restored++ }
    }
  })()
  return { restored }
}
