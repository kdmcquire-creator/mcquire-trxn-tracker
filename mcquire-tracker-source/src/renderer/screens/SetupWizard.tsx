// src/renderer/screens/SetupWizard.tsx
//
// Phase 4 — First-Run Setup Wizard (polished 6-step UI)
// Steps:
//   1. Welcome
//   2. Sync Folder — browse/select
//   3. Plaid Credentials — enter Client ID + Secret
//   4. Connect Accounts — Plaid Link for Chase/Schwab/Fidelity
//   5. Email Notifications
//   6. Import Historical Data — Monarch CSV + optional existing workbook

import { useState, useEffect } from 'react'

declare const window: Window & {
  api: {
    plaid: {
      getConfig: () => Promise<any>
      saveConfig: (c: any) => Promise<any>
      createLinkToken: () => Promise<any>
      openLink: (token: string) => Promise<any>
      exchangeToken: (payload: any) => Promise<any>
    }
    email?: {
      saveSmtp: (c: any) => Promise<any>
      sendTest: () => Promise<any>
    }
    db?: {
      setSetting: (key: string, value: string) => Promise<any>
    }
    import?: {
      selectFile: () => Promise<any>
      preview: (path: string) => Promise<any>
      run: (path: string) => Promise<any>
    }
  }
  electronAPI?: {
    selectFolder: () => Promise<string | null>
    getSyncFolder: () => Promise<string>
    setSyncFolder: (path: string) => Promise<void>
    initDatabase: (folder: string) => Promise<{ isNew: boolean }>
  }
}

// ─── Step indicator ───────────────────────────────────────────────────────────

const STEPS = [
  'Welcome',
  'Sync Folder',
  'Plaid Setup',
  'Connect Accounts',
  'Notifications',
  'Import Data',
]

function StepIndicator({
  current,
  total,
}: {
  current: number
  total: number
}) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="flex items-center">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all ${
              i < current
                ? 'bg-brand-blue text-white'
                : i === current
                ? 'bg-brand-blue text-white ring-4 ring-blue-100'
                : 'bg-gray-200 text-gray-500'
            }`}
          >
            {i < current ? '✓' : i + 1}
          </div>
          {i < total - 1 && (
            <div
              className={`h-0.5 w-12 ${i < current ? 'bg-brand-blue' : 'bg-gray-200'}`}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Step 1: Welcome ─────────────────────────────────────────────────────────

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center">
      <div className="text-7xl mb-6">📊</div>
      <h1 className="text-3xl font-bold text-gray-900 mb-3">McQuire Financial Tracker</h1>
      <p className="text-gray-600 mb-2 text-lg">
        Automates classification of transactions across Peak 10, Moonsmoke LLC, and Personal.
      </p>
      <p className="text-gray-500 text-sm mb-8">
        This setup wizard takes about 5 minutes. You'll choose a sync folder,
        connect your bank accounts, and optionally import historical data.
      </p>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-left mb-8 text-sm text-blue-800">
        <p className="font-semibold mb-2">Before you begin:</p>
        <ul className="space-y-1 list-disc list-inside">
          <li>Have your Dropbox/OneDrive/Google Drive folder ready</li>
          <li>Have your Plaid Client ID + Secret from dashboard.plaid.com</li>
          <li>Have your Gmail App Password ready for notifications (optional)</li>
          <li>Have your Monarch CSV export ready (optional, for historical data)</li>
        </ul>
      </div>

      <button
        onClick={onNext}
        className="px-8 py-3 bg-brand-blue text-white rounded-xl text-lg font-semibold hover:bg-blue-700 shadow-lg"
      >
        Get Started →
      </button>
    </div>
  )
}

// ─── Step 2: Sync Folder ──────────────────────────────────────────────────────

function StepSyncFolder({
  onNext,
  onBack,
}: {
  onNext: (folder: string) => void
  onBack: () => void
}) {
  const [folder, setFolder] = useState('')
  const [isNew, setIsNew] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.electronAPI?.getSyncFolder().then((f) => {
      if (f) setFolder(f)
    })
  }, [])

  async function handleBrowse() {
    const selected = await window.electronAPI?.selectFolder()
    if (selected) setFolder(selected)
  }

  async function handleNext() {
    if (!folder) return
    setChecking(true)
    try {
      const result = (await window.electronAPI?.initDatabase(folder)) as { isNew: boolean } | undefined
      setIsNew(result?.isNew ?? true)
      onNext(folder)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">Choose Sync Folder</h2>
      <p className="text-gray-500 mb-6">
        Choose a folder inside your sync service (Dropbox, OneDrive, Google Drive, or any folder).
        The database and exports will live here and stay in sync across your machines.
      </p>

      <div className="space-y-3 mb-6">
        <div className="flex gap-3">
          <input
            type="text"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="e.g. C:\Users\Kyle\Dropbox\McQuire"
            className="flex-1 border border-gray-300 rounded-lg px-4 py-2.5 text-sm font-mono"
          />
          <button
            onClick={handleBrowse}
            className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 whitespace-nowrap"
          >
            Browse…
          </button>
        </div>

        {folder && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm text-gray-600">
            <p className="font-mono text-xs break-all">{folder}</p>
            <p className="mt-1 text-xs text-gray-400">
              {isNew === false
                ? '✓ Existing database detected — will load your data.'
                : '✓ New folder — will create database on first launch.'}
            </p>
          </div>
        )}
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 mb-6">
        <strong>Second machine?</strong> Point to the same folder that's already synced.
        The app will detect the existing database automatically.
      </div>

      <div className="flex gap-3 justify-end">
        <button onClick={onBack} className="px-5 py-2 text-gray-600 hover:text-gray-800">
          ← Back
        </button>
        <button
          onClick={handleNext}
          disabled={!folder || checking}
          className="px-6 py-2.5 bg-brand-blue text-white rounded-lg font-medium disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Next →'}
        </button>
      </div>
    </div>
  )
}

// ─── Step 3: Plaid Setup ─────────────────────────────────────────────────────

function StepPlaidSetup({
  onNext,
  onBack,
  onSkip,
}: {
  onNext: () => void
  onBack: () => void
  onSkip: () => void
}) {
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [env, setEnv] = useState('development')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    if (!clientId || !secret) { setError('Both fields are required.'); return }
    setSaving(true)
    setError('')
    const result = await window.api.plaid.saveConfig({ client_id: clientId, secret, env })
    setSaving(false)
    if (result.success) {
      setSaved(true)
    } else {
      setError(result.error || 'Save failed')
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">Plaid Credentials</h2>
      <p className="text-gray-500 mb-6">
        Plaid connects McQuire Tracker to Chase, Schwab, and Fidelity automatically.
        Credentials are stored in Windows Credential Manager — never in any file.
      </p>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800 mb-5">
        <p className="font-semibold mb-1">One-time Plaid setup (5 minutes):</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>Create free account at <strong>dashboard.plaid.com</strong></li>
          <li>Select <strong>Development</strong> tier (free, up to 100 items)</li>
          <li>Enable: <strong>Transactions, Investments, Identity</strong></li>
          <li>Add redirect URI: <code className="text-xs bg-blue-100 px-1 py-0.5 rounded">mcquire-tracker://plaid-oauth-callback</code></li>
          <li>Copy your Client ID and Development Secret below</li>
        </ol>
      </div>

      <div className="space-y-4 mb-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Plaid Client ID</label>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="From Plaid dashboard → Team Settings"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
            autoComplete="off"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Development Secret
          </label>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Development secret from Plaid dashboard"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
            autoComplete="off"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Environment</label>
          <select
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="sandbox">Sandbox (test data, no real bank connections)</option>
            <option value="development">Development (live connections, free)</option>
            <option value="production">Production (paid plan required)</option>
          </select>
        </div>
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {saved && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800 mb-4">
          ✓ Credentials saved securely.
        </div>
      )}

      <div className="flex gap-3 justify-between">
        <button onClick={onBack} className="px-5 py-2 text-gray-600 hover:text-gray-800">
          ← Back
        </button>
        <div className="flex gap-3">
          <button onClick={onSkip} className="px-5 py-2 text-gray-400 hover:text-gray-600 text-sm">
            Skip for now
          </button>
          {saved ? (
            <button
              onClick={onNext}
              className="px-6 py-2.5 bg-brand-blue text-white rounded-lg font-medium"
            >
              Next →
            </button>
          ) : (
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-6 py-2.5 bg-brand-blue text-white rounded-lg font-medium disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save & Continue →'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Step 4: Connect Accounts ─────────────────────────────────────────────────

function StepConnectAccounts({
  onNext,
  onBack,
}: {
  onNext: () => void
  onBack: () => void
}) {
  const [connected, setConnected] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  const BANKS = [
    { name: 'Chase', note: 'K. McQuire ···5829, BUS COMPLETE CHK ···2255' },
    { name: 'Schwab', note: 'Brokerage account' },
    { name: 'Fidelity', note: 'Brokerage account' },
  ]

  async function handleConnect() {
    setConnecting(true)
    setError('')
    try {
      const tokenRes = await window.api.plaid.createLinkToken()
      if (!tokenRes.success) { setError(tokenRes.error); return }

      const linkRes = await window.api.plaid.openLink(tokenRes.data)
      if (!linkRes.success) {
        if (!linkRes.error?.includes('closed')) setError(linkRes.error)
        return
      }

      // The account selection + exchange is handled by the AccountManagement screen
      // after setup. Here we just note that Link completed.
      setConnected((prev) => [...prev, linkRes.data?.institution_name || 'Account'])
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">Connect Bank Accounts</h2>
      <p className="text-gray-500 mb-6">
        Connect Chase, Schwab, and Fidelity via Plaid for automatic transaction import.
        You can add more accounts later in Settings → Account Management.
      </p>

      <div className="space-y-3 mb-6">
        {BANKS.map((bank) => {
          const isConnected = connected.some((c) =>
            c.toLowerCase().includes(bank.name.toLowerCase())
          )
          return (
            <div
              key={bank.name}
              className={`border rounded-xl p-4 flex items-center justify-between ${
                isConnected
                  ? 'border-green-200 bg-green-50'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <div>
                <p className="font-semibold text-gray-900">{bank.name}</p>
                <p className="text-xs text-gray-500">{bank.note}</p>
              </div>
              {isConnected ? (
                <span className="text-green-700 font-medium text-sm">✓ Connected</span>
              ) : null}
            </div>
          )
        })}
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      <button
        onClick={handleConnect}
        disabled={connecting}
        className="w-full py-3 border-2 border-dashed border-brand-blue text-brand-blue rounded-xl font-medium hover:bg-blue-50 disabled:opacity-50 mb-6 flex items-center justify-center gap-2"
      >
        {connecting && <span className="animate-spin">⟳</span>}
        {connecting ? 'Opening Plaid…' : '+ Connect a Bank Account'}
      </button>

      <div className="flex gap-3 justify-between">
        <button onClick={onBack} className="px-5 py-2 text-gray-600 hover:text-gray-800">
          ← Back
        </button>
        <button
          onClick={onNext}
          className="px-6 py-2.5 bg-brand-blue text-white rounded-lg font-medium"
        >
          {connected.length === 0 ? 'Skip for now →' : 'Next →'}
        </button>
      </div>
    </div>
  )
}

// ─── Step 5: Email Notifications ─────────────────────────────────────────────

function StepNotifications({
  onNext,
  onBack,
}: {
  onNext: () => void
  onBack: () => void
}) {
  const [email, setEmail] = useState('')
  const [smtpType, setSmtpType] = useState('gmail')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(false)
  const [error, setError] = useState('')

  async function handleTest() {
    if (!email || !smtpPassword) { setError('Enter email and password first.'); return }
    setTesting(true)
    setError('')
    try {
      await window.api.email?.saveSmtp({ email, type: smtpType, password: smtpPassword })
      const result = await window.api.email?.sendTest()
      if (result?.success) setTested(true)
      else setError(result?.error || 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">Email Notifications</h2>
      <p className="text-gray-500 mb-6">
        McQuire Tracker emails you when new transactions need review, sync errors occur,
        or expense reports are ready to submit.
      </p>

      <div className="space-y-4 mb-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Your Email Address</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="kyle@example.com"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">SMTP Provider</label>
          <div className="flex gap-2">
            {['gmail', 'outlook', 'custom'].map((t) => (
              <button
                key={t}
                onClick={() => setSmtpType(t)}
                className={`px-4 py-2 rounded-lg text-sm font-medium capitalize border ${
                  smtpType === t
                    ? 'border-brand-blue bg-blue-50 text-brand-blue'
                    : 'border-gray-200 text-gray-600'
                }`}
              >
                {t === 'gmail' ? 'Gmail' : t === 'outlook' ? 'Outlook/365' : 'Custom SMTP'}
              </button>
            ))}
          </div>
        </div>

        {smtpType === 'gmail' && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
            <strong>Gmail App Password setup:</strong>
            <ol className="list-decimal list-inside mt-1 space-y-1">
              <li>Enable 2-Factor Authentication on your Google account</li>
              <li>Go to Google Account → Security → App Passwords</li>
              <li>Generate a 16-character App Password for "Mail"</li>
              <li>Paste that password below (not your regular Gmail password)</li>
            </ol>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {smtpType === 'gmail' ? 'App Password (16 characters)' : 'SMTP Password'}
          </label>
          <input
            type="password"
            value={smtpPassword}
            onChange={(e) => setSmtpPassword(e.target.value)}
            placeholder={smtpType === 'gmail' ? 'xxxx xxxx xxxx xxxx' : 'Password'}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
          />
        </div>
      </div>

      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
      {tested && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800 mb-3">
          ✓ Test email sent successfully!
        </div>
      )}

      <div className="flex gap-3 justify-between">
        <button onClick={onBack} className="px-5 py-2 text-gray-600 hover:text-gray-800">
          ← Back
        </button>
        <div className="flex gap-3">
          <button
            onClick={handleTest}
            disabled={testing || !email}
            className="px-5 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            {testing ? 'Sending…' : 'Send Test Email'}
          </button>
          <button
            onClick={onNext}
            className="px-6 py-2.5 bg-brand-blue text-white rounded-lg font-medium"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Step 6: Import Historical Data ──────────────────────────────────────────

function StepImportData({
  onFinish,
  onBack,
}: {
  onFinish: () => void
  onBack: () => void
}) {
  const [filePath, setFilePath] = useState('')
  const [preview, setPreview] = useState<any | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<any | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  async function handleSelectFile() {
    const res = await window.api.import?.selectFile()
    if (!res?.success || !res.data) return
    setFilePath(res.data)
    setError('')
    const previewRes = await window.api.import?.preview(res.data)
    if (previewRes?.success) setPreview(previewRes.data)
    else setError(previewRes?.error || 'Preview failed')
  }

  // Listen for import progress events
  useEffect(() => {
    const handler = (_event: any, data: any) => { setProgress(data) }
    ;(window as any).electron?.ipcRenderer?.on('import:progress', handler)
    return () => {
      ;(window as any).electron?.ipcRenderer?.removeListener('import:progress', handler)
    }
  }, [])

  async function handleImport() {
    if (!filePath) return
    setImporting(true)
    setError('')
    const result = await window.api.import?.run(filePath)
    setImporting(false)
    if (result?.success) setDone(true)
    else setError(result?.error || 'Import failed')
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">Import Historical Data</h2>
      <p className="text-gray-500 mb-6">
        Import your Monarch Money CSV export to seed the database with historical transactions.
        All classification rules run automatically.
      </p>

      {!done ? (
        <>
          <div className="border-2 border-dashed border-gray-300 rounded-xl p-6 text-center mb-5">
            {filePath ? (
              <div>
                <p className="font-mono text-sm text-gray-700 break-all">{filePath}</p>
                {preview && (
                  <div className="mt-4 grid grid-cols-2 gap-3 text-left">
                    <div className="bg-gray-50 rounded-lg p-3 text-sm">
                      <p className="font-semibold text-gray-700">Rows</p>
                      <p className="text-xl font-bold text-gray-900">{preview.total_rows.toLocaleString()}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 text-sm">
                      <p className="font-semibold text-gray-700">New Transactions</p>
                      <p className="text-xl font-bold text-green-700">{preview.new_count.toLocaleString()}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 text-sm">
                      <p className="font-semibold text-gray-700">Date Range</p>
                      <p className="text-sm font-medium">{preview.date_range.start} → {preview.date_range.end}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 text-sm">
                      <p className="font-semibold text-gray-700">Excluded (transfers)</p>
                      <p className="text-lg font-bold text-gray-500">{preview.excluded_count.toLocaleString()}</p>
                    </div>
                  </div>
                )}
                {preview?.errors?.length > 0 && (
                  <div className="mt-3 text-red-600 text-sm">
                    {preview.errors.map((e: string, i: number) => <p key={i}>{e}</p>)}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <p className="text-4xl mb-3">📄</p>
                <p className="text-gray-600 mb-3">Select your Monarch Money CSV export</p>
                <button
                  onClick={handleSelectFile}
                  className="px-5 py-2.5 border border-brand-blue text-brand-blue rounded-lg font-medium hover:bg-blue-50"
                >
                  Select CSV File…
                </button>
              </div>
            )}
          </div>

          {filePath && !preview?.errors?.length && (
            <button
              onClick={handleSelectFile}
              className="text-sm text-brand-blue hover:underline mb-4 block"
            >
              Choose a different file
            </button>
          )}

          {/* Import progress */}
          {progress && (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700 capitalize">{progress.stage}…</span>
                <span className="text-sm text-gray-500">
                  {progress.current} / {progress.total}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2 mb-3">
                <div
                  className="bg-brand-blue h-2 rounded-full transition-all"
                  style={{ width: `${Math.round((progress.current / Math.max(progress.total, 1)) * 100)}%` }}
                />
              </div>
              <div className="flex gap-4 text-xs text-gray-600">
                <span>✓ Classified: {progress.classified}</span>
                <span>⏳ Queued: {progress.queued}</span>
                <span>⟳ Excluded: {progress.excluded}</span>
              </div>
            </div>
          )}

          {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

          <div className="flex gap-3 justify-between">
            <button onClick={onBack} className="px-5 py-2 text-gray-600 hover:text-gray-800">
              ← Back
            </button>
            <div className="flex gap-3">
              <button onClick={onFinish} className="px-5 py-2 text-gray-400 hover:text-gray-600 text-sm">
                Skip — I'll import later
              </button>
              <button
                onClick={handleImport}
                disabled={!preview || importing || preview?.errors?.length > 0}
                className="px-6 py-2.5 bg-brand-blue text-white rounded-lg font-medium disabled:opacity-50"
              >
                {importing ? 'Importing…' : `Import ${preview?.new_count?.toLocaleString() || ''} Transactions`}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-6">
          <div className="text-5xl mb-4">🎉</div>
          <h3 className="text-xl font-bold text-gray-900 mb-2">Import Complete!</h3>
          <p className="text-gray-600 mb-2">
            {progress?.classified?.toLocaleString()} transactions auto-classified.
          </p>
          {progress?.queued > 0 && (
            <p className="text-sm text-amber-700 mb-6">
              {progress.queued.toLocaleString()} transactions need your review in the Review Queue.
            </p>
          )}
          <button
            onClick={onFinish}
            className="px-8 py-3 bg-brand-blue text-white rounded-xl text-lg font-semibold hover:bg-blue-700"
          >
            Go to Dashboard →
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Lock conflict modal ──────────────────────────────────────────────────────

export function LockConflictModal({
  lockInfo,
  onOverride,
  onReadOnly,
}: {
  lockInfo: string
  onOverride: () => void
  onReadOnly: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-[460px] p-6">
        <div className="text-3xl mb-3">⚠️</div>
        <h3 className="font-bold text-gray-900 text-lg mb-2">
          Database may be in use on another machine
        </h3>
        <p className="text-gray-600 text-sm mb-4">{lockInfo}</p>
        <p className="text-gray-500 text-sm mb-6">
          If that machine is no longer active, you can safely override the lock.
          Otherwise, opening in read-only mode prevents data conflicts.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onReadOnly}
            className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50"
          >
            Open Read-Only
          </button>
          <button
            onClick={onOverride}
            className="flex-1 py-2.5 bg-brand-blue text-white rounded-lg font-medium hover:bg-blue-700"
          >
            Override Lock
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Update notification banner ───────────────────────────────────────────────

export function UpdateBanner({
  version,
  onDownload,
  onDismiss,
}: {
  version: string
  onDownload: () => void
  onDismiss: () => void
}) {
  return (
    <div className="fixed bottom-0 inset-x-0 bg-brand-blue text-white px-6 py-3 flex items-center justify-between z-40">
      <p className="text-sm">
        McQuire Tracker <strong>{version}</strong> is available.
      </p>
      <div className="flex gap-3">
        <button
          onClick={onDismiss}
          className="text-sm text-blue-200 hover:text-white"
        >
          Later
        </button>
        <button
          onClick={onDownload}
          className="px-4 py-1.5 bg-white text-brand-blue rounded-lg text-sm font-semibold hover:bg-blue-50"
        >
          Download & Install
        </button>
      </div>
    </div>
  )
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export default function SetupWizard({
  onComplete,
}: {
  onComplete: () => void
}) {
  const [step, setStep] = useState(0)
  const [_syncFolder, setSyncFolder] = useState('')

  const next = () => setStep((s) => s + 1)
  const back = () => setStep((s) => s - 1)

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-8">
        <StepIndicator current={step} total={STEPS.length} />

        <div className="min-h-[420px]">
          {step === 0 && <StepWelcome onNext={next} />}
          {step === 1 && (
            <StepSyncFolder
              onNext={(folder) => { setSyncFolder(folder); next() }}
              onBack={back}
            />
          )}
          {step === 2 && (
            <StepPlaidSetup onNext={next} onBack={back} onSkip={next} />
          )}
          {step === 3 && (
            <StepConnectAccounts onNext={next} onBack={back} />
          )}
          {step === 4 && (
            <StepNotifications onNext={next} onBack={back} />
          )}
          {step === 5 && (
            <StepImportData onFinish={onComplete} onBack={back} />
          )}
        </div>
      </div>
    </div>
  )
}
