import React, { useEffect, useState, useCallback } from "react"

type Tab = "accounts" | "rules" | "sync" | "notifications" | "trips" | "ai"

const RULE_SECTIONS = ["exclusion", "llc_always", "p10_always", "p10_conditional", "personal_override", "special", "ask_kyle"]
const RULE_ACTIONS = ["classify", "ask_kyle", "exclude", "split_flag"]
const MATCH_TYPES = ["contains", "exact", "starts_with", "regex"]
const BUCKETS = ["Peak 10", "Moonsmoke LLC", "Personal", "Watersound Investments LLC", "Exclude"]
const ENTITIES = ["Personal", "Moonsmoke LLC", "Peak 10", "Watersound Investments LLC"]
const P10_CATEGORIES = [
  "Meals & Meetings - external", "Travel", "Lodging", "Dues & Subscriptions",
  "Office Supplies & Expenses", "Telephone & Communication", "Other - Executive Wellness",
]
const LLC_CATEGORIES = [
  "Rent - Business Lodging", "Lodging - Business Housing", "Utilities - Home Office",
  "Executive Wellness", "Payroll - Salary", "Taxes - Payroll", "Business Services - Payroll",
  "Business Services - Software", "Business Services - Other", "Bank Fees",
  "Telephone - Business Line", "Meals & Entertainment", "Travel", "Business Expenses - Other",
]

const sectionColor: Record<string, string> = {
  exclusion: "bg-red-100 text-red-700",
  llc_always: "bg-green-100 text-green-700",
  p10_always: "bg-blue-100 text-blue-700",
  p10_conditional: "bg-sky-100 text-sky-700",
  personal_override: "bg-gray-100 text-gray-600",
  special: "bg-purple-100 text-purple-700",
  ask_kyle: "bg-orange-100 text-orange-700",
}

export default function Settings() {
  const [tab, setTab] = useState<Tab>("accounts")
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-800 mb-5">Settings</h1>
      <div className="flex border-b border-slate-200 mb-6 gap-1">
        {(["accounts", "rules", "trips", "sync", "notifications", "ai"] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-5 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${tab === t ? "bg-white border border-b-white border-slate-200 text-blue-600 -mb-px" : "text-slate-500 hover:text-slate-700"}`}>
            {t === "accounts" ? "Account Management" : t === "rules" ? "Rule Editor" : t === "trips" ? "Personal Trips" : t === "sync" ? "Sync & Schedule" : t === "ai" ? "AI Classification" : "Notifications"}
          </button>
        ))}
      </div>
      {tab === "accounts" && <AccountsTab />}
      {tab === "rules" && <RulesTab />}
      {tab === "trips" && <TripsTab />}
      {tab === "sync" && <SyncTab />}
      {tab === "notifications" && <NotificationsTab />}
      {tab === "ai" && <AiClassificationTab />}
    </div>
  )
}

// ── Account assignment modal ──────────────────────────────────────────────────
interface RawPlaidAccount { id: string; name: string; mask: string; type: string; subtype: string }
interface AssignedAccount extends RawPlaidAccount { entity: string; default_bucket: string }

function AccountAssignmentModal({ institutionName, rawAccounts, onConfirm, onCancel }: {
  institutionName: string; rawAccounts: RawPlaidAccount[]
  onConfirm: (a: AssignedAccount[]) => Promise<void>; onCancel: () => void
}) {
  const [accounts, setAccounts] = useState<AssignedAccount[]>(() =>
    rawAccounts.map(a => ({ ...a, entity: "Personal", default_bucket: "Personal" }))
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = (idx: number, field: keyof AssignedAccount, value: string) =>
    setAccounts(prev => prev.map((a, i) => i === idx ? { ...a, [field]: value } : a))

  const handleConfirm = async () => {
    setSaving(true); setError(null)
    try { await onConfirm(accounts) }
    catch (e: any) { setError(e?.message ?? "Unknown error"); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl">
        <div className="p-6 border-b border-slate-200">
          <h2 className="text-lg font-bold text-slate-800">Accounts Found — {institutionName}</h2>
          <p className="text-sm text-slate-500 mt-1">Plaid found {rawAccounts.length} account{rawAccounts.length !== 1 ? "s" : ""}. Assign entity and default bucket to each before saving.</p>
        </div>
        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          {accounts.map((a, i) => (
            <div key={a.id} className="bg-slate-50 border border-slate-200 rounded-xl p-4">
              <div className="flex items-center gap-3 mb-3">
                <span className="font-semibold text-slate-800">{a.name}</span>
                <span className="text-xs text-slate-500">···{a.mask}</span>
                <span className="text-xs text-slate-400 capitalize">{a.type} · {a.subtype}</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-500 block mb-1">Entity</label>
                  <select value={a.entity} onChange={e => update(i, "entity", e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
                    {ENTITIES.map(en => <option key={en} value={en}>{en}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 block mb-1">Default Bucket</label>
                  <select value={a.default_bucket} onChange={e => update(i, "default_bucket", e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">No default (follow rules)</option>
                    {["Peak 10", "Moonsmoke LLC", "Personal", "Watersound Investments LLC"].map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
              </div>
            </div>
          ))}
        </div>
        {error && <div className="mx-6 mb-2 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}
        <div className="p-6 border-t border-slate-200 flex gap-3">
          <button onClick={onCancel} disabled={saving} className="flex-1 py-2.5 border border-slate-300 rounded-lg text-sm hover:bg-slate-50 disabled:opacity-50">Cancel</button>
          <button onClick={handleConfirm} disabled={saving} className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Connecting..." : `Connect ${accounts.length} Account${accounts.length !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Accounts Tab ──────────────────────────────────────────────────────────────
function AccountsTab() {
  const [accounts, setAccounts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgType, setMsgType] = useState<"success"|"error">("success")
  const [pendingLink, setPendingLink] = useState<{ public_token: string; institution_id: string; institution_name: string; accounts: RawPlaidAccount[] } | null>(null)
  const [editingAccount, setEditingAccount] = useState<any | null>(null)
  const [editEntity, setEditEntity] = useState("")
  const [editBucket, setEditBucket] = useState("")

  const showMsg = (text: string, type: "success"|"error" = "success") => { setMsg(text); setMsgType(type) }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.accounts.list().catch(() => null)
      // IPC wraps response: { success, data } — unwrap .data; fall back if already an array
      const data = result?.data ?? result ?? []
      setAccounts(Array.isArray(data) ? data : [])
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleAddPlaid = async () => {
    setConnecting(true); setMsg(null)
    try {
      // Step 1: create link token — returns { success, data: "link-sandbox-xxx" }
      const tokenResult = await window.api.plaid.createLinkToken()
      if (!tokenResult?.success) throw new Error(tokenResult?.error ?? "Failed to create Plaid link token. Verify your Plaid credentials in Sync & Schedule.")
      const linkToken: string = tokenResult.data

      // Step 2: open Plaid Link window — user logs into bank inside the window
      // Returns { success, data: { public_token, institution_id, institution_name, accounts[] } }
      const linkResult = await window.api.plaid.openLink(linkToken)
      if (!linkResult?.success) {
        if (linkResult?.error?.includes("closed without completing")) return
        throw new Error(linkResult?.error ?? "Plaid Link did not complete.")
      }
      const plaidData = linkResult.data

      // Step 3: show account assignment modal — user sets entity + bucket before we persist
      setPendingLink({
        public_token: plaidData.public_token,
        institution_id: plaidData.institution_id,
        institution_name: plaidData.institution_name,
        accounts: plaidData.accounts ?? [],
      })
    } catch (e: any) {
      if (!e?.message?.includes("closed without completing")) showMsg("Connection error: " + (e?.message ?? "unknown"), "error")
    } finally {
      setConnecting(false)
    }
  }

  const handleExchangeToken = async (assignedAccounts: AssignedAccount[]) => {
    if (!pendingLink) return
    // Step 4: exchange token — map Plaid field names → what the IPC handler expects
    const payload = {
      public_token: pendingLink.public_token,
      institution_id: pendingLink.institution_id,
      institution_name: pendingLink.institution_name,
      accounts: assignedAccounts.map(a => ({
        plaid_account_id: a.id,        // Plaid: "id"   → IPC: "plaid_account_id"
        account_name:     a.name,      // Plaid: "name" → IPC: "account_name"
        account_mask:     a.mask,      // Plaid: "mask" → IPC: "account_mask"
        account_type:     a.type,      // Plaid: "type" → IPC: "account_type"
        entity:           a.entity,
        default_bucket:   a.default_bucket,
      })),
    }
    const result = await window.api.plaid.exchangeToken(payload)
    if (!result?.success) throw new Error(result?.error ?? "Token exchange failed.")
    setPendingLink(null)
    showMsg(`✅ Connected ${assignedAccounts.length} account${assignedAccounts.length !== 1 ? "s" : ""} from ${pendingLink.institution_name}`, "success")
    load()
  }

  const handleReauth = async (plaidItemId: string) => {
    try {
      const result = await window.api.plaid.reauth(plaidItemId)
      if (!result?.success) throw new Error(result?.error)
      showMsg("Re-authentication successful.", "success")
    } catch (e: any) { showMsg("Re-auth error: " + (e?.message ?? "unknown"), "error") }
    load()
  }

  const handleDisable = async (id: string) => {
    try { await window.api.accounts.disable(id) } catch {}
    load()
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Permanently remove "${name}"? Historical transactions are kept.`)) return
    try { await window.api.accounts.delete(id) } catch {}
    load()
  }

  const openEdit = (a: any) => {
    setEditingAccount(a)
    setEditEntity(a.entity ?? "Personal")
    setEditBucket(a.default_bucket ?? "")
  }

  const handleUpdate = async () => {
    if (!editingAccount) return
    const result = await window.api.accounts.update({
      id: editingAccount.id,
      account_name: editingAccount.account_name,
      entity: editEntity,
      default_bucket: editBucket,
      notes: editingAccount.notes ?? null,
    })
    if (result?.success === false) {
      showMsg("Update failed: " + (result.error ?? "unknown"), "error")
    } else {
      showMsg(`${editingAccount.account_name} updated.`, "success")
      setEditingAccount(null)
      load()
    }
  }

  if (loading) return <div className="text-slate-500">Loading accounts...</div>

  return (
    <div className="space-y-5">
      {editingAccount && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setEditingAccount(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-[380px] p-6" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-slate-800 mb-1">{editingAccount.account_name}</h3>
            <p className="text-xs text-slate-500 mb-4">{editingAccount.institution} ···{editingAccount.account_mask}</p>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-500 block mb-1">Entity</label>
                <select value={editEntity} onChange={e => setEditEntity(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
                  {ENTITIES.map(en => <option key={en} value={en}>{en}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 block mb-1">Default Bucket</label>
                <select value={editBucket} onChange={e => setEditBucket(e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
                  <option value="">No default (follow rules)</option>
                  {["Peak 10", "Moonsmoke LLC", "Personal", "Watersound Investments LLC"].map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-3 mt-5 justify-end">
              <button onClick={() => setEditingAccount(null)} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
              <button onClick={handleUpdate} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">Save</button>
            </div>
          </div>
        </div>
      )}
      {pendingLink && (
        <AccountAssignmentModal
          institutionName={pendingLink.institution_name}
          rawAccounts={pendingLink.accounts}
          onConfirm={handleExchangeToken}
          onCancel={() => setPendingLink(null)}
        />
      )}
      {msg && (
        <div className={`rounded-lg p-3 text-sm flex items-center justify-between ${msgType === "error" ? "bg-red-50 border border-red-200 text-red-700" : "bg-green-50 border border-green-200 text-green-700"}`}>
          {msg}<button onClick={() => setMsg(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">{accounts.length} account{accounts.length !== 1 ? "s" : ""} configured</p>
        <button onClick={handleAddPlaid} disabled={connecting}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
          {connecting ? "Opening Plaid..." : "+ Connect via Plaid"}
        </button>
      </div>
      {accounts.length === 0 && (
        <div className="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-8 text-center text-slate-400">
          <p className="font-medium text-slate-600 mb-1">No accounts configured yet</p>
          <p className="text-sm">Click "Connect via Plaid" to link Chase, Schwab, or Fidelity.</p>
          <p className="text-sm">For USAA and Apple Card, use the Sync & Schedule tab for watched folders.</p>
          <p className="text-xs mt-3">Make sure Plaid credentials are saved in Sync & Schedule first.</p>
        </div>
      )}
      <div className="space-y-3">
        {accounts.map((a: any) => (
          <div key={a.id} className={`bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between ${!a.is_active ? "opacity-50" : ""}`}>
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-slate-500 font-bold text-sm">
                {a.institution?.slice(0, 2).toUpperCase() ?? "??"}
              </div>
              <div>
                <div className="font-semibold text-slate-800">{a.institution} {a.account_mask ? `···${a.account_mask}` : ""}</div>
                <div className="text-xs text-slate-500">{a.account_name} · {a.account_type} · {a.import_method}</div>
                <div className="text-xs text-slate-400">Bucket: {a.default_bucket ?? "—"} · Entity: {a.entity ?? "—"}</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-xs text-right text-slate-400">
                {a.last_synced_at ? `Last sync: ${new Date(a.last_synced_at).toLocaleDateString()}` : "Never synced"}
              </div>
              {(a.plaid_status === "error" || a.plaid_status === "login_required") && (
                <button onClick={() => handleReauth(a.plaid_item_id)}
                  className="text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded-full hover:bg-orange-200">
                  ⚠️ Re-authenticate
                </button>
              )}
              <button onClick={() => openEdit(a)} className="text-xs text-blue-600 hover:underline">Edit</button>
              {a.is_active
                ? <button onClick={() => handleDisable(a.id)} className="text-xs text-slate-400 hover:text-orange-500 underline">Disable</button>
                : <span className="text-xs text-slate-300">Disabled</span>}
              <button onClick={() => handleDelete(a.id, a.account_name ?? a.institution)} className="text-xs text-slate-400 hover:text-red-600 underline">Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Rules Tab ──────────────────────────────────────────────────────────────────
function RulesTab() {
  const [rules, setRules] = useState<any[]>([])
  const [trips, setTrips] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [filterSection, setFilterSection] = useState("")
  const [editRule, setEditRule] = useState<any | null>(null)
  const [editState, setEditState] = useState<any>({})
  const [saving, setSaving] = useState(false)
  const [showTrips, setShowTrips] = useState(false)
  const [tripForm, setTripForm] = useState({ name: "", start: "", end: "" })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rResult, tResult] = await Promise.all([
        window.api.rules.getAll().catch(() => null),
        window.api.trips.getAll().catch(() => null),
      ])
      const rData = rResult?.data ?? rResult ?? []
      const tData = tResult?.data ?? tResult ?? []
      setRules(Array.isArray(rData) ? rData.sort((a: any, b: any) => (a.priority_order ?? 0) - (b.priority_order ?? 0)) : [])
      setTrips(Array.isArray(tData) ? tData : [])
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = rules.filter(r => {
    if (filterSection && r.section !== filterSection) return false
    if (search) {
      const q = search.toLowerCase()
      return [r.rule_name, r.match_value, r.bucket].some(v => String(v ?? "").toLowerCase().includes(q))
    }
    return true
  })

  const openNew = () => {
    setEditRule({ __new: true })
    setEditState({ rule_name: "", section: "p10_always", match_type: "contains", match_value: "", account_mask_filter: "", amount_min: "", amount_max: "", date_from_filter: "", date_to_filter: "", bucket: "Peak 10", p10_category: "", llc_category: "", description_notes: "", flag_reason: "", action: "classify", priority_order: 850, is_active: 1, notes: "" })
  }

  const saveRule = async () => {
    setSaving(true)
    try {
      const payload: any = { ...editState }
      if (!payload.rule_name || !payload.match_value) { alert("Rule name and match value are required"); setSaving(false); return }
      payload.amount_min = payload.amount_min !== "" ? parseFloat(payload.amount_min) : null
      payload.amount_max = payload.amount_max !== "" ? parseFloat(payload.amount_max) : null
      if (!editRule.__new) payload.id = editRule.id
      await window.api.rules.save(payload)
      setEditRule(null); load()
    } catch (e: any) { alert("Save error: " + (e?.message ?? "unknown")) }
    finally { setSaving(false) }
  }

  const ES = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setEditState((s: any) => ({ ...s, [key]: e.target.value }))

  if (loading) return <div className="text-slate-500">Loading rules...</div>

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input type="text" placeholder="Search rules..." value={search} onChange={e => setSearch(e.target.value)} className="flex-1 min-w-[180px] border border-slate-300 rounded-lg px-3 py-2 text-sm" />
        <select value={filterSection} onChange={e => setFilterSection(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-2 text-sm">
          <option value="">All sections</option>
          {RULE_SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={openNew} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 whitespace-nowrap">+ New Rule</button>
        <button onClick={() => setShowTrips(!showTrips)} className="px-4 py-2 border border-slate-300 text-sm rounded-lg hover:bg-slate-50 whitespace-nowrap">✈️ Trip Dates ({trips.length})</button>
      </div>

      <p className="text-xs text-slate-500 mb-3">{filtered.length} rules · priority order (lower = first)</p>

      {showTrips && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4">
          <h3 className="font-semibold text-blue-800 mb-3 text-sm">Personal Trip Exclusion Dates</h3>
          <div className="space-y-2 mb-3">
            {trips.length === 0 && <p className="text-sm text-blue-600">No trips. NYC Trip (Nov 24–28, 2025) should be seeded at init.</p>}
            {trips.map((t: any) => (
              <div key={t.id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 text-sm">
                <span className="font-medium text-slate-700">{t.trip_name}</span>
                <span className="text-slate-500">{t.start_date} → {t.end_date}</span>
                <button onClick={async () => { try { await window.api.trips.delete(t.id) } catch {}; load() }} className="text-red-400 hover:text-red-600 text-xs">Delete</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2 items-end flex-wrap">
            {["name","start","end"].map(f => (
              <div key={f}>
                <label className="text-xs text-blue-700 block mb-1 capitalize">{f === "start" || f === "end" ? f + " date" : f}</label>
                {f === "name"
                  ? <input value={tripForm.name} onChange={e => setTripForm(p => ({ ...p, name: e.target.value }))} className="border border-blue-300 rounded px-2 py-1 text-sm w-32" />
                  : <input type="date" value={(tripForm as any)[f]} onChange={e => setTripForm(p => ({ ...p, [f]: e.target.value }))} className="border border-blue-300 rounded px-2 py-1 text-sm" />
                }
              </div>
            ))}
            <button onClick={async () => {
              if (!tripForm.name || !tripForm.start || !tripForm.end) { alert("Fill all fields"); return }
              try { await window.api.trips.save({ trip_name: tripForm.name, start_date: tripForm.start, end_date: tripForm.end }) } catch {}
              setTripForm({ name: "", start: "", end: "" }); load()
            }} className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">Add</button>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left px-4 py-3 text-slate-600 w-16">Pri.</th>
              <th className="text-left px-4 py-3 text-slate-600">Section</th>
              <th className="text-left px-4 py-3 text-slate-600">Rule</th>
              <th className="text-left px-4 py-3 text-slate-600">Match</th>
              <th className="text-left px-4 py-3 text-slate-600">Bucket</th>
              <th className="px-4 py-3 w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No rules match</td></tr>}
            {filtered.map(r => (
              <tr key={r.id} className={`hover:bg-slate-50 ${!r.is_active ? "opacity-40" : ""}`}>
                <td className="px-4 py-2 text-slate-500 font-mono text-xs">{r.priority_order}</td>
                <td className="px-4 py-2"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sectionColor[r.section] ?? "bg-gray-100 text-gray-600"}`}>{r.section}</span></td>
                <td className="px-4 py-2 font-medium text-slate-800 max-w-[180px] truncate">{r.rule_name}</td>
                <td className="px-4 py-2 text-slate-600 text-xs"><span className="text-slate-400">{r.match_type}:</span> {r.match_value}{r.account_mask_filter && <span className="ml-1 text-slate-400">···{r.account_mask_filter}</span>}</td>
                <td className="px-4 py-2 text-slate-700 text-xs">{r.bucket}</td>
                <td className="px-4 py-2 flex gap-2">
                  <button onClick={() => { setEditRule(r); setEditState({ ...r, amount_min: r.amount_min ?? "", amount_max: r.amount_max ?? "" }) }} className="text-blue-600 text-xs hover:underline">Edit</button>
                  <button onClick={async () => { if (!confirm("Delete?")) return; try { await window.api.rules.delete(r.id) } catch {}; load() }} className="text-red-400 text-xs hover:underline">Del</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editRule && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-auto">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-6 my-8">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-slate-800">{editRule.__new ? "New Rule" : "Edit Rule"}</h2>
              <button onClick={() => setEditRule(null)} className="text-slate-400 hover:text-slate-600 text-xl">✕</button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2"><label className="text-xs font-semibold text-slate-500 block mb-1">Rule Name</label><input value={editState.rule_name ?? ""} onChange={ES("rule_name")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Section</label><select value={editState.section ?? ""} onChange={ES("section")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">{RULE_SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Priority</label><input type="number" value={editState.priority_order ?? 850} onChange={ES("priority_order")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Match Type</label><select value={editState.match_type ?? "contains"} onChange={ES("match_type")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">{MATCH_TYPES.map(m => <option key={m} value={m}>{m}</option>)}</select></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Match Value</label><input value={editState.match_value ?? ""} onChange={ES("match_value")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Account Filter</label><input value={editState.account_mask_filter ?? ""} onChange={ES("account_mask_filter")} placeholder="e.g. 5829 or blank=any" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Action</label><select value={editState.action ?? "classify"} onChange={ES("action")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">{RULE_ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}</select></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Amount Min</label><input type="number" step="0.01" value={editState.amount_min ?? ""} onChange={ES("amount_min")} placeholder="blank=none" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Amount Max</label><input type="number" step="0.01" value={editState.amount_max ?? ""} onChange={ES("amount_max")} placeholder="blank=none" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Date From</label><input type="date" value={editState.date_from_filter ?? ""} onChange={ES("date_from_filter")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Date To</label><input type="date" value={editState.date_to_filter ?? ""} onChange={ES("date_to_filter")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Bucket</label><select value={editState.bucket ?? ""} onChange={ES("bucket")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"><option value="">— Select —</option>{BUCKETS.map(b => <option key={b} value={b}>{b}</option>)}</select></div>
              {editState.bucket === "Peak 10" && <div><label className="text-xs font-semibold text-slate-500 block mb-1">P10 Category</label><select value={editState.p10_category ?? ""} onChange={ES("p10_category")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"><option value="">— Select —</option>{P10_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>}
              {editState.bucket === "Moonsmoke LLC" && <div><label className="text-xs font-semibold text-slate-500 block mb-1">LLC Category</label><select value={editState.llc_category ?? ""} onChange={ES("llc_category")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"><option value="">— Select —</option>{LLC_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>}
              <div className="col-span-2"><label className="text-xs font-semibold text-slate-500 block mb-1">Description/Notes</label><input value={editState.description_notes ?? ""} onChange={ES("description_notes")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
              <div className="col-span-2"><label className="text-xs font-semibold text-slate-500 block mb-1">Flag Reason</label><input value={editState.flag_reason ?? ""} onChange={ES("flag_reason")} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
              <div className="col-span-2"><label className="text-xs font-semibold text-slate-500 block mb-1">Notes</label><textarea value={editState.notes ?? ""} onChange={ES("notes")} rows={2} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
              <div className="col-span-2"><label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer"><input type="checkbox" checked={!!editState.is_active} onChange={e => setEditState((s: any) => ({ ...s, is_active: e.target.checked ? 1 : 0 }))} className="rounded" />Rule is active</label></div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setEditRule(null)} className="flex-1 py-2 border border-slate-300 rounded-lg text-sm">Cancel</button>
              <button onClick={saveRule} disabled={saving} className="flex-1 py-2 bg-slate-800 text-white rounded-lg text-sm disabled:opacity-50">{saving ? "Saving..." : "Save Rule"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Trips Tab ──────────────────────────────────────────────────────────────────
// Manages personal trip exclusion dates used by the Mon-Thu conditional restaurant rule.
// During these date ranges, restaurant charges are classified as Personal instead of Peak 10.
function TripsTab() {
  const [trips, setTrips] = useState<Array<{ id: string; trip_name: string; start_date: string; end_date: string }>>([])
  const [editing, setEditing] = useState<{ id?: string; trip_name: string; start_date: string; end_date: string } | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const res = await (window as any).api.trips.getAll()
    if (res.success) setTrips(res.data)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleSave = async () => {
    if (!editing || !editing.trip_name || !editing.start_date || !editing.end_date) return
    try {
      await (window as any).api.trips.save(editing)
      setEditing(null)
      load()
    } catch (e: any) {
      alert("Failed to save trip: " + (e?.message ?? "unknown error"))
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this trip exclusion?")) return
    try {
      await (window as any).api.trips.delete(id)
      load()
    } catch (e: any) {
      alert("Failed to delete trip: " + (e?.message ?? "unknown error"))
    }
  }

  if (loading) return <p className="text-slate-400 text-sm">Loading trips…</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Personal Trip Exclusion Dates</h2>
          <p className="text-sm text-slate-500 mt-1">
            During these date ranges, restaurant charges on weekdays are classified as <strong>Personal</strong> instead of Peak 10 business meals.
            This prevents the Mon–Thu conditional restaurant rule from auto-classifying meals on personal vacations.
          </p>
        </div>
        <button onClick={() => setEditing({ trip_name: "", start_date: "", end_date: "" })}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 whitespace-nowrap">
          + Add Trip
        </button>
      </div>

      {trips.length === 0 && !editing && (
        <p className="text-slate-400 text-sm py-8 text-center">No personal trip dates configured. Click "Add Trip" to create one.</p>
      )}

      {trips.map(trip => (
        <div key={trip.id} className="flex items-center justify-between bg-white border border-slate-200 rounded-lg p-4 mb-3">
          <div>
            <span className="font-medium text-slate-800">{trip.trip_name}</span>
            <span className="text-slate-500 text-sm ml-3">{trip.start_date} – {trip.end_date}</span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setEditing(trip)}
              className="text-sm text-blue-600 hover:text-blue-800">Edit</button>
            <button onClick={() => handleDelete(trip.id)}
              className="text-sm text-red-500 hover:text-red-700">Delete</button>
          </div>
        </div>
      ))}

      {editing && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-4">
          <h3 className="text-sm font-semibold text-blue-800 mb-3">
            {editing.id ? "Edit Trip" : "New Trip Exclusion"}
          </h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-slate-500">Trip Name</label>
              <input type="text" value={editing.trip_name} placeholder="e.g., NYC Thanksgiving 2025"
                onChange={e => setEditing({ ...editing, trip_name: e.target.value })}
                className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-500">Start Date</label>
              <input type="date" value={editing.start_date}
                onChange={e => setEditing({ ...editing, start_date: e.target.value })}
                className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm" />
            </div>
            <div>
              <label className="text-xs text-slate-500">End Date</label>
              <input type="date" value={editing.end_date}
                onChange={e => setEditing({ ...editing, end_date: e.target.value })}
                className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm" />
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={handleSave}
              disabled={!editing.trip_name || !editing.start_date || !editing.end_date}
              className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-40">
              Save
            </button>
            <button onClick={() => setEditing(null)}
              className="px-4 py-1.5 text-slate-600 text-sm hover:text-slate-800">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sync Tab ───────────────────────────────────────────────────────────────────
function SyncTab() {
  const [logs, setLogs] = useState<any[]>([])
  const [autoSync, setAutoSync] = useState(false)
  const [cron, setCron] = useState("0 2 * * *")
  const [syncFolder, setSyncFolder] = useState("")
  const [plaidConfig, setPlaidConfig] = useState<{ configured: boolean; client_id: string | null; env: string } | null>(null)
  const [plaidForm, setPlaidForm] = useState({ client_id: "", secret: "", env: "development" })
  const [showPlaidForm, setShowPlaidForm] = useState(false)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [savingPlaid, setSavingPlaid] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgType, setMsgType] = useState<"success"|"error">("success")

  const showMsg = (text: string, type: "success"|"error" = "success") => { setMsg(text); setMsgType(type) }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [logResult, scheduleResult, configResult, folder] = await Promise.all([
        window.api.syncLog.list().catch(() => null),
        window.api.plaid.getSchedule().catch(() => null),
        window.api.plaid.getConfig().catch(() => null),
        window.electronAPI?.getSyncFolder?.().catch(() => ""),
      ])
      const logData = logResult?.data ?? logResult ?? []
      setLogs(Array.isArray(logData) ? logData : [])
      if (scheduleResult?.data) { setAutoSync(scheduleResult.data.enabled ?? false); setCron(scheduleResult.data.cron ?? "0 2 * * *") }
      if (configResult?.data) setPlaidConfig(configResult.data)
      setSyncFolder(folder ?? "")
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleSyncNow = async () => {
    setSyncing(true); setMsg(null)
    try {
      const result = await window.api.plaid.syncAll()
      result?.success ? showMsg("Sync complete", "success") : showMsg("Sync failed — " + (result?.error ?? "check connections"), "error")
    } catch { showMsg("Sync failed", "error") }
    await load(); setSyncing(false)
  }

  const handleImport = async () => {
    setImporting(true); setMsg(null)
    try {
      const fileInfo = await window.api.import.selectFile()
      if (!fileInfo) { setImporting(false); return }
      const result = await window.api.import.run(fileInfo)
      const d = result?.data ?? result
      showMsg(`Import complete: ${d?.transactions_new ?? 0} new, ${d?.transactions_duplicate ?? 0} duplicate, ${d?.transactions_queued ?? 0} queued`, "success")
    } catch (e: any) { showMsg("Import error: " + (e?.message ?? "unknown"), "error") }
    setImporting(false); load()
  }

  const savePlaidConfig = async () => {
    if (!plaidForm.client_id || !plaidForm.secret) { showMsg("Client ID and Secret required", "error"); return }
    setSavingPlaid(true)
    try {
      const result = await window.api.plaid.saveConfig(plaidForm)
      result?.success ? (showMsg("Plaid credentials saved", "success"), setShowPlaidForm(false), load()) : showMsg("Save failed: " + (result?.error ?? "unknown"), "error")
    } catch (e: any) { showMsg("Save error: " + (e?.message ?? "unknown"), "error") }
    setSavingPlaid(false)
  }

  if (loading) return <div className="text-slate-500">Loading sync settings...</div>

  return (
    <div className="space-y-6">
      {msg && (
        <div className={`rounded-lg p-3 text-sm flex items-center justify-between ${msgType === "error" ? "bg-red-50 border border-red-200 text-red-700" : "bg-green-50 border border-green-200 text-green-700"}`}>
          {msg}<button onClick={() => setMsg(null)} className="text-current opacity-60 hover:opacity-100 ml-2">✕</button>
        </div>
      )}

      {/* Sync folder */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="font-semibold text-slate-800 mb-2">Sync Folder</h3>
        <div className="flex items-center gap-3 mb-3">
          <code className="text-xs bg-slate-100 px-3 py-2 rounded text-slate-600 flex-1 truncate">{syncFolder || "Not configured"}</code>
          <button onClick={() => window.electronAPI?.selectFolder?.()} className="text-sm text-blue-600 underline whitespace-nowrap">Change</button>
        </div>
        <div className="text-xs text-slate-500 space-y-0.5">
          <p>Watched drop folders (auto-processed in ~5 seconds):</p>
          <p className="font-mono pl-2">…\imports\usaa\ — USAA CSV exports</p>
          <p className="font-mono pl-2">…\imports\apple_card\ — Apple Card CSV exports</p>
        </div>
      </div>

      {/* Plaid config */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-slate-800">Plaid Configuration</h3>
          <button onClick={() => setShowPlaidForm(!showPlaidForm)} className="text-sm text-blue-600 underline">
            {showPlaidForm ? "Cancel" : plaidConfig?.configured ? "Update Credentials" : "Enter Credentials"}
          </button>
        </div>
        {plaidConfig && (
          <div className={`text-sm mb-3 ${plaidConfig.configured ? "text-green-700" : "text-orange-600"}`}>
            {plaidConfig.configured ? `✅ Configured · ${plaidConfig.client_id} · ${plaidConfig.env}` : "⚠️ Not configured — required before connecting accounts"}
          </div>
        )}
        {showPlaidForm && (
          <div className="space-y-3 border-t border-slate-100 pt-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700">
              <p className="font-semibold mb-1">Setup at dashboard.plaid.com</p>
              <p>1. Create free account → Development tier (free, up to 100 items)</p>
              <p>2. Enable: Transactions, Investments</p>
              <p>3. Copy Client ID and Secret</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className="text-xs font-semibold text-slate-500 block mb-1">Client ID</label><input value={plaidForm.client_id} onChange={e => setPlaidForm(f => ({ ...f, client_id: e.target.value }))} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono" placeholder="5f3..." /></div>
              <div className="col-span-2"><label className="text-xs font-semibold text-slate-500 block mb-1">Secret</label><input type="password" value={plaidForm.secret} onChange={e => setPlaidForm(f => ({ ...f, secret: e.target.value }))} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono" /></div>
              <div><label className="text-xs font-semibold text-slate-500 block mb-1">Environment</label><select value={plaidForm.env} onChange={e => setPlaidForm(f => ({ ...f, env: e.target.value }))} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"><option value="sandbox">Sandbox (test)</option><option value="development">Development (live, free)</option><option value="production">Production</option></select></div>
            </div>
            <button onClick={savePlaidConfig} disabled={savingPlaid} className="w-full py-2 bg-slate-800 text-white rounded-lg text-sm disabled:opacity-50">{savingPlaid ? "Saving..." : "Save Plaid Credentials"}</button>
          </div>
        )}
      </div>

      {/* Sync controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="font-semibold text-slate-800 mb-3">Plaid Sync</h3>
        <div className="flex items-center gap-4 mb-3 flex-wrap">
          <button onClick={handleSyncNow} disabled={syncing} className="px-5 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">{syncing ? "Syncing..." : "Sync Now"}</button>
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer"><input type="checkbox" checked={autoSync} onChange={e => setAutoSync(e.target.checked)} className="rounded" />Auto-sync nightly</label>
          {autoSync && <div className="flex items-center gap-2"><input type="text" value={cron} onChange={e => setCron(e.target.value)} className="border border-slate-300 rounded px-2 py-1 text-xs font-mono w-32" /><button onClick={async () => { try { await window.api.plaid.saveSchedule({ enabled: autoSync, cron }) ; showMsg("Schedule saved","success") } catch { showMsg("Failed to save","error") }}} className="text-xs text-blue-600 underline">Save</button><span className="text-xs text-slate-400">0 2 * * * = 2 AM daily</span></div>}
        </div>
      </div>

      {/* Manual import */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="font-semibold text-slate-800 mb-2">Import CSV File</h3>
        <p className="text-sm text-slate-500 mb-3">Monarch Money, USAA, or Apple Card exports. Opens file picker then runs classification engine.</p>
        <button onClick={handleImport} disabled={importing} className="px-5 py-2 bg-slate-700 text-white text-sm rounded-lg hover:bg-slate-800 disabled:opacity-50">{importing ? "Importing..." : "Browse & Import CSV"}</button>
      </div>

      {/* Sync log */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-semibold text-slate-800">Sync Log</h3>
          <button onClick={load} className="text-xs text-blue-600 underline">Refresh</button>
        </div>
        {logs.length === 0
          ? <div className="p-6 text-center text-slate-400 text-sm">No sync history yet</div>
          : <table className="w-full text-xs"><thead className="bg-slate-50 border-b border-slate-100"><tr><th className="text-left px-4 py-2 text-slate-500">Started</th><th className="text-left px-4 py-2 text-slate-500">Type</th><th className="text-right px-4 py-2 text-slate-500">Found</th><th className="text-right px-4 py-2 text-slate-500">New</th><th className="text-right px-4 py-2 text-slate-500">Queued</th><th className="text-left px-4 py-2 text-slate-500">Status</th></tr></thead>
            <tbody className="divide-y divide-slate-50">{logs.slice(0, 50).map((l: any, i: number) => (
              <tr key={i} className="hover:bg-slate-50"><td className="px-4 py-2 text-slate-500">{l.started_at ? new Date(l.started_at).toLocaleString() : "—"}</td><td className="px-4 py-2 text-slate-600">{l.sync_type}</td><td className="px-4 py-2 text-right">{l.transactions_found ?? 0}</td><td className="px-4 py-2 text-right text-green-600">{l.transactions_new ?? 0}</td><td className="px-4 py-2 text-right text-orange-500">{l.transactions_queued ?? 0}</td><td className="px-4 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${l.status === "success" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>{l.status}</span></td></tr>
            ))}</tbody></table>
        }
      </div>
    </div>
  )
}

// ── Notifications Tab ──────────────────────────────────────────────────────────
function NotificationsTab() {
  const [email, setEmail] = useState("")
  const [smtp, setSmtp] = useState({ host: "smtp.gmail.com", port: "587", user: "", pass: "" })
  const [provider, setProvider] = useState<"gmail"|"outlook"|"custom">("gmail")
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgType, setMsgType] = useState<"success"|"error">("success")

  useEffect(() => {
    window.api.db.getSetting("notification_email").catch(() => null).then(r => {
      const v = r?.data ?? r; if (v && typeof v === "string") setEmail(v)
    })
  }, [])

  const applyPreset = (p: typeof provider) => {
    setProvider(p)
    setSmtp(s => ({ ...s, ...({ gmail: { host: "smtp.gmail.com", port: "587" }, outlook: { host: "smtp.office365.com", port: "587" }, custom: {} }[p]) }))
  }

  const save = async () => {
    setSaving(true); setMsg(null)
    try {
      await window.api.db.setSetting("notification_email", email)
      const result = await window.api.email.saveSmtp({ ...smtp, email })
      if (result?.success === false) throw new Error(result.error)
      setMsg("Settings saved"); setMsgType("success")
    } catch (e: any) { setMsg("Error: " + (e?.message ?? "unknown")); setMsgType("error") }
    setSaving(false)
  }

  const sendTest = async () => {
    setTesting(true); setMsg(null)
    try {
      const result = await window.api.email.sendTest()
      if (result?.success === false) throw new Error(result.error)
      setMsg("Test email sent — check your inbox."); setMsgType("success")
    } catch (e: any) { setMsg("Test failed: " + (e?.message ?? "unknown")); setMsgType("error") }
    setTesting(false)
  }

  return (
    <div className="space-y-5 max-w-xl">
      {msg && <div className={`rounded-lg p-3 text-sm flex items-center justify-between ${msgType === "error" ? "bg-red-50 border border-red-200 text-red-700" : "bg-green-50 border border-green-200 text-green-700"}`}>{msg}<button onClick={() => setMsg(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button></div>}

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="font-semibold text-slate-800 mb-4">Notification Email</h3>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="font-semibold text-slate-800 mb-4">SMTP Configuration</h3>
        <div className="flex gap-2 mb-4 flex-wrap">
          {(["gmail","outlook","custom"] as const).map(p => <button key={p} onClick={() => applyPreset(p)} className={`px-3 py-1.5 text-sm rounded-lg border transition-all ${provider === p ? "bg-blue-600 text-white border-blue-600" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>{p === "gmail" ? "Gmail App Password" : p === "outlook" ? "Outlook/365" : "Custom SMTP"}</button>)}
        </div>
        {provider === "gmail" && <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-xs text-blue-700 space-y-0.5"><p className="font-semibold">Gmail App Password:</p><p>Google Account → Security → App Passwords → generate 16-char password</p><p>Use that password below, not your regular Gmail password</p></div>}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><label className="text-xs font-semibold text-slate-500 block mb-1">SMTP Host</label><input value={smtp.host} onChange={e => setSmtp(s => ({ ...s, host: e.target.value }))} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
          <div><label className="text-xs font-semibold text-slate-500 block mb-1">Port</label><input value={smtp.port} onChange={e => setSmtp(s => ({ ...s, port: e.target.value }))} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
          <div><label className="text-xs font-semibold text-slate-500 block mb-1">Username</label><input value={smtp.user} onChange={e => setSmtp(s => ({ ...s, user: e.target.value }))} placeholder="your@email.com" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
          <div className="col-span-2"><label className="text-xs font-semibold text-slate-500 block mb-1">{provider === "gmail" ? "App Password (16 chars)" : "Password"}</label><input type="password" value={smtp.pass} onChange={e => setSmtp(s => ({ ...s, pass: e.target.value }))} placeholder="Stored encrypted in Windows Credential Manager" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
        </div>
      </div>

      <div className="flex gap-3">
        <button onClick={save} disabled={saving} className="flex-1 py-2.5 bg-slate-800 text-white rounded-lg text-sm font-medium hover:bg-slate-900 disabled:opacity-50">{saving ? "Saving..." : "Save Settings"}</button>
        <button onClick={sendTest} disabled={testing} className="px-5 py-2.5 border border-slate-300 rounded-lg text-sm hover:bg-slate-50 disabled:opacity-50">{testing ? "Sending..." : "Send Test Email"}</button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Classification Tab — Claude API key management
// ─────────────────────────────────────────────────────────────────────────────
function AiClassificationTab() {
  const [hasKey, setHasKey] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.api.claude?.hasKey?.().then((res: any) => {
      setHasKey(res?.data === true)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const saveKey = async () => {
    if (!apiKey.trim()) return
    setSaving(true)
    setStatus(null)
    try {
      const res = await window.api.claude.saveKey(apiKey.trim())
      if (res?.success) {
        setHasKey(true)
        setApiKey("")
        setStatus("API key saved successfully. AI suggestions are now enabled in the Review Queue.")
      } else {
        setStatus("Failed to save: " + (res?.error ?? "unknown error"))
      }
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"))
    } finally {
      setSaving(false)
    }
  }

  const removeKey = async () => {
    if (!confirm("Remove Claude API key? AI suggestions will be disabled.")) return
    await window.api.claude.deleteKey()
    setHasKey(false)
    setStatus("API key removed. AI suggestions are disabled.")
  }

  if (loading) return <div className="text-sm text-slate-500">Loading...</div>

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-slate-800 mb-1">AI-Powered Classification</h2>
        <p className="text-sm text-slate-500">
          Uses Claude (Haiku) to suggest bucket and category for unclassified transactions.
          Suggestions appear in the Review Queue with a one-click apply button.
        </p>
      </div>

      <div className={`rounded-lg p-4 border ${hasKey ? 'bg-green-50 border-green-200' : 'bg-slate-50 border-slate-200'}`}>
        <div className="flex items-center gap-2 mb-2">
          <div className={`w-2 h-2 rounded-full ${hasKey ? 'bg-green-500' : 'bg-slate-400'}`} />
          <span className="text-sm font-medium text-slate-700">
            {hasKey ? "Claude API key configured" : "No API key configured"}
          </span>
        </div>
        <p className="text-xs text-slate-500">
          {hasKey
            ? "AI suggestions are active. Your key is stored encrypted via Windows Credential Manager."
            : "Add your Anthropic API key to enable AI classification suggestions."}
        </p>
      </div>

      {!hasKey && (
        <div className="space-y-3">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block">Anthropic API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="sk-ant-api03-..."
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-slate-400">
            Get your API key from console.anthropic.com. Uses Claude Haiku — costs ~$0.001 per suggestion.
          </p>
          <button
            onClick={saveKey}
            disabled={saving || !apiKey.trim()}
            className="px-5 py-2.5 bg-violet-600 text-white rounded-lg text-sm font-medium hover:bg-violet-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save API Key"}
          </button>
        </div>
      )}

      {hasKey && (
        <button
          onClick={removeKey}
          className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm hover:bg-red-50"
        >
          Remove API Key
        </button>
      )}

      {status && (
        <div className={`text-sm p-3 rounded-lg ${status.includes('Error') || status.includes('Failed') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
          {status}
        </div>
      )}

      <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">How it works</h3>
        <ul className="text-xs text-slate-500 space-y-1 list-disc list-inside">
          <li>When you expand a transaction in the Review Queue, click "Ask AI for suggestion"</li>
          <li>Or use "AI Suggest (10)" to get suggestions for the first 10 visible transactions</li>
          <li>Claude analyzes the merchant, amount, date, and your recent classification history</li>
          <li>Click "Apply" to pre-fill the bucket and category, then confirm as usual</li>
          <li>High-confidence suggestions ({">"}70%) are highlighted in purple; lower ones in amber</li>
          <li>Creating a rule after accepting a suggestion prevents future AI calls for that merchant</li>
        </ul>
      </div>

      {/* ── Ollama Local AI ──────────────────────────────────────────────────── */}
      <OllamaSection />
    </div>
  )
}

function OllamaSection() {
  const [config, setConfig] = useState<{ enabled: boolean; model: string }>({ enabled: false, model: 'mistral' })
  const [models, setModels] = useState<string[]>([])
  const [connected, setConnected] = useState<boolean | null>(null)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    window.api.ollama?.getConfig?.().then((res: any) => {
      if (res) setConfig({ enabled: res.enabled ?? false, model: res.model ?? 'mistral' })
    }).catch(() => {})
  }, [])

  const testConnection = async () => {
    setTesting(true)
    setStatus(null)
    try {
      const result = await window.api.ollama.testConnection()
      setConnected(result.connected)
      setModels(result.models ?? [])
      if (result.connected) {
        setStatus(`Connected. ${result.models.length} model${result.models.length !== 1 ? 's' : ''} available.`)
      } else {
        setStatus(`Not connected: ${result.error ?? 'unknown'}. Make sure Ollama is running (ollama serve).`)
      }
    } catch (e: any) {
      setConnected(false)
      setStatus("Connection failed: " + (e?.message ?? "unknown"))
    } finally {
      setTesting(false)
    }
  }

  const toggleEnabled = async () => {
    const newEnabled = !config.enabled
    await window.api.ollama.setConfig({ enabled: newEnabled })
    setConfig(prev => ({ ...prev, enabled: newEnabled }))
  }

  const changeModel = async (model: string) => {
    await window.api.ollama.setConfig({ model })
    setConfig(prev => ({ ...prev, model }))
  }

  return (
    <div className="border-t border-slate-200 pt-6 mt-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-800 mb-1">Ollama — Local AI (Free)</h2>
        <p className="text-sm text-slate-500">
          Runs entirely on your machine. No cloud, no API costs. Learns patterns from your classification history
          including which card, amount ranges, day of week, and location signals.
        </p>
      </div>

      {/* Connection status */}
      <div className={`rounded-lg p-4 border ${connected === true ? 'bg-green-50 border-green-200' : connected === false ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-200'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${connected === true ? 'bg-green-500' : connected === false ? 'bg-red-500' : 'bg-slate-400'}`} />
            <span className="text-sm font-medium text-slate-700">
              {connected === true ? "Ollama connected" : connected === false ? "Not connected" : "Not tested"}
            </span>
          </div>
          <button onClick={testConnection} disabled={testing}
            className="px-3 py-1.5 bg-slate-700 text-white text-xs rounded-lg hover:bg-slate-800 disabled:opacity-50">
            {testing ? "Testing..." : "Test Connection"}
          </button>
        </div>
        {status && <p className="text-xs text-slate-500 mt-2">{status}</p>}
      </div>

      {/* Enable/disable toggle */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-medium text-slate-700">Enable Ollama AI</span>
          <p className="text-xs text-slate-400">When enabled, the learning engine uses Ollama for multi-factor analysis</p>
        </div>
        <button onClick={toggleEnabled}
          className={`relative w-11 h-6 rounded-full transition-colors ${config.enabled ? 'bg-green-500' : 'bg-slate-300'}`}>
          <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${config.enabled ? 'translate-x-5.5 left-0.5' : 'left-0.5'}`}
            style={{ transform: config.enabled ? 'translateX(22px)' : 'translateX(2px)' }} />
        </button>
      </div>

      {/* Model selector */}
      <div>
        <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">Model</label>
        {models.length > 0 ? (
          <select value={config.model} onChange={e => changeModel(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input type="text" value={config.model} onChange={e => changeModel(e.target.value)}
            placeholder="mistral"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
        )}
        <p className="text-xs text-slate-400 mt-1">
          Recommended: mistral (7B, fast) or llama3 (8B, more accurate). Install with: ollama pull mistral
        </p>
      </div>

      {/* How it works */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">How Ollama learns</h3>
        <ul className="text-xs text-slate-500 space-y-1 list-disc list-inside">
          <li>Every manual classification is stored as training context</li>
          <li>When a contradiction is detected, Ollama considers card, amount, day of week, and history</li>
          <li>Only flags transactions as ambiguous when the LLM agrees it's a real conflict</li>
          <li>Over time, fewer false-positive contradictions as it learns your patterns</li>
          <li>Runs on your local machine — no data leaves your computer</li>
        </ul>
      </div>

      {/* Setup instructions */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-blue-800 mb-2">Quick Setup</h3>
        <ol className="text-xs text-blue-700 space-y-1 list-decimal list-inside">
          <li>Download Ollama from <span className="font-mono">ollama.com</span></li>
          <li>Run installer, then open a terminal and run: <span className="font-mono">ollama pull mistral</span></li>
          <li>Ollama runs in the background automatically</li>
          <li>Click "Test Connection" above, then enable</li>
        </ol>
      </div>
    </div>
  )
}
