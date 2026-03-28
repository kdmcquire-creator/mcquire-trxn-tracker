# McQuire Financial Tracker — Desktop Application

**Phase 1 Build | Windows x64 | Electron + React + TypeScript + SQLite**

A Windows desktop application that automates Kyle McQuire's transaction classification workflow across three entities: Peak 10 Energy Management (W2), Moonsmoke LLC (S-Corp), and Personal.

---

## Quick Start (First Time)

### Prerequisites
1. **Windows 10/11 x64** machine
2. **Node.js 20+** — download from nodejs.org
3. **A sync folder** inside Dropbox, OneDrive, Google Drive, or any folder you want (e.g. `C:\Users\Kyle\Dropbox\McQuire\`)
4. *(Phase 2, optional now)* Plaid developer account at dashboard.plaid.com — needed for Chase/Schwab/Fidelity auto-sync

### Install & Build
```cmd
cd mcquire-tracker
npm install
npm run build
```

The installer is output to `dist-installer\McQuire Tracker Setup 1.0.0.exe`.

Run the installer, then launch **McQuire Tracker** from the desktop shortcut.

### First Run
The app opens a setup wizard:
1. **Sync Folder** — Browse to your chosen folder (inside Dropbox/OneDrive/etc.)
2. **Plaid** — Enter Client ID + Secret (or skip; connect later in Settings → Sync)
3. **Notifications** — Enter your email address
4. Done — the app initializes the database and all classification rules

---

## Development Mode
```cmd
npm run dev
```
Opens the app in dev mode with hot reload. DevTools are available (F12).

---

## Importing Historical Data

### Option A: Monarch Money CSV (one-time historical import)
1. Export from Monarch Money: all transactions, all accounts, Jan 1 2025 → today
2. In the app: Settings → Sync & Schedule → Import Monarch CSV
3. The import wizard maps columns and runs the full classification engine

### Option B: Drop-folder import (ongoing)
- **USAA**: Export CSV from usaa.com → save to `[sync folder]\imports\usaa\`
- **Apple Card**: Export from wallet.apple.com → save to `[sync folder]\imports\apple_card\`
- The app detects and processes files within 5 seconds automatically

---

## Sync Folder Structure (auto-created)
```
[Your chosen folder]/
├── db/
│   └── mcquire.db          ← SQLite database (all transactions, rules, settings)
├── exports/
│   ├── expense_reports/    ← Generated Peak 10 .xlsx files
│   └── statements/         ← LLC P&L, Balance Sheet, Cashflow exports
├── imports/
│   ├── usaa/               ← Drop USAA CSV exports here
│   └── apple_card/         ← Drop Apple Card CSV exports here
├── backups/                ← Nightly DB backups, last 30 days
├── config.json             ← Non-sensitive settings
└── .lock                   ← Active session lock (auto-managed)
```

---

## Multi-Machine Setup (second Windows PC)
1. Install `McQuire Tracker Setup 1.0.0.exe` on the second machine
2. On first launch, point to the **same sync folder** (already synced via Dropbox/OneDrive)
3. The app detects the existing database and loads it automatically
4. Re-run Plaid Link on this machine (Settings → Sync → Connect Accounts) — Plaid tokens are machine-specific

---

## Connecting Banks via Plaid (Phase 2)

1. Create a free account at **dashboard.plaid.com**
2. Start in **Development** tier (free, up to 100 items)
3. Enable products: **Transactions**, **Investments**, **Identity**
4. Set allowed redirect URI: `mcquire-tracker://plaid-oauth-callback`
5. In the app: Settings → Sync & Schedule → Configure Plaid → enter Client ID + Secret
6. Then: Settings → Account Management → Add Account via Plaid → Connect Chase / Schwab / Fidelity

---

## Generating the Peak 10 Expense Report
1. Go to **Reports**
2. Set date range (e.g. Dec 1 2025 → Feb 28 2026) and period label
3. Click **Check Readiness** — resolves any blocking issues (AT&T splits, missing attendee names)
4. Click **Generate Report** — opens the .xlsx in Explorer, ready to attach and submit

---

## Email Notifications Setup
1. Settings → Notifications
2. Enter your email address
3. Choose **Gmail (App Password)**:
   - Enable 2FA on your Google account
   - Google Account → Security → App Passwords → generate 16-character password
   - Paste here as the password (not your regular Gmail password)
4. Click **Save SMTP Settings** → **Send Test Email**

---

## Classification Rules
All rules from the Workflow & Reference Document are pre-loaded in the database.

To view, edit, or add rules: **Settings → Rule Editor**

- Rules are evaluated in **priority order** (lower number = evaluated first)
- First matching rule wins
- Use **Test Against History** to preview impact before saving a new rule
- After saving, the app automatically re-classifies any pending transactions that match the new rule

---

## Build Phases
| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 1** | ✅ This build | Manual import (CSV drop folders), full classification engine, all screens, expense report export |
| **Phase 2** | Planned | Plaid auto-sync for Chase, Schwab, Fidelity |
| **Phase 3** | Planned | Investment tracking (holdings + transactions) |
| **Phase 4** | Planned | Historical import wizard, remaining financial statement exports, auto-updater |

---

## File Structure
```
mcquire-tracker/
├── electron/
│   ├── db/                  ← Database schema, seeding, helpers
│   └── services/            ← Classification engine, CSV parser, file watcher,
│                               Plaid, email, Excel export, IPC handlers
├── src/
│   ├── main/                ← Electron main process
│   ├── preload/             ← IPC bridge (contextBridge)
│   ├── renderer/            ← React frontend
│   │   ├── screens/         ← Dashboard, ReviewQueue, Transactions, Reports,
│   │   │                       Investments, Settings/*, SetupWizard
│   │   └── components/      ← Sidebar
│   └── shared/              ← TypeScript types shared across processes
├── resources/               ← App icons (icon.ico, icon.png)
└── package.json
```

---

## Troubleshooting

**App won't start after install**
- Ensure Node.js 20+ was installed before running `npm install`
- Run `npm install` again if any packages failed

**"Database in use on another machine" warning**
- Another instance may be open on a different PC, or the last session didn't close cleanly
- If no other session is active, dismiss the warning to proceed

**Plaid sync fails with ITEM_LOGIN_REQUIRED**
- Your bank session expired; open the app and re-authenticate via the prompt in Account Management
- This is normal and happens every 90 days for some institutions

**AT&T bills showing as flagged**
- Expected: bills ≥$300 require a manual split (business line 832-687-0468 vs personal)
- Log into att.com/billdetail, find the line cost, enter it in the Review Queue split tool

**Expense report blocked: "Add attendee names"**
- Every Meals & Meetings - external entry needs attendee names in Description/Notes
- Open Review Queue → find the flagged transaction → fill in the attendees field

---

## Removing a Previous Installation (Clean Slate)

Run this script in **CMD as Administrator** to fully remove any previous installation before reinstalling. This removes the app, the database, all cached data, and all Windows Credential Manager entries for McQuire Tracker.

```cmd
@echo off
echo Removing McQuire Tracker — all traces...

REM 1. Kill any running instance
taskkill /f /im "McQuire Tracker.exe" 2>nul

REM 2. Uninstall via Windows Add/Remove Programs (silent)
for /f "tokens=*" %%i in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "McQuire Tracker" /k 2^>nul ^| findstr "HKEY"') do (
    for /f "tokens=2*" %%a in ('reg query "%%i" /v UninstallString 2^>nul ^| findstr "UninstallString"') do (
        %%b /S
    )
)

REM 3. Remove AppData (Electron user data — settings, DB path cache)
rd /s /q "%APPDATA%\mcquire-tracker" 2>nul
rd /s /q "%APPDATA%\McQuire Tracker" 2>nul
rd /s /q "%LOCALAPPDATA%\mcquire-tracker" 2>nul
rd /s /q "%LOCALAPPDATA%\McQuire Tracker" 2>nul

REM 4. Remove Windows Credential Manager entries (stored SMTP password)
cmdkey /delete:mcquire-tracker-smtp 2>nul

REM 5. Remove desktop and start menu shortcuts
del /f /q "%USERPROFILE%\Desktop\McQuire Tracker.lnk" 2>nul
rd /s /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\McQuire Tracker" 2>nul

REM 6. Remove from registry (any leftover keys)
reg delete "HKCU\SOFTWARE\mcquire-tracker" /f 2>nul
reg delete "HKCU\SOFTWARE\McQuire Tracker" /f 2>nul

echo Done. You can now run the installer for a clean install.
pause
```

**Note:** This does NOT delete your sync folder (Dropbox/OneDrive/etc.) or the `mcquire.db` database inside it. Your transaction data is safe. If you also want to wipe the database and start completely fresh, delete the `db\` folder inside your sync folder manually before reinstalling.
