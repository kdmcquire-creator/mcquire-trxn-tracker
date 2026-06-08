# McQuire Financial Tracker — CLAUDE.md

**Last updated:** 2026-06-07 · **Stack:** Electron 28 + React 18 + TypeScript 5 + Tailwind 3 + sql.js (WASM SQLite), built with electron-vite + electron-builder → Windows NSIS installer.

> The app lives in the **`mcquire-tracker-app/`** subdirectory of this repo. Run all `npm` commands from there. The repo root also holds `VDR-DESIGN-PLAN.md` (a *separate, future* project — see §11) and a saved March build transcript.

---

## 1. What this project IS

A **single-user Windows desktop app** that automates Kyle McQuire's personal transaction-classification workflow across three entities:

| Entity | Tax treatment |
|---|---|
| Peak 10 Energy Management | W-2 employer (business expense reports) |
| Moonsmoke LLC | S-Corp (financial statements + 1120-S / K-1) |
| Personal | — |

It ingests transactions (CSV drop-folders now, Plaid bank-sync wired), runs a rules + AI classification engine to bucket each transaction by entity/category, and exports the **Peak 10 expense report** (`.xlsx`), **LLC financial statements** (P&L / Balance Sheet / Cashflow), and **IRS Form 1120-S + Schedule K-1**.

- **Owner:** Kyle McQuire (personal — *not* a Moonsmoke site, *not* the Peak 10 dashboard)
- **Repo:** `github.com/kdmcquire-creator/mcquire-trxn-tracker` (the personal `kdmcquire-creator` GitHub account)
- **Distribution:** a Windows `.exe` installer (`dist-installer/McQuire Tracker Setup 1.0.0.exe`) — **there is no web host**. Data is shared across machines via a user-chosen **Dropbox/OneDrive sync folder** holding the SQLite DB, not a server.

## 2. Screen / feature inventory

All screens are **shipped** (the README's "Phases 2–4 = planned" table is **stale** — see §10). Source: `src/renderer/screens/`.

| Screen | Purpose |
|---|---|
| Dashboard | Overview / summary metrics |
| Transactions | Full ledger, search, paginate (250/page default) |
| ReviewQueue | Resolve flagged items (splits, missing attendees, dedup verdicts) |
| AssignmentWizard | Bulk-assign entity/category; split transactions |
| Reports | Peak 10 expense report, LLC statements, **1120-S/K-1** (new 2026-06-07) |
| Investments | Holdings + investment transactions (Phase 3) |
| Settings/* | RuleEditor, AccountManagement, SyncSchedule, SyncSettings, NotificationSettings, Plaid/Claude/Ollama config |
| SetupWizard | First-run 6-step setup (sync folder, Plaid, email) |

A separate **`companion-web/`** subapp (PIN-login, `companion-web/src/components/Login.tsx`) exists alongside the desktop app.

## 3. Build / run / ship

Run from `mcquire-tracker-app/`:

| Command | What it does |
|---|---|
| `npm run dev` | Dev mode, hot reload, DevTools (F12) |
| `npm run check` | **The gate** — `tsc --noEmit && vitest run`. Run this before claiming done. |
| `npm run typecheck` | TypeScript only |
| `npm run test` | Vitest only |
| `npm run build` | `electron-vite build && electron-builder` → installer in `dist-installer/` |
| `npm run build:unpackaged` | Kills running app, fast `--dir` build (no installer) |

- **CI:** `.github/workflows/ci.yml` (added 2026-06-07) runs `npm run check` on push.
- **No auto-deploy / no Cloudflare / no Netlify** — this is a desktop app. "Shipping" = building the installer and running it.
- **Toolchain verified 2026-06-07:** node v20.20.0, vitest 4.1.0, tsc 5.9.3. Typecheck clean, **74/74 tests pass**.

## 4. Data store

- **Engine:** `sql.js` (SQLite compiled to WASM — *no native build*, no node-gyp/Python). Accessed through a hand-rolled **better-sqlite3-compatible wrapper** at `electron/services/database.ts` (`prepare().get()/.all()/.run()`, `pragma`, `transaction`, `exec`).
- **File:** `<sync-folder>/db/mcquire.db`. The whole DB is held in memory and **exported to disk on every write** (atomic `.tmp`→rename). Writes outside a transaction each serialize the entire DB (see §10 perf note).
- **Schema + migrations:** `src/main/schema.ts`. 11 tables: `accounts`, `transactions`, `rules`, `vendors`, `investments`, `expense_reports`, `plaid_items`, `sync_log`, `personal_trip_dates`, `settings`, `migrations`.
- **Migration system:** idempotent, runs on every startup, guarded by `migrations` table + `INSERT OR IGNORE`. Currently **001 → 014**. Migrations 005/008/009/010 progressively widened cross-account dedup; **012/013/014 are corrective** — they *restore* transactions earlier dedup wrongly excluded (see §10).

## 5. Architecture patterns

- **Electron 3-process split:** `src/main/` (main process, IPC registration), `src/preload/` (contextBridge IPC bridge — `index.ts` + `plaid-bridge.ts`, `investments-bridge.ts`, `phase4-bridge.ts`), `src/renderer/` (React UI). Shared TS types in `src/shared/`.
- **Services** live in `electron/services/` (classification-engine, dedup, recurring-repair, csv-parser, excel-export, financial-statements, historical-import, plaid*, ollama, claude-classifier, email, sync-scheduler, app-lifecycle).
- **Dual AI classifier:** rules-first, then either **Claude** (`claude-classifier.ts`, `@anthropic-ai/sdk`) or **Ollama** (`ollama.service.ts`, local at `localhost:11434`). Ollama auto-detects the installed model on startup.
- **Drop-folder import:** `chokidar` watches `<sync-folder>/imports/{usaa,apple_card}/` and processes new CSVs within ~5s.
- **Single source of truth (post-2026-06-07):** cross-account dedup is centralized in `electron/services/dedup.ts`; recurring-charge repair in `recurring-repair.ts`; 1120-S math in `compute1120S()` — each unit-tested. Don't re-inline these.
- **State:** `zustand`. **Scheduling:** `node-cron` (`sync-scheduler.service.ts`).

## 6. External integrations

| Integration | Where | Notes |
|---|---|---|
| **Plaid** | `plaid.service.ts`, `plaid-link.service.ts`, `plaid-ipc.ts`, `plaid-investments.service.ts` | Bank/investment sync. Sandbox/Development tier. Tokens are **machine-specific** (re-link per PC). Redirect URI `mcquire-tracker://plaid-oauth-callback`. |
| **Anthropic Claude** | `claude-classifier.ts` | API key entered in Settings (`sk-ant-…`). |
| **Ollama** | `ollama.service.ts` | Local LLM, no cloud. Auto-detects model. |
| **SMTP email** | `email-service.ts`, `nodemailer` | Gmail App Password. **Credentials stored in Windows Credential Manager** (`mcquire-tracker-smtp`), never in the DB/repo. |
| **CSV sources** | `csv-parser.ts`, `historical-import.service.ts` | Monarch Money (one-time historical), USAA, Apple Card. |

## 7. Auth / secrets

- The **desktop app has no login** (single local user). The **`companion-web` subapp uses a PIN**.
- Secrets: SMTP password → Windows Credential Manager; Plaid/Claude keys → entered in Settings, stored locally. **None are committed.** Don't add credentials to this file or the repo.

## 8. Frontend conventions

- `src/renderer/screens/` (one folder/file per screen; `Settings/` is a sub-tree) + `src/renderer/components/` (Sidebar).
- Tailwind; Peak 10-derived palette defined in `mcquire-tracker-app/tailwind.config.js` (navy `#1F3864`, brand blue `#2E75B6`, light `#BDD7EE` — per `VDR-DESIGN-PLAN.md`).

## 9. Bug-fix log & non-obvious gotchas

**The README phase table is stale.** It says Phase 1 is "this build" and Phases 2–4 are "planned." **In reality all four phases are wired** (`src/preload/index.ts:3` — "All four phases wired"): Plaid, Investments, financial statements, historical import, and auto-updater code all exist. Trust the code, not that table. *(Fix pending — see §10.)*

**Recurring charges (e.g. Bilt rent) vanished from the ledger.** *Root cause:* aggressive cross-account ±2-day dedup (migrations 009/010) treated a same-merchant + same-amount **monthly recurring** charge as a duplicate and excluded it. *Fix:* migration `012` (restore false-positives), `013` (diagnose missing recurring), `014` (self-healing restore: any charge with the same merchant+amount in **3+ distinct months** is recurring, not a dup — genuine one-offs stay excluded). Dedup logic was unified into `electron/services/dedup.ts` with the recurring guard built in, and covered by `tests/dedup.test.ts` + `tests/recurring-repair.test.ts`. **If transactions look "missing," check dedup before assuming an import gap** — migration 013 prints a per-merchant distinct-month verdict to tell the two apart.

**Real-data verification (2026-06-08) — the charges still in `Exclude` are RULE-excluded, not dedup-excluded, and migration 014 does NOT catch them.** Against the live `mcquire.db`: 6 months of **Bilt rent (~$12.9k)** plus Gexa/AT&T/City-of-Austin/Nickson/etc. sit in `Exclude` with **empty `flag_reason`** and `rule_id='excl-004'`. *Root cause:* rule **`excl-004` "Payment Category Exclude"** (`match=contains:'payment'`, **priority 103**, `action=exclude`) is evaluated before vendor rules like `llc-002` (Bilt→Moonsmoke LLC). Bilt's bank ACH lines read `"ORIG CO NAME:BILT PAYMENT … BILTRENT"` — they contain the word "payment", so `excl-004` excludes them first; cleaner months reading `"BILT RENT - A Residential"` fall through to `llc-002` and classify correctly. *Why migration 014 misses it:* `restoreRecurringExclusions` (`electron/services/recurring-repair.ts`) only restores rows whose `flag_reason LIKE '%duplicate/dedup/migration%'` — these have no such flag, so it returns **0** on real data despite its comment claiming it fixes "Bilt, Gexa, etc." *Blast radius:* `excl-004` has excluded **55** transactions; ~34 are legitimate vendor expenses (Bilt 6, AT&T 17, City of Austin 8 ≈ $23k) mixed in with genuine card-payment transfers it *should* exclude. *Fixed — migration 015 (2026-06-08):* `electron/services/payment-exclude-repair.ts` (`reprioritizePaymentExclude`) demotes `excl-004` from priority **103 → 8999** (after all vendor rules, before the 9000 default) and re-runs the real engine on the rows it auto-excluded. Result: the **6 Bilt rent charges (~$12.9k) reclassified to Moonsmoke LLC**; genuine card payments stay excluded. Live DB patched + read-only-verified (all 13 Bilt now Moonsmoke LLC, 0 excluded); covered by `tests/payment-exclude-repair.test.ts`. The fix is reorder-only (not match-narrowing) so no real card payment can leak into Personal. **AT&T fixed separately — migration 016 (2026-06-08):** the AT&T wireless bill posts as `"ATT* BILL PAYMENT"` (mask 5829), which the `exact:'at&t'` rules (`llc-011`/`p10-024`/`p10-025`) never matched, so it too fell into `excl-004`. Added three `contains:'att bill'` rules (`llc-021`/`p10-038`/`p10-039`) banded by amount — **<$100 → Moonsmoke LLC** (business line), **$100–299 → Peak 10** (work line), **≥$300 → `split_flag`** (Review Queue for the 832-687-0468 split). `electron/services/attbill-repair.ts` (`reclassifyExcludedAttBills`) reclassified the **20** excluded rows (**7 LLC / 6 Peak 10 / 7 to Review**); live-verified (0 AT&T bills left in `Exclude`), covered by `tests/attbill-repair.test.ts`. Match key is `'att bill'` — plain `'att'` hits Hyatt Place / tattoo / "Little Matt's" (verified against the whole table).

**Dedup silently skipped unclassified transactions.** *Root cause:* `bucket != 'Exclude'` is **NULL-unsafe** in SQL — a duplicate whose original was still pending review (`bucket IS NULL`) slipped through. *Fix:* `(bucket IS NULL OR bucket != 'Exclude')`.

**Expense-report "submit prior report?" prompt was always skipped.** *Root cause:* `Reports.tsx` passed the button's click **event object** as the `overlapOverride` boolean argument (always truthy). Caught by `tsc` once types were enforced. *Fix:* `Reports.tsx:322` area — pass the real flag. Lesson: keep `npm run check` green; the typecheck earns its keep.

**`sql.js` write-amplification.** Every write outside a transaction serializes the **entire** DB to disk (`database.ts` `saveToDiskSync`). With up to 50k transactions this is real I/O — **batch bulk writes inside `db.transaction(...)`** so persistence happens once at commit.

**Don't `npm i better-sqlite3`.** The `.prepare().get()` API is a **compat shim over sql.js** (`database.ts`), chosen to avoid native compilation in the Electron build. Adding better-sqlite3 would reintroduce the node-gyp/ABI problem the wrapper exists to avoid.

**Transaction query cap.** Was hard-capped at 2,000 rows (silently truncated large ledgers); raised to **50,000** on 2026-06-07.

## 10. Pending work & explicit non-goals

**TODO / open:**
- [x] **Verified Bilt/recurring on real data (2026-06-08).** Live DB has migrations through **012 only** (013/014 NOT applied — the app hasn't been relaunched since PR #6). Found **6 Bilt-rent months (~$12.9k) + ~15 other recurring charges still in `Exclude`**. **Root cause is classification rule `excl-004`, not dedup (see §9)** — so migration 014 would restore **0** of them. Migration 013 *would* surface the 6 Bilt rows in the Review Queue on next launch, but `excl-004` would re-exclude any "…payment…" Bilt charge again until the rule is fixed.
- [x] **Fixed `excl-004` priority (migration 015, 2026-06-08).** 6 Bilt rent charges (~$12.9k) recovered to Moonsmoke LLC; live DB patched + verified; `tests/payment-exclude-repair.test.ts` green; committed.
- [x] **Fixed AT&T wireless bill (migration 016, 2026-06-08).** 20 excluded `ATT* BILL PAYMENT` rows reclassified — 7→Moonsmoke LLC, 6→Peak 10, **7 (≥$300) → Review Queue** for the 832-687-0468 split. Live DB patched + verified; `tests/attbill-repair.test.ts` green. **Action for Kyle:** resolve the 7 large AT&T bills in the Review Queue (allocate the business-line portion).
- [ ] **AT&T non-bill charges still need a look (low priority).** `AT&T MOBILITY EPAY` / `AT&T DEVICE/EQUIP SHIP` / `ATT BUSINESS UVERSE` (masks 5829/9007/2419) are NOT caught by the `'att bill'` rules and sit in Personal/Exclude inconsistently. Separate, smaller cleanup.
- [ ] **Minor anomaly:** a few recurring charges (Gexa/Nickson/Microsoft) sit in `Exclude` while carrying a vendor `rule_id` (e.g. `llc-001`) — an inconsistent state NOT caused by `excl-004` (empty `flag_reason`, not in the migration-015 set). Low dollar; investigate separately.
- [ ] **Fix the stale README phase table** in `mcquire-tracker-app/README.md` (mark Phases 2–4 as implemented).
- [ ] **Plaid is sandbox/Development tier** — production bank sync (Chase/Schwab/Fidelity) not yet enabled end-to-end.
- [ ] **Auto-updater** (`electron-updater`, `app-lifecycle.service.ts`) is wired but `autoDownload=false` and no publish feed is confirmed — releases are still manual installer runs.
- [ ] **Local checkout housekeeping:** the working copy is parked on the now-merged branch `claude/review-project-structure-3hlFs`, **7 commits behind `main`**. `git checkout main && git pull` to sync (no work is lost — everything merged).

**Explicit non-goals / separate projects:**
- **The VDR ("New Age VDR") is NOT part of this app.** `VDR-DESIGN-PLAN.md` + branch `claude/vdr-authentication-design-QZC6V` describe a *future, separate* Peak 10 buyer data-room that would *reuse this app's stack/branding*. Don't build VDR features into the tracker.

## 11. Recent significant work (most recent first)

- **2026-06-07 (afternoon, cloud session → PRs #3–#6, all merged to `main`):**
  - `#6` Harden core logic — test harness (49→**74** tests), extracted dedup/recurring-repair/`compute1120S`, `npm run check`, CI workflow, fixed the Reports click-event + NULL-unsafe dedup bugs (`efe0294`).
  - `#5`/diagnosis — fix dedup false positives, diagnose & restore missing Bilt recurring charges, migrations 012–014 (`e6c7437`, `d2a9dd2`).
  - `#4` — Add IRS Form 1120-S + Schedule K-1 report generation (`dda72e2`).
  - `#3` — Raise transaction query limit 2,000 → 50,000 (`8063c57`).
- **2026-05-02/03:** Ollama local-AI classification + learning engine; cross-account dedup ±1/±2-day; expense-report draft/submit workflow; duplicate/card-hold handling.
- **2026-03-26 → 2026-05-02:** Original Phase-1 build; consolidated `mcquire-tracker-source` into `mcquire-tracker-app` (PR #2). A March build transcript is saved at repo root.

## 12. Reference commands

```powershell
# Verify before claiming done (from mcquire-tracker-app/)
npm run check                 # tsc --noEmit && vitest run  → expect 74 passed, exit 0

# Build the Windows installer
npm run build                 # → dist-installer/McQuire Tracker Setup 1.0.0.exe

# Sync local checkout to the merged main (no work lost)
git checkout main; git pull
```

A full clean-uninstall script (removes app, AppData, Credential Manager entry, shortcuts — but **not** the sync-folder DB) is in `mcquire-tracker-app/README.md` under "Removing a Previous Installation."

## 13. When updating this file

Per the kdmcquire CLAUDE.md convention (event-driven): add a §9 symptom/cause/fix triplet whenever a non-obvious bug is fixed; update §11 timeline on each meaningful merge; flip §2/§10 status when a TODO ships; bump the date at top. Don't log formatting/typo/dep-bump-only changes. Keep secrets out.
