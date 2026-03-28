import { useEffect, useState } from "react"

const SMTP_PRESETS = [
  { label: "Gmail (App Password)", host: "smtp.gmail.com", port: 587, secure: false },
  { label: "Outlook / Office 365", host: "smtp.office365.com", port: 587, secure: false },
  { label: "Custom SMTP", host: "", port: 587, secure: false },
]

export default function NotificationSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [smtp, setSmtp] = useState({ host: "", port: 587, secure: false, user: "", password: "" })
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [testing, setSaving] = useState(false)

  useEffect(() => {
    window.api.db.getAllSettings().then(setSettings)
    window.api.settings.getSmtp().then(c => { if (c) setSmtp({ ...smtp, ...c }) })
  }, [])

  const save = async (key: string, val: string) => {
    await window.api.db.setSetting(key, val)
    setSettings(s => ({ ...s, [key]: val }))
  }

  const saveSmtp = async () => {
    await window.api.settings.saveSmtp(smtp)
    alert("SMTP settings saved securely.")
  }

  const testEmail = async () => {
    setSaving(true)
    const result = await window.api.settings.testEmail(settings.notification_email ?? "")
    setTestResult(result)
    setSaving(false)
  }

  const applyPreset = (preset: typeof SMTP_PRESETS[0]) => {
    setSmtp(s => ({ ...s, host: preset.host, port: preset.port, secure: preset.secure }))
  }

  return (
    <div className="max-w-xl space-y-5">
      {/* Email address */}
      <div className="card">
        <h3 className="font-bold text-gray-700 mb-3">📧 Notification Email</h3>
        <div className="flex gap-2">
          <input value={settings.notification_email ?? ""} onChange={e => save("notification_email", e.target.value)}
            type="email" placeholder="kyle@example.com"
            className="flex-1 border rounded-lg px-3 py-2 text-sm" />
        </div>
        <div className="mt-3">
          <label className="text-xs text-gray-500 block mb-1">Send notification when pending items ≥</label>
          <input type="number" min="1" value={settings.review_email_threshold ?? "1"}
            onChange={e => save("review_email_threshold", e.target.value)}
            className="w-20 border rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      {/* SMTP */}
      <div className="card">
        <h3 className="font-bold text-gray-700 mb-3">🔒 SMTP Configuration</h3>
        <p className="text-xs text-gray-400 mb-3">Credentials are stored in Windows Credential Manager. Never written to any file.</p>

        <div className="flex gap-2 mb-3">
          {SMTP_PRESETS.map(p => (
            <button key={p.label} onClick={() => applyPreset(p)} className="btn btn-secondary text-xs">{p.label}</button>
          ))}
        </div>

        {SMTP_PRESETS[0].host === smtp.host && (
          <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-700 mb-3">
            Gmail: Enable 2FA on your Google account, then go to Google Account → Security → App Passwords and generate a 16-character password. Use that here — not your regular Gmail password.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="text-xs text-gray-500 block mb-1">SMTP Host</label>
            <input value={smtp.host} onChange={e => setSmtp({ ...smtp, host: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Port</label>
            <input type="number" value={smtp.port} onChange={e => setSmtp({ ...smtp, port: parseInt(e.target.value) })} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={smtp.secure} onChange={e => setSmtp({ ...smtp, secure: e.target.checked })} />
              Use SSL/TLS (port 465)
            </label>
          </div>
          <div className="col-span-2">
            <label className="text-xs text-gray-500 block mb-1">Username (email address)</label>
            <input value={smtp.user} onChange={e => setSmtp({ ...smtp, user: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-gray-500 block mb-1">App Password</label>
            <input type="password" value={smtp.password} onChange={e => setSmtp({ ...smtp, password: e.target.value })}
              placeholder="••••••••••••••••" className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="flex gap-2 mt-3">
          <button onClick={saveSmtp} className="btn btn-primary text-sm">Save SMTP Settings</button>
          <button onClick={testEmail} disabled={testing || !settings.notification_email} className="btn btn-secondary text-sm disabled:opacity-40">
            {testing ? "Sending..." : "Send Test Email"}
          </button>
        </div>

        {testResult && (
          <div className={`mt-3 text-sm rounded-lg p-2 ${testResult.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
            {testResult.success ? "✅ Test email sent successfully!" : `❌ Failed: ${testResult.error}`}
          </div>
        )}
      </div>

      {/* Notification triggers */}
      <div className="card">
        <h3 className="font-bold text-gray-700 mb-3">🔔 Notification Triggers</h3>
        <div className="space-y-2 text-sm text-gray-600">
          {[
            "New transactions need review (after any sync)",
            "Sync error (Plaid connection fails)",
            "Re-authentication required (Plaid login expired)",
            "Watched folder file processed (USAA / Apple Card import)",
            "Expense report ready (all blocking issues resolved)",
            "Flagged items aging (unflagged for > 7 days)",
          ].map(t => (
            <div key={t} className="flex items-center gap-2">
              <span className="text-green-500">✓</span>
              <span>{t}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
