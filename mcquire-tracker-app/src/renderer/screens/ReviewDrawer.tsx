import { useState, useEffect } from "react"
import { P10_CATEGORIES, LLC_CATEGORIES } from "../../shared/types"
import type { RuleMatchType } from "../../shared/types"

/* ── Helpers ───────────────────────────────────────────────────────────────── */

const BUCKETS = ["Peak 10", "Moonsmoke LLC", "Watersound Investments LLC", "Personal", "Exclude"] as const

const bucketKeys: Record<string, string> = {
  "1": "Peak 10", "2": "Moonsmoke LLC", "3": "Watersound Investments LLC",
  "4": "Personal", "5": "Exclude",
}

const bucketShortLabel: Record<string, string> = {
  "Peak 10": "P10", "Moonsmoke LLC": "LLC", "Watersound Investments LLC": "WS",
  Personal: "PERS", Exclude: "EXCL",
}

const bucketBtnColor: Record<string, string> = {
  "Peak 10":                   "bg-blue-600 text-white hover:bg-blue-700",
  "Moonsmoke LLC":             "bg-green-600 text-white hover:bg-green-700",
  "Watersound Investments LLC":"bg-purple-600 text-white hover:bg-purple-700",
  Personal:                    "bg-slate-600 text-white hover:bg-slate-700",
  Exclude:                     "bg-red-600 text-white hover:bg-red-700",
}

const bucketBtnInactive = "bg-slate-100 text-slate-600 hover:bg-slate-200"

const fmt = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (s: string) => {
  if (!s) return ""
  const d = new Date(s + "T00:00:00")
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/* ── Note Suggestions Hook ─────────────────────────────────────────────────── */

function useNoteSuggestions(category: string | undefined, merchant: string | undefined) {
  const [suggestions, setSuggestions] = useState<Array<{ note: string; use_count: number }>>([])

  useEffect(() => {
    if (!category && !merchant) { setSuggestions([]); return }
    window.api?.transactions?.getRecentNotes?.({ category, merchant })
      .then((res: any) => {
        const data = res?.data ?? res ?? []
        setSuggestions(Array.isArray(data) ? data : [])
      })
      .catch(() => {})
  }, [category, merchant])

  return suggestions
}

/* ── Side Drawer ────────────────────────────────────────────────────────────── */

interface DrawerProps {
  tx: any
  mode: "split" | "att" | "rule"
  onClose: () => void
  onSplitConfirm: (parentId: string, fragments: any[]) => Promise<void>
  onRuleSave: (tx: any, cs: any) => Promise<void>
  classifyState: any
}

function SideDrawer({ tx, mode, onClose, onSplitConfirm, onRuleSave, classifyState }: DrawerProps) {
  const [splitA1, setSplitA1] = useState("")
  const [splitA2, setSplitA2] = useState("")
  const [splitBucket1, setSplitBucket1] = useState(classifyState?.bucket ?? "Peak 10")
  const [splitBucket2, setSplitBucket2] = useState("Personal")
  const [splitCat1, setSplitCat1] = useState("")
  const [splitCat2, setSplitCat2] = useState("")
  const [splitNotes1, setSplitNotes1] = useState("")
  const [splitNotes2, setSplitNotes2] = useState("")
  const [attAmount, setAttAmount] = useState("")
  const [saving, setSaving] = useState(false)

  // Rule creation state
  const [ruleMatchType, setRuleMatchType] = useState<RuleMatchType>("contains")
  const [ruleMatchValue, setRuleMatchValue] = useState(() => {
    const m = (tx.merchant_name ?? tx.description_raw ?? "").toLowerCase().trim()
    return m.replace(/^tst\*\s*/i, '').replace(/^sq\s+\*\s*/i, '').replace(/\s+#\d+$/, '').replace(/\s+\d{4,}$/, '').trim()
  })
  const [ruleAccountFilter, setRuleAccountFilter] = useState("")

  const handleSplit = async () => {
    const a1 = parseFloat(splitA1), a2 = parseFloat(splitA2)
    if (isNaN(a1) || isNaN(a2)) { alert("Enter valid amounts"); return }
    setSaving(true)
    try {
      await onSplitConfirm(tx.id, [
        { amount: a1, bucket: splitBucket1, p10_category: splitBucket1 === "Peak 10" ? splitCat1 : undefined, llc_category: splitBucket1 === "Moonsmoke LLC" ? splitCat1 : undefined, description_notes: splitNotes1 },
        { amount: a2, bucket: splitBucket2, p10_category: splitBucket2 === "Peak 10" ? splitCat2 : undefined, llc_category: splitBucket2 === "Moonsmoke LLC" ? splitCat2 : undefined, description_notes: splitNotes2 },
      ])
      onClose()
    } catch (e: any) { alert("Split error: " + (e?.message ?? "unknown")) }
    finally { setSaving(false) }
  }

  const handleAttSplit = async () => {
    const p10 = parseFloat(attAmount)
    if (isNaN(p10) || p10 <= 0 || p10 >= Math.abs(tx.amount)) { alert("Enter a valid P10 line cost"); return }
    setSaving(true)
    try {
      await onSplitConfirm(tx.id, [
        { amount: p10, bucket: "Peak 10", p10_category: "Telephone & Communication", description_notes: "AT&T line 832-687-0468 — Peak 10" },
        { amount: Math.abs(tx.amount) - p10, bucket: "Personal", description_notes: "AT&T personal lines — remainder" },
      ])
      onClose()
    } catch (e: any) { alert("Split error: " + (e?.message ?? "unknown")) }
    finally { setSaving(false) }
  }

  const handleRuleSave = async () => {
    const cs = classifyState ?? {}
    const bucket = cs.bucket
    if (!bucket || bucket === "Exclude") return

    let section: string, priorityBase: number
    switch (bucket) {
      case "Peak 10": section = "p10_always"; priorityBase = 390; break
      case "Moonsmoke LLC": section = "llc_always"; priorityBase = 290; break
      default: section = "personal_override"; priorityBase = 590
    }

    setSaving(true)
    try {
      await onRuleSave(tx, {
        rule_name: `${tx.merchant_name ?? tx.description_raw} — ${bucket}`,
        section, match_type: ruleMatchType, match_value: ruleMatchValue.toLowerCase(),
        account_mask_filter: ruleAccountFilter || null,
        bucket, p10_category: bucket === "Peak 10" ? (cs.category ?? "") : null,
        llc_category: bucket === "Moonsmoke LLC" ? (cs.category ?? "") : null,
        description_notes: cs.notes ?? "", action: "classify",
        priority_order: priorityBase, is_active: 1,
      })
      onClose()
    } catch (e: any) { alert("Rule save error: " + (e?.message ?? "unknown")) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-[420px] bg-white shadow-2xl overflow-y-auto animate-slide-in">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">
            {mode === "att" ? "AT&T Bill Split" : mode === "split" ? "Split Transaction" : "Create Rule"}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">&times;</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Transaction summary */}
          <div className="bg-slate-50 rounded-lg p-3 text-sm">
            <div className="font-semibold text-slate-800">{tx.merchant_name || tx.description_raw}</div>
            <div className="text-slate-500">{fmtDate(tx.transaction_date)} &middot; {fmt(tx.amount)} &middot; ···{tx.account_mask ?? ""}</div>
          </div>

          {/* ── AT&T Split ──────────────────────────────────────────────── */}
          {mode === "att" && (
            <>
              <p className="text-sm text-slate-600">Enter the cost for Peak 10 business line <strong>832-687-0468</strong>. The remainder classifies as Personal.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-500 block mb-1">P10 amount</label>
                  <input type="number" step="0.01" value={attAmount} onChange={e => setAttAmount(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" placeholder="0.00" />
                </div>
                <div>
                  <label className="text-xs text-slate-500 block mb-1">Personal (auto)</label>
                  <div className="border border-slate-200 bg-slate-50 rounded-lg px-3 py-2 text-sm text-slate-600 font-medium">
                    {attAmount && !isNaN(parseFloat(attAmount)) ? fmt(Math.abs(tx.amount) - parseFloat(attAmount)) : "—"}
                  </div>
                </div>
              </div>
              <button onClick={handleAttSplit} disabled={saving || !attAmount}
                className="w-full py-2.5 bg-orange-600 text-white text-sm font-medium rounded-lg hover:bg-orange-700 disabled:opacity-50">
                {saving ? "Splitting..." : "Confirm AT&T Split"}
              </button>
            </>
          )}

          {/* ── General Split ───────────────────────────────────────────── */}
          {mode === "split" && (
            <>
              <p className="text-xs text-slate-500">Total: {fmt(tx.amount)}. Split into two fragments.</p>
              {[0, 1].map(i => (
                <div key={i} className="bg-slate-50 rounded-lg p-3 space-y-2">
                  <div className="text-xs font-semibold text-slate-500">Fragment {i + 1}</div>
                  <input type="number" step="0.01" placeholder="Amount"
                    value={i === 0 ? splitA1 : splitA2}
                    onChange={e => i === 0 ? setSplitA1(e.target.value) : setSplitA2(e.target.value)}
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
                  <select value={i === 0 ? splitBucket1 : splitBucket2}
                    onChange={e => i === 0 ? setSplitBucket1(e.target.value) : setSplitBucket2(e.target.value)}
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm">
                    {BUCKETS.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                  {(i === 0 ? splitBucket1 : splitBucket2) === "Peak 10" && (
                    <select value={i === 0 ? splitCat1 : splitCat2}
                      onChange={e => i === 0 ? setSplitCat1(e.target.value) : setSplitCat2(e.target.value)}
                      className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm">
                      <option value="">— Category —</option>
                      {P10_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  )}
                  {(i === 0 ? splitBucket1 : splitBucket2) === "Moonsmoke LLC" && (
                    <select value={i === 0 ? splitCat1 : splitCat2}
                      onChange={e => i === 0 ? setSplitCat1(e.target.value) : setSplitCat2(e.target.value)}
                      className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm">
                      <option value="">— Category —</option>
                      {LLC_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  )}
                  <input type="text" placeholder="Notes (optional)"
                    value={i === 0 ? splitNotes1 : splitNotes2}
                    onChange={e => i === 0 ? setSplitNotes1(e.target.value) : setSplitNotes2(e.target.value)}
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
                </div>
              ))}
              <button onClick={handleSplit} disabled={saving}
                className="w-full py-2.5 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-900 disabled:opacity-50">
                {saving ? "Splitting..." : "Confirm Split"}
              </button>
            </>
          )}

          {/* ── Rule Creation ───────────────────────────────────────────── */}
          {mode === "rule" && (
            <>
              <p className="text-sm text-slate-600">Create a rule so future transactions matching this merchant are auto-classified.</p>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-500 block mb-1">Match type</label>
                  <select value={ruleMatchType} onChange={e => setRuleMatchType(e.target.value as RuleMatchType)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
                    <option value="contains">contains</option>
                    <option value="exact">exact</option>
                    <option value="starts_with">starts with</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-500 block mb-1">Match value</label>
                  <input type="text" value={ruleMatchValue} onChange={e => setRuleMatchValue(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-slate-500 block mb-1">Account filter (optional)</label>
                  <input type="text" value={ruleAccountFilter} onChange={e => setRuleAccountFilter(e.target.value)}
                    placeholder={tx.account_mask ? `e.g. ${tx.account_mask}` : "any"}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                </div>
                <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-600 font-mono">
                  if merchant {ruleMatchType === "exact" ? "==" : ruleMatchType === "starts_with" ? "starts with" : "contains"} "{ruleMatchValue}" → {classifyState?.bucket ?? "?"}
                  {classifyState?.category ? ` → ${classifyState.category}` : ""}
                </div>
              </div>
              <button onClick={handleRuleSave} disabled={saving || !classifyState?.bucket || classifyState?.bucket === "Exclude"}
                className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {saving ? "Saving..." : "Create Rule"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export { SideDrawer, useNoteSuggestions, BUCKETS, bucketKeys, bucketShortLabel, bucketBtnColor, bucketBtnInactive, fmt, fmtDate }
