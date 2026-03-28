// src/renderer/screens/Settings/SyncSchedule.tsx
//
// Phase 2 — Settings → Sync & Schedule
// Handles: Plaid credentials config, auto-sync schedule, sync log, manual sync trigger.

import { useState, useEffect, useCallback } from 'react'
import type { SyncLogEntry } from '../../../shared/plaid.types'

declare const window: Window & {
  api: {
    plaid: {
      getConfig: () => Promise<any>
      saveConfig: (c: any) => Promise<any>
      syncAll: () => Promise<any>
      getSyncStatus: () => Promise<any>
      getSchedule: () => Promise<any>
      saveSchedule: (c: any) => Promise<any>
      onSyncStarted: (cb: (d: any) => void) => void
      onSyncCompleted: (cb: (d: any) => void) => void
      onSyncError: (cb: (d: any) => void) => void
      removeAllListeners: () => void
    }
    syncLog: {
      list: (limit?: number) => Promise<any>
    }
  }
}

// ─── Cron helpers ─────────────────────────────────────────────────────────────

const PRESET_SCHEDULES = [
  { label: 'Nightly at 2:00 AM', cron: '0 2 * * *' },
  { label: 'Nightly at 11:00 PM', cron: '0 23 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every 12 hours', cron: '0 */12 * * *' },
  { label: 'Manual only', cron: '' },
]

function describeCron(cron: string): string {
  const preset = PRESET_SCHEDULES.find((p) => p.cron === cron)
  if (preset) return preset.label
  return `Custom: ${cron}`
}

// ─── Sync log row ─────────────────────────────────────────────────────────────

function SyncLogRow({ entry }: { entry: SyncLogEntry }) {
  const isError = entry.status === 'error'
  const duration =
    entry.completed_at && entry.started_at
      ? Math.round(
          (new Date(entry.completed_at).getTime() - new Date(entry.started_at).getTime()) / 1000
        )
      : null

  return (
    <tr className={`text-sm ${isError ? 'bg-red-50' : ''}`}>
      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">
        {new Date(entry.started_at).toLocaleString()}
      </td>
      <td className="px-4 py-2.5 text-gray-600 capitalize">
        {entry.sync_type.replace('_', ' ')}
      </td>
      <td className="px-4 py-2.5">
        {entry.status === 'success' ? (
          <span className="text-green-700 font-medium">✓ Success</span>
        ) : entry.status === 'error' ? (
          <span className="text-red-600 font-medium">✕ Error</span>
        ) : (
          <span className="text-yellow-600">Partial</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-gray-700 text-right font-mono">
        {entry.transactions_new > 0 ? `+${entry.transactions_new}` : '—'}
      </td>
      <td className="px-4 py-2.5 text-gray-500 text-right font-mono">
        {entry.transactions_queued > 0 ? entry.transactions_queued : '—'}
      </td>
      <td className="px-4 py-2.5 text-gray-400 text-right">
        {duration !== null ? `${duration}s` : '—'}
      </td>
      <td className="px-4 py-2.5 text-red-600 text-xs max-w-xs truncate">
        {entry.error_message || ''}
      </td>
    </tr>
  )
}

// ─── Plaid config form ────────────────────────────────────────────────────────

function PlaidConfigSection() {
  const [config, setConfig] = useState({ configured: false, client_id: null as string | null, env: 'development' })
  const [form, setForm] = useState({ client_id: '', secret: '', env: 'development' })
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.plaid.getConfig().then((r) => {
      if (r.success) {
        setConfig(r.data)
        setForm((f) => ({ ...f, env: r.data.env }))
        if (!r.data.configured) setEditing(true)
      }
    })
  }, [])

  async function handleSave() {
    if (!form.client_id || !form.secret) {
      alert('Both Client ID and Secret are required.')
      return
    }
    setSaving(true)
    const result = await window.api.plaid.saveConfig(form)
    setSaving(false)
    if (result.success) {
      setSaved(true)
      setEditing(false)
      setConfig({ configured: true, client_id: form.client_id.slice(0, 8) + '…', env: form.env })
      setTimeout(() => setSaved(false), 3000)
    } else {
      alert(`Failed to save: ${result.error}`)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-gray-900">Plaid Credentials</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Stored securely in Windows Credential Manager — never in any file.
          </p>
        </div>
        {config.configured && !editing && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
              ✓ Configured
            </span>
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-brand-blue hover:underline"
            >
              Update
            </button>
          </div>
        )}
      </div>

      {!editing ? (
        <div className="text-sm text-gray-600 space-y-1">
          <p>Client ID: <span className="font-mono">{config.client_id}</span></p>
          <p>Environment: <span className="capitalize font-medium">{config.env}</span></p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
            <strong>Setup required:</strong> Create a free account at{' '}
            <a
              href="https://dashboard.plaid.com"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              dashboard.plaid.com
            </a>{' '}
            → Development tier → Products: Transactions, Investments, Identity → Redirect URI:{' '}
            <code className="font-mono text-xs">mcquire-tracker://plaid-oauth-callback</code>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Client ID</label>
              <input
                type="text"
                value={form.client_id}
                onChange={(e) => setForm((f) => ({ ...f, client_id: e.target.value }))}
                placeholder="From Plaid dashboard"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Secret</label>
              <input
                type="password"
                value={form.secret}
                onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                placeholder="Development secret"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Environment</label>
            <select
              value={form.env}
              onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="sandbox">Sandbox (test data)</option>
              <option value="development">Development (live, free up to 100 items)</option>
              <option value="production">Production (requires paid plan)</option>
            </select>
          </div>

          <div className="flex gap-3 justify-end">
            {config.configured && (
              <button
                onClick={() => setEditing(false)}
                className="px-4 py-2 text-sm text-gray-600"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-brand-blue text-white rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Credentials'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Schedule section ─────────────────────────────────────────────────────────

function ScheduleSection() {
  const [schedule, setSchedule] = useState({ enabled: false, cron: '0 2 * * *', last_sync: null as string | null })
  const [enabled, setEnabled] = useState(false)
  const [cron, setCron] = useState('0 2 * * *')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api.plaid.getSchedule().then((r) => {
      if (r.success) {
        setSchedule(r.data)
        setEnabled(r.data.enabled)
        setCron(r.data.cron)
      }
    })
  }, [])

  async function handleSave() {
    setSaving(true)
    await window.api.plaid.saveSchedule({ enabled, cron })
    setSaving(false)
    setSchedule((s) => ({ ...s, enabled, cron }))
  }

  const isDirty = enabled !== schedule.enabled || cron !== schedule.cron

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <h3 className="font-semibold text-gray-900 mb-1">Auto-Sync Schedule</h3>
      <p className="text-sm text-gray-500 mb-4">
        Automatically pull new transactions from Plaid even when the app is minimized.
      </p>

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setEnabled(!enabled)}
            className={`relative w-10 h-6 rounded-full transition-colors ${
              enabled ? 'bg-brand-blue' : 'bg-gray-300'
            }`}
          >
            <span
              className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                enabled ? 'translate-x-5' : 'translate-x-1'
              }`}
            />
          </button>
          <span className="text-sm text-gray-700">
            {enabled ? 'Auto-sync enabled' : 'Auto-sync disabled (manual only)'}
          </span>
        </div>

        {enabled && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Schedule</label>
            <div className="grid grid-cols-2 gap-2 mb-3">
              {PRESET_SCHEDULES.filter((p) => p.cron).map((preset) => (
                <button
                  key={preset.cron}
                  onClick={() => setCron(preset.cron)}
                  className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                    cron === preset.cron
                      ? 'border-brand-blue bg-blue-50 text-brand-blue font-medium'
                      : 'border-gray-200 text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600 whitespace-nowrap">Custom cron:</label>
              <input
                type="text"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 2 * * *"
                className="border border-gray-300 rounded px-2 py-1 text-sm font-mono w-36"
              />
              <span className="text-xs text-gray-400">{describeCron(cron)}</span>
            </div>
          </div>
        )}

        {schedule.last_sync && (
          <p className="text-xs text-gray-500">
            Last auto-sync: {new Date(schedule.last_sync).toLocaleString()}
          </p>
        )}

        {isDirty && (
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-brand-blue text-white rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save Schedule'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Manual sync ─────────────────────────────────────────────────────────────

function ManualSyncSection() {
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function handleSyncNow() {
    setSyncing(true)
    setResult(null)
    const res = await window.api.plaid.syncAll()
    setSyncing(false)
    if (res.success) {
      const totals = Object.values(res.data as Record<string, any>).reduce(
        (acc: any, r: any) => ({
          new: acc.new + (r.transactions_new || 0),
          queued: acc.queued + (r.transactions_queued || 0),
        }),
        { new: 0, queued: 0 }
      )
      setResult(`Done — ${totals.new} new transactions, ${totals.queued} queued for review.`)
    } else {
      setResult(`Error: ${res.error}`)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <h3 className="font-semibold text-gray-900 mb-1">Manual Sync</h3>
      <p className="text-sm text-gray-500 mb-4">
        Pull all new transactions from connected Plaid accounts right now.
      </p>
      <div className="flex items-center gap-4">
        <button
          onClick={handleSyncNow}
          disabled={syncing}
          className="flex items-center gap-2 px-4 py-2 bg-brand-blue text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {syncing && <span className="animate-spin inline-block">⟳</span>}
          {syncing ? 'Syncing…' : 'Sync All Accounts Now'}
        </button>
        {result && (
          <span className={`text-sm ${result.startsWith('Error') ? 'text-red-600' : 'text-green-700'}`}>
            {result}
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Sync log section ────────────────────────────────────────────────────────

function SyncLogSection() {
  const [logs, setLogs] = useState<SyncLogEntry[]>([])
  const [loading, setLoading] = useState(true)

  const loadLogs = useCallback(async () => {
    setLoading(true)
    const res = await window.api.syncLog.list(50)
    if (res.success) setLogs(res.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    loadLogs()

    // Refresh log after sync events
    window.api.plaid.onSyncCompleted(() => loadLogs())
    window.api.plaid.onSyncError(() => loadLogs())

    return () => window.api.plaid.removeAllListeners()
  }, [loadLogs])

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <h3 className="font-semibold text-gray-900">Sync Log</h3>
        <button onClick={loadLogs} className="text-xs text-brand-blue hover:underline">
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="py-8 text-center text-gray-400 text-sm">Loading…</div>
      ) : logs.length === 0 ? (
        <div className="py-8 text-center text-gray-400 text-sm">
          No sync operations yet. Connect an account and click "Sync Now".
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-600">Time</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-600">Type</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-600">Status</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600">New</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600">Queued</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600">Time</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-600">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {logs.map((entry) => (
                <SyncLogRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function SyncSchedule() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Sync & Schedule</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Configure Plaid credentials, auto-sync schedule, and view import history.
        </p>
      </div>

      <PlaidConfigSection />
      <ManualSyncSection />
      <ScheduleSection />
      <SyncLogSection />
    </div>
  )
}
