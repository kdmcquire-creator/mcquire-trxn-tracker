# McQuire Tracker — Installation Guide

## Prerequisites

Install these once. Skip any you already have.

1. **Node.js 20 LTS** — https://nodejs.org/en/download
   During setup choose "Add to PATH" and install the native tools option (required for better-sqlite3).

2. **Git** (optional, for pulling updates) — https://git-scm.com/download/win

---

## Build the installer (one-time)

Open **PowerShell** or **Command Prompt** in this folder, then run:

```powershell
npm install
npm run build
```

`npm install` takes 2–4 minutes the first time (downloads all packages).
`npm run build` compiles TypeScript + React, then packages everything into an installer.

When complete, look in `dist-installer\` for:

```
McQuire Tracker Setup 1.0.0.exe   ← standard installer (recommended)
McQuire Tracker 1.0.0.exe         ← portable exe (no install needed)
```

Run the Setup exe and follow the wizard.

---

## First launch

1. The app opens to the **Setup Wizard**.
2. Choose a sync folder — pick a folder inside Dropbox, OneDrive, or any location.
   The database and nightly backups will be stored here, so choose somewhere that syncs across machines.
3. Import historical transactions (CSV from Monarch Money, USAA, or Apple Card).
4. Connect Plaid accounts via Settings → Plaid Accounts.

No `.env` file or manual config is required — everything is set through the UI.

---

## Daily use

- Drop USAA / Apple Card CSV exports into the watched folders:
  ```
  <sync folder>/imports/usaa/
  <sync folder>/imports/apple_card/
  ```
  The app auto-ingests and classifies them within a few seconds.

- The tray icon stays running in the background and syncs Plaid accounts on schedule.

---

## Updating to a new version

Pull the updated source and rebuild:

```powershell
git pull
npm install
npm run build
```

Re-run the new installer — it upgrades in place and preserves the database.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm install` fails with node-gyp errors | Open the Start menu, search "x64 Native Tools Command Prompt for VS" and run `npm install` from there. Or reinstall Node.js and check "Install native tools". |
| App won't start after install | Right-click the installer → Run as Administrator |
| Plaid Link window is blank | Check Settings → Plaid Accounts → make sure Client ID and Secret are saved |
| Reports screen shows wrong totals | Confirm the sync folder path is correct in Settings → General |

---

## What's in this folder

```
mcquire-tracker-source/
├── src/
│   ├── main/index.ts          Electron main process (DB, IPC, file watcher)
│   ├── preload/               IPC bridges (contextBridge)
│   ├── renderer/              React app (screens + components)
│   └── shared/                TypeScript types shared between processes
├── electron/
│   ├── preload/               Plaid Link popup preload
│   └── services/              All backend services (Plaid, Excel, email, etc.)
├── resources/                 App icons + plaid-link.html
├── package.json               Dependencies + build config
├── electron.vite.config.ts    Build pipeline
└── tsconfig*.json             TypeScript configs
```
