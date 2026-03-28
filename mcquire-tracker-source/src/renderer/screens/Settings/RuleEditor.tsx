import { useEffect, useState, useCallback } from "react"
import { P10_CATEGORIES, LLC_CATEGORIES } from "../../../shared/types"

function unwrap<T>(res: any, fallback: T): T {
  if (res === null || res === undefined) return fallback
  if (typeof res === "object" && "data" in res) return (res.data as T) ?? fallback
  return (res as T) ?? fallback
}

const SECTION_COLORS: Record<string, string> = {
  llc_always: "badge-llc", p10_always: "badge-p10", p10_conditional: "badge-p10",
  personal_override: "badge-personal", special: "bg-purple-100 text-purple-800",
  ask_kyle: "badge-pending", exclusion: "bg-gray-200 text-gray-500"
}

const EMPTY_RULE = {
  rule_name: "", section: "p10_always", match_type: "contains", match_value: "",
  account_mask_filter: "", amount_min: "", amount_max: "",
  day_of_week_filter: "", date_from_filter: "", date_to_filter: "",
  bucket: "", p10_category: "", llc_category: "", description_notes: "",
  flag_reason: "", action: "classify", priority_order: "",
  is_active: 1, notes: ""
}

export default function RuleEditor() {
  const [rules, setRules] = useState<any[]>([])
  const [search, setSearch] = useState("")
  const [sectionFilter, setSectionFilter] = useState("")
  const [editing, setEditing] = useState<any | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const [tripDates, setTripDates] = useState<any[]>([])
  const [newTrip, setNewTrip] = useState({ trip_name: "", date_from: "", date_to: "" })

  const load = useCallback(() => {
    window.api.rules.getAll().then((res: any) => setRules(unwrap<any[]>(res, [])))
    window.api.trips.getAll().then((res: any) => setTripDates(unwrap<any[]>(res, [])))
  }, [])
  useEffect(() => { load() }, [load])

  const filtered = rules.filter(r => {
    if (!showInactive && !r.is_active) return false
    if (sectionFilter && r.section !== sectionFilter) return false
    if (search && !r.rule_name.toLowerCase().includes(search.toLowerCase()) && !r.match_value.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const openNew = () => { setEditing({ ...EMPTY_RULE }); setIsNew(true); setTestResult(null) }
  const openEdit = (r: any) => { setEditing({ ...r, amount_min: r.amount_min ?? "", amount_max: r.amount_max ?? "" }); setIsNew(false); setTestResult(null) }

  const handleSave = async () => {
    if (!editing) return
    setSaving(true)
    const payload = {
      ...editing,
      amount_min: editing.amount_min !== "" ? parseFloat(editing.amount_min) : null,
      amount_max: editing.amount_max !== "" ? parseFloat(editing.amount_max) : null,
      priority_order: parseInt(editing.priority_order, 10),
      account_mask_filter: editing.account_mask_filter || null,
      day_of_week_filter: editing.day_of_week_filter || null,
      date_from_filter: editing.date_from_filter || null,
      date_to_filter: editing.date_to_filter || null,
      flag_reason: editing.flag_reason || null,
      description_notes: editing.description_notes || null,
      notes: editing.notes || null,
    }
    const rulePayload = isNew ? payload : { ...payload, id: editing.id }
    await window.api.rules.save(rulePayload)
    setSaving(false)
    setEditing(null)
    load()
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Disable this rule? (It will no longer apply to new transactions, but existing classified transactions are unchanged.)")) return
    await window.api.rules.delete(id)
    load()
  }

  const handleTest = async () => {
    // Test rule match is not yet implemented in IPC — show placeholder
    setTestResult({ matches: 0, examples: [], note: "Test feature coming soon" })
  }

  const addTrip = async () => {
    await window.api.trips.save({ trip_name: newTrip.trip_name, start_date: newTrip.date_from, end_date: newTrip.date_to })
    setNewTrip({ trip_name: "", date_from: "", date_to: "" })
    load()
  }

  const deleteTrip = async (id: string) => {
    await window.api.trips.delete(id)
    load()
  }

  return (
    <div className="max-w-5xl">
      {/* Filters */}
      <div className="flex gap-3 mb-4 items-center">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search rules..." className="border rounded-lg px-3 py-2 text-sm flex-1" />
        <select value={sectionFilter} onChange={e => setSectionFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
          <option value="">All sections</option>
          <option value="exclusion">Exclusion</option>
          <option value="llc_always">LLC Always</option>
          <option value="p10_always">P10 Always</option>
          <option value="p10_conditional">P10 Conditional</option>
          <option value="personal_override">Personal Override</option>
          <option value="special">Special</option>
          <option value="ask_kyle">Ask Kyle</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-500 cursor-pointer">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Show disabled
        </label>
        <button onClick={openNew} className="btn btn-primary text-sm">+ New Rule</button>
      </div>

      <div className="text-xs text-gray-400 mb-3">{filtered.length} rules shown</div>

      {/* Rules table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-sm mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-navy text-white">
              {["Priority","Section","Vendor Match","Account","Bucket","Category","Action",""].map(h => (
                <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={r.id} className={`border-b border-gray-50 ${i % 2 === 0 ? "bg-white" : "bg-slate-50/50"} ${!r.is_active ? "opacity-40" : ""}`}>
                <td className="px-3 py-2 font-mono text-xs text-gray-500">{r.priority_order}</td>
                <td className="px-3 py-2"><span className={`badge ${SECTION_COLORS[r.section] ?? "badge-personal"}`}>{r.section}</span></td>
                <td className="px-3 py-2">
                  <div className="font-medium text-gray-800 text-xs">{r.rule_name}</div>
                  <div className="text-gray-400 text-xs font-mono">{r.match_type}: {r.match_value}</div>
                </td>
                <td className="px-3 py-2 text-gray-500 text-xs">{r.account_mask_filter ?? "any"}</td>
                <td className="px-3 py-2">
                  {r.bucket && <span className={`badge ${r.bucket === "Peak 10" ? "badge-p10" : r.bucket === "Moonsmoke LLC" ? "badge-llc" : "badge-personal"}`}>{r.bucket}</span>}
                </td>
                <td className="px-3 py-2 text-gray-500 text-xs">{r.p10_category ?? r.llc_category ?? ""}</td>
                <td className="px-3 py-2"><span className={`badge ${r.action === "ask_kyle" ? "badge-pending" : r.action === "split_flag" ? "badge-flagged" : r.action === "exclude" ? "bg-gray-200 text-gray-500" : "badge-classified"}`}>{r.action}</span></td>
                <td className="px-3 py-2">
                  <div className="flex gap-2">
                    <button onClick={() => openEdit(r)} className="text-xs text-blue-600 hover:underline">Edit</button>
                    <button onClick={() => handleDelete(r.id)} className="text-xs text-red-400 hover:underline">Disable</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Personal Trip Dates */}
      <div className="card mb-6">
        <h3 className="font-bold text-gray-700 mb-1">🏖️ Personal Trip Date Exclusions</h3>
        <p className="text-xs text-gray-400 mb-3">Transactions on these dates are excluded from the Mon–Thu restaurant rule (≥$95 → Peak 10).</p>
        <div className="space-y-2 mb-3">
          {tripDates.map(t => (
            <div key={t.id} className="flex items-center justify-between text-sm bg-slate-50 rounded px-3 py-2">
              <span className="font-medium">{t.trip_name}</span>
              <span className="text-gray-500">{t.start_date ?? t.date_from} → {t.end_date ?? t.date_to}</span>
              <button onClick={() => deleteTrip(t.id)} className="text-red-400 text-xs hover:underline">Remove</button>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-2">
          <input value={newTrip.trip_name} onChange={e => setNewTrip({ ...newTrip, trip_name: e.target.value })} placeholder="Trip name" className="border rounded px-2 py-1.5 text-sm" />
          <input type="date" value={newTrip.date_from} onChange={e => setNewTrip({ ...newTrip, date_from: e.target.value })} className="border rounded px-2 py-1.5 text-sm" />
          <input type="date" value={newTrip.date_to} onChange={e => setNewTrip({ ...newTrip, date_to: e.target.value })} className="border rounded px-2 py-1.5 text-sm" />
          <button onClick={addTrip} className="btn btn-secondary text-sm">Add Trip</button>
        </div>
      </div>

      {/* Edit/New drawer */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-end z-50">
          <div className="bg-white h-full w-full max-w-xl shadow-2xl flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b bg-navy text-white flex items-center justify-between">
              <div className="font-semibold">{isNew ? "New Rule" : "Edit Rule"}</div>
              <button onClick={() => setEditing(null)} className="text-blue-200 hover:text-white text-xl">✕</button>
            </div>
            <div className="flex-1 overflow-auto p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="text-xs text-gray-500 block mb-1">Rule Name</label>
                  <input value={editing.rule_name} onChange={e => setEditing({ ...editing, rule_name: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Section</label>
                  <select value={editing.section} onChange={e => setEditing({ ...editing, section: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm">
                    <option value="exclusion">Exclusion</option>
                    <option value="llc_always">LLC Always</option>
                    <option value="p10_always">P10 Always</option>
                    <option value="p10_conditional">P10 Conditional</option>
                    <option value="personal_override">Personal Override</option>
                    <option value="special">Special</option>
                    <option value="ask_kyle">Ask Kyle</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Priority (lower = higher priority)</label>
                  <input type="number" value={editing.priority_order} onChange={e => setEditing({ ...editing, priority_order: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Match Type</label>
                  <select value={editing.match_type} onChange={e => setEditing({ ...editing, match_type: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm">
                    <option value="contains">Contains</option><option value="exact">Exact</option>
                    <option value="starts_with">Starts With</option><option value="regex">Regex</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Match Value (lowercase)</label>
                  <input value={editing.match_value} onChange={e => setEditing({ ...editing, match_value: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Account Mask Filter</label>
                  <input value={editing.account_mask_filter} onChange={e => setEditing({ ...editing, account_mask_filter: e.target.value })} placeholder="e.g. 5829 (or blank for any)" className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Action</label>
                  <select value={editing.action} onChange={e => setEditing({ ...editing, action: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm">
                    <option value="classify">Classify</option>
                    <option value="ask_kyle">Ask Kyle</option>
                    <option value="exclude">Exclude</option>
                    <option value="split_flag">Split Flag</option>
                  </select>
                </div>
                {editing.action === "classify" && <>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Bucket</label>
                    <select value={editing.bucket} onChange={e => setEditing({ ...editing, bucket: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm">
                      <option value="">—</option>
                      <option>Peak 10</option><option>Moonsmoke LLC</option><option>Personal</option><option>Exclude</option>
                    </select>
                  </div>
                  {editing.bucket === "Peak 10" && (
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">P10 Category</label>
                      <select value={editing.p10_category} onChange={e => setEditing({ ...editing, p10_category: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm">
                        <option value="">Select...</option>
                        {P10_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                      </select>
                    </div>
                  )}
                  {editing.bucket === "Moonsmoke LLC" && (
                    <div>
                      <label className="text-xs text-gray-500 block mb-1">LLC Category</label>
                      <select value={editing.llc_category} onChange={e => setEditing({ ...editing, llc_category: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm">
                        <option value="">Select...</option>
                        {LLC_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                      </select>
                    </div>
                  )}
                </>}
                <div className="col-span-2">
                  <label className="text-xs text-gray-500 block mb-1">Description / Notes (pre-filled on expense report)</label>
                  <input value={editing.description_notes} onChange={e => setEditing({ ...editing, description_notes: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div className="col-span-2">
                  <label className="text-xs text-gray-500 block mb-1">Flag Reason (if set, transaction is flagged after classification)</label>
                  <input value={editing.flag_reason} onChange={e => setEditing({ ...editing, flag_reason: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Amount Min ($)</label>
                  <input type="number" value={editing.amount_min} onChange={e => setEditing({ ...editing, amount_min: e.target.value })} placeholder="blank = no limit" className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Amount Max ($)</label>
                  <input type="number" value={editing.amount_max} onChange={e => setEditing({ ...editing, amount_max: e.target.value })} placeholder="blank = no limit" className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Date From</label>
                  <input type="date" value={editing.date_from_filter} onChange={e => setEditing({ ...editing, date_from_filter: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Date To</label>
                  <input type="date" value={editing.date_to_filter} onChange={e => setEditing({ ...editing, date_to_filter: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Day of Week (Mon–Thu = 1,2,3,4)</label>
                  <input value={editing.day_of_week_filter} onChange={e => setEditing({ ...editing, day_of_week_filter: e.target.value })} placeholder="e.g. 1,2,3,4" className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <label className="text-sm text-gray-600 cursor-pointer flex items-center gap-2">
                    <input type="checkbox" checked={!!editing.is_active} onChange={e => setEditing({ ...editing, is_active: e.target.checked ? 1 : 0 })} />
                    Active
                  </label>
                </div>
                <div className="col-span-2">
                  <label className="text-xs text-gray-500 block mb-1">Internal Notes</label>
                  <textarea value={editing.notes} onChange={e => setEditing({ ...editing, notes: e.target.value })} rows={2} className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>

              {/* Test rule */}
              <div className="border-t pt-4">
                <button onClick={handleTest} className="btn btn-secondary text-sm mb-2">🧪 Test Against History</button>
                {testResult && (
                  <div className="text-sm">
                    <div className="font-semibold text-gray-700 mb-1">
                      {testResult.note ?? <>This rule would match <span className="text-brand-blue">{testResult.matches}</span> existing transactions</>}
                    </div>
                    {(testResult.examples ?? []).map((ex: any, i: number) => (
                      <div key={i} className="text-xs text-gray-500 px-2 py-1 bg-slate-50 rounded mb-1">
                        {ex.date} · {ex.merchant} · ${Math.abs(ex.amount).toFixed(2)} · currently: {ex.current_bucket ?? "unclassified"}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="p-5 border-t flex gap-2">
              <button onClick={() => setEditing(null)} className="btn btn-secondary flex-1">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="btn btn-primary flex-1">{saving ? "Saving..." : "Save Rule"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
