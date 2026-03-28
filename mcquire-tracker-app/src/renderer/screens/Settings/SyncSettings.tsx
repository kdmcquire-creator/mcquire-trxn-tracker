import { useEffect, useState } from "react"

export default function SyncSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [log, setLog] = useState<any[]>([])
  const [syncing, setSyncing] = useState(false)
  const [plaidCreds, setPlaidCreds] = useState({ clientId: "", secret: "", env: "development" })
  const [showPlaid, setShowPlaid] = useState(false)

  useEffect(() => {
    window.api.db.getAllSettings().then(setSettings)
    window.api.syncLog.list().then(setLog)
    window.api.plaid.getConfig().then(c => { if (c) setPlaidCreds({ ...plaidCreds, clientId: c.client_id, env: c.env }) })
  }, [])

  const save = async (key: string, val: string) => {
    await window.api.db.setSetting(key, val)
    setSettings(s => ({ ...s, [key]: val }))
  }

  const syncNow = async () => {
    setSyncing(true)
    await window.api.plaid.syncAll()
    await window.api.syncLog.list().then(setLog)
    setSyncing(false)
  }

  const savePlaid = async () => {
    await window.api.plaid.saveConfig({ client_id: plaidCreds.clientId, secret: plaidCreds.secret, env: plaidCreds.env })
    setShowPlaid(false)
    alert("Plaid credentials saved.")
  }

  const statusColor = (s: string) => s === "success" ? "text-green-600" : s === "error" ? "text-red-600" : "text-orange-500"

  return (
    <div className="max-w-2xl space-y-6">
      {/* Auto sync */}
      <div className="card">
        <h3 className="font-bold text-gray-700 mb-3">🔄 Auto-Sync Schedule</h3>
        <label className="flex items-center gap-2 text-sm mb-3 cursor-pointer">
          <input type="checkbox" checked={settings.auto_sync_enabled === "1"}
            onChange={e => save("auto_sync_enabled", e.target.checked ? "1" : "0")} />
          Enable automatic sync
        </label>
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-600">Cron schedule:</label>
          <input value={settings.auto_sync_cron ?? "0 2 * * *"}
            onChange={e => save("auto_sync_cron", e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm font-mono w-40" />
          <span className="text-xs text-gray-400">(default: 2:00 AM daily)</span>
        </div>
        <button onClick={syncNow} disabled={syncing} className="btn btn-primary text-sm mt-3">
          {syncing ? "Syncing..." : "🔄 Sync All Now"}
        </button>
      </div>

      {/* Plaid */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-gray-700">🔗 Plaid Configuration</h3>
          <button onClick={() => setShowPlaid(!showPlaid)} className="btn btn-secondary text-sm">
            {showPlaid ? "Hide" : "Configure"}
          </button>
        </div>
        {plaidCreds.clientId
          ? <div className="text-sm text-green-700">✅ Plaid configured · Client ID: {plaidCreds.clientId.substring(0, 8)}...</div>
          : <div className="text-sm text-orange-600">⚠️ Plaid not configured — Chase, Schwab, and Fidelity auto-sync requires Plaid setup.</div>
        }
        {showPlaid && (
          <div className="mt-4 space-y-3 border-t pt-4">
            <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-700">
              Get your Client ID and Secret from <strong>dashboard.plaid.com</strong> → Team Settings → Keys. Use Development tier (free for up to 100 items).
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Client ID</label>
              <input value={plaidCreds.clientId} onChange={e => setPlaidCreds({ ...plaidCreds, clientId: e.target.value })}
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Secret</label>
              <input type="password" value={plaidCreds.secret} onChange={e => setPlaidCreds({ ...plaidCreds, secret: e.target.value })}
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="••••••••" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Environment</label>
              <select value={plaidCreds.env} onChange={e => setPlaidCreds({ ...plaidCreds, env: e.target.value })}
                className="w-full border rounded-lg px-3 py-2 text-sm">
                <option value="sandbox">Sandbox (test)</option>
                <option value="development">Development (live, free)</option>
                <option value="production">Production</option>
              </select>
            </div>
            <button onClick={savePlaid} className="btn btn-primary text-sm">Save Plaid Credentials</button>
          </div>
        )}
      </div>

      {/* Watched folders */}
      <div className="card">
        <h3 className="font-bold text-gray-700 mb-3">📁 Watched Folder Paths</h3>
        <p className="text-sm text-gray-500 mb-3">Drop CSV exports in these folders. The app processes them within 5 seconds automatically.</p>
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between bg-slate-50 rounded px-3 py-2">
            <span className="text-gray-600">USAA exports</span>
            <span className="font-mono text-xs text-gray-500">[sync folder]/imports/usaa/</span>
          </div>
          <div className="flex items-center justify-between bg-slate-50 rounded px-3 py-2">
            <span className="text-gray-600">Apple Card exports</span>
            <span className="font-mono text-xs text-gray-500">[sync folder]/imports/apple_card/</span>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">Processed files are moved to .../processed/ with a timestamp prefix and kept as archive.</p>
      </div>

      {/* Sync log */}
      <div className="card">
        <h3 className="font-bold text-gray-700 mb-3">📋 Recent Sync Log</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b">
                <th className="text-left py-1.5 pr-3">Time</th>
                <th className="text-left py-1.5 pr-3">Type</th>
                <th className="text-right py-1.5 pr-3">New</th>
                <th className="text-right py-1.5 pr-3">Classified</th>
                <th className="text-right py-1.5 pr-3">Queued</th>
                <th className="text-left py-1.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {log.map(l => (
                <tr key={l.id} className="border-b border-gray-50">
                  <td className="py-1.5 pr-3 text-gray-400">{new Date(l.started_at).toLocaleString()}</td>
                  <td className="py-1.5 pr-3">{l.sync_type}{l.source_file ? ` · ${l.source_file}` : ""}</td>
                  <td className="text-right py-1.5 pr-3">{l.transactions_new}</td>
                  <td className="text-right py-1.5 pr-3">{l.transactions_classified}</td>
                  <td className="text-right py-1.5 pr-3">{l.transactions_queued}</td>
                  <td className={`py-1.5 font-medium ${statusColor(l.status)}`}>{l.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
