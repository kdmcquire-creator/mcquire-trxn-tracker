import { useEffect, useState, useCallback, useRef } from "react"
import { P10_CATEGORIES, LLC_CATEGORIES } from "../../shared/types"
import {
  SideDrawer, useNoteSuggestions,
  BUCKETS, bucketKeys, bucketShortLabel, bucketBtnColor, bucketBtnInactive,
  fmt, fmtDate,
} from "./ReviewDrawer"

function unwrap<T>(res: any, fallback: T): T {
  if (res === null || res === undefined) return fallback
  if (typeof res === "object" && "data" in res) return (res.data as T) ?? fallback
  return (res as T) ?? fallback
}

/* ── Bucket colors for badges ──────────────────────────────────────────────── */
const bucketBadge: Record<string, string> = {
  "Peak 10": "bg-blue-100 text-blue-800",
  "Moonsmoke LLC": "bg-green-100 text-green-800",
  "Watersound Investments LLC": "bg-purple-100 text-purple-800",
  Personal: "bg-gray-100 text-gray-700",
  Exclude: "bg-red-100 text-red-700",
}

const statusBorder: Record<string, string> = {
  pending_review: "border-l-orange-400",
  flagged: "border-l-red-500",
  ask_kyle: "border-l-orange-400",
  auto_classified: "border-l-green-400",
}

/* ── Per-row classify state ────────────────────────────────────────────────── */
interface ClassifyState {
  bucket?: string
  category?: string
  notes?: string
  showCategory?: boolean   // expanded inline for P10/LLC/WS
}

interface Props {
  onPendingChange?: (count: number) => void
}

export default function ReviewQueue({ onPendingChange }: Props) {
  const [transactions, setTransactions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filterStatus, setFilterStatus] = useState<"all" | "pending_review" | "flagged">("all")
  const [focusIdx, setFocusIdx] = useState(0)
  const [classifyState, setClassifyState] = useState<Record<string, ClassifyState>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [animatingOut, setAnimatingOut] = useState<Set<string>>(new Set())

  // Side drawer
  const [drawer, setDrawer] = useState<{ tx: any; mode: "split" | "att" | "rule" } | null>(null)

  // AI suggestions
  const [aiEnabled, setAiEnabled] = useState(false)
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, any>>({})
  const [aiLoading, setAiLoading] = useState<Record<string, boolean>>({})
  const [aiBatchLoading, setAiBatchLoading] = useState(false)

  // Batch classify
  const [batchBucket, setBatchBucket] = useState<string | null>(null)

  const listRef = useRef<HTMLDivElement>(null)

  /* ── Data loading ────────────────────────────────────────────────────────── */
  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const raw = await window.api.transactions.getPending().catch(() => [])
      const arr = unwrap<any[]>(raw, [])
      setTransactions(arr)
      onPendingChange?.(arr.length)
    } catch (e: any) {
      setError("Failed to load: " + (e?.message ?? "unknown"))
    } finally { setLoading(false) }
  }, [onPendingChange])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    window.api.claude?.hasKey?.().then((res: any) => {
      setAiEnabled(res?.data === true)
    }).catch(() => {})
  }, [])

  /* ── Filtered list ───────────────────────────────────────────────────────── */
  const visible = transactions.filter(t =>
    filterStatus === "all" ? true : t.review_status === filterStatus
  )

  /* ── State helpers ───────────────────────────────────────────────────────── */
  const getCs = (id: string): ClassifyState => classifyState[id] ?? {}
  const setCs = (id: string, patch: Partial<ClassifyState>) =>
    setClassifyState(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }))

  /* ── Classify a single transaction ───────────────────────────────────────── */
  const handleClassify = useCallback(async (tx: any, bucket: string, category?: string, notes?: string) => {
    setSaving(prev => ({ ...prev, [tx.id]: true }))
    try {
      const update: any = {
        bucket,
        review_status: "manually_classified",
        description_notes: notes ?? getCs(tx.id).notes ?? tx.description_notes ?? "",
      }
      if (bucket === "Peak 10") update.p10_category = category ?? getCs(tx.id).category ?? ""
      if (bucket === "Moonsmoke LLC") update.llc_category = category ?? getCs(tx.id).category ?? ""
      await window.api.transactions.classify(tx.id, update)

      // Animate out then remove
      setAnimatingOut(prev => new Set(prev).add(tx.id))
      setTimeout(() => {
        setTransactions(prev => prev.filter(t => t.id !== tx.id))
        setAnimatingOut(prev => { const n = new Set(prev); n.delete(tx.id); return n })
        onPendingChange?.(transactions.length - 1)
      }, 300)
    } catch (e: any) {
      alert("Error: " + (e?.message ?? "unknown"))
    } finally {
      setSaving(prev => ({ ...prev, [tx.id]: false }))
    }
  }, [classifyState, transactions.length, onPendingChange])

  /* ── Handle bucket button click ──────────────────────────────────────────── */
  const handleBucketClick = useCallback((tx: any, bucket: string) => {
    // Personal and Exclude: instant 1-click save
    if (bucket === "Personal" || bucket === "Exclude") {
      handleClassify(tx, bucket)
      return
    }
    // P10, LLC, Watersound: expand inline for category + notes
    setCs(tx.id, { bucket, showCategory: true, category: "", notes: "" })
  }, [handleClassify])

  /* ── Confirm expanded classification (P10/LLC/WS with category) ──────── */
  const handleConfirmExpanded = useCallback((tx: any) => {
    const cs = getCs(tx.id)
    if (!cs.bucket) return
    handleClassify(tx, cs.bucket, cs.category, cs.notes)
  }, [handleClassify, classifyState])

  /* ── Split handler ───────────────────────────────────────────────────────── */
  const handleSplit = useCallback(async (parentId: string, fragments: any[]) => {
    await window.api.transactions.split(parentId, fragments)
    setTransactions(prev => prev.filter(t => t.id !== parentId))
    onPendingChange?.(transactions.length - 1)
  }, [transactions.length, onPendingChange])

  /* ── Rule save handler ───────────────────────────────────────────────────── */
  const handleRuleSave = useCallback(async (_tx: any, rule: any) => {
    const result = await window.api.rules.save(rule)
    if (result?.success === false) throw new Error(result.error ?? "Rule save failed")
  }, [])

  /* ── AI Suggestions ──────────────────────────────────────────────────────── */
  const handleAiSuggest = useCallback(async (tx: any) => {
    setAiLoading(prev => ({ ...prev, [tx.id]: true }))
    try {
      const res = await window.api.claude.suggest({
        description_raw: tx.description_raw, merchant_name: tx.merchant_name,
        amount: tx.amount, transaction_date: tx.transaction_date,
        account_mask: tx.account_mask, category_source: tx.category_source,
        flag_reason: tx.flag_reason,
      })
      if (res?.success && res.data) setAiSuggestions(prev => ({ ...prev, [tx.id]: res.data }))
    } catch {} finally { setAiLoading(prev => ({ ...prev, [tx.id]: false })) }
  }, [])

  const handleAiSuggestBatch = useCallback(async () => {
    setAiBatchLoading(true)
    try {
      const batch = visible.slice(0, 10).map(tx => ({
        id: tx.id, description_raw: tx.description_raw, merchant_name: tx.merchant_name,
        amount: tx.amount, transaction_date: tx.transaction_date,
        account_mask: tx.account_mask, category_source: tx.category_source, flag_reason: tx.flag_reason,
      }))
      const res = await window.api.claude.suggestBatch(batch)
      if (res?.success && res.data && typeof res.data === "object") setAiSuggestions(prev => ({ ...prev, ...res.data }))
    } catch {} finally { setAiBatchLoading(false) }
  }, [visible])

  /* ── Batch classify ──────────────────────────────────────────────────────── */
  const handleBatchClassify = useCallback(async (bucket: string) => {
    const ids = Array.from(selected)
    for (const id of ids) {
      try { await window.api.transactions.classify(id, { bucket, review_status: "manually_classified" }) } catch {}
    }
    setTransactions(prev => prev.filter(t => !selected.has(t.id)))
    setSelected(new Set())
    setBatchBucket(null)
    onPendingChange?.(transactions.length - ids.length)
  }, [selected, transactions.length, onPendingChange])

  /* ── Keyboard navigation ─────────────────────────────────────────────────── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return

      const tx = visible[focusIdx]
      if (!tx) return

      switch (e.key) {
        case "ArrowDown": e.preventDefault(); setFocusIdx(i => Math.min(i + 1, visible.length - 1)); break
        case "ArrowUp":   e.preventDefault(); setFocusIdx(i => Math.max(i - 1, 0)); break
        case "j":         e.preventDefault(); setFocusIdx(i => Math.min(i + 1, visible.length - 1)); break
        case "k":         e.preventDefault(); setFocusIdx(i => Math.max(i - 1, 0)); break
        case "1": case "2": case "3": case "4": case "5": {
          e.preventDefault()
          const bucket = bucketKeys[e.key]
          if (bucket) handleBucketClick(tx, bucket)
          break
        }
        case "r": case "R": e.preventDefault(); setDrawer({ tx, mode: "rule" }); break
        case "s": case "S": {
          e.preventDefault()
          const isAtt = tx.flag_reason?.toLowerCase().includes("at&t") && Math.abs(tx.amount) >= 300
          setDrawer({ tx, mode: isAtt ? "att" : "split" })
          break
        }
        case "Enter": {
          const cs = getCs(tx.id)
          if (cs.showCategory && cs.bucket) { e.preventDefault(); handleConfirmExpanded(tx) }
          break
        }
        case "Escape": {
          if (drawer) { setDrawer(null); break }
          const cs = getCs(tx.id)
          if (cs.showCategory) setCs(tx.id, { showCategory: false, bucket: undefined })
          break
        }
        case " ": {
          e.preventDefault()
          setSelected(prev => { const n = new Set(prev); n.has(tx.id) ? n.delete(tx.id) : n.add(tx.id); return n })
          break
        }
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [visible, focusIdx, drawer, handleBucketClick, handleConfirmExpanded, classifyState])

  // Keep focusIdx in bounds
  useEffect(() => {
    if (focusIdx >= visible.length && visible.length > 0) setFocusIdx(visible.length - 1)
  }, [visible.length, focusIdx])

  // Scroll focused row into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${focusIdx}"]`)
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [focusIdx])

  /* ── Render ──────────────────────────────────────────────────────────────── */

  if (loading) return <div className="p-8 text-gray-500">Loading review queue...</div>
  if (error) return <div className="p-8 text-red-600">{error} <button onClick={load} className="underline ml-2">Retry</button></div>

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Review Queue</h1>
          <p className="text-sm text-slate-500 mt-1">
            {visible.length} transaction{visible.length !== 1 ? "s" : ""} &middot;
            <span className="text-slate-400 ml-1">Keys: 1-5 buckets &middot; &uarr;&darr; navigate &middot; R rule &middot; S split &middot; Space select</span>
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700">
            <option value="all">All ({transactions.length})</option>
            <option value="pending_review">Pending ({transactions.filter(t => t.review_status === "pending_review").length})</option>
            <option value="flagged">Flagged ({transactions.filter(t => t.review_status === "flagged").length})</option>
          </select>
          {aiEnabled && visible.length > 0 && (
            <button onClick={handleAiSuggestBatch} disabled={aiBatchLoading}
              className="px-3 py-2 bg-violet-600 text-white text-sm rounded-lg hover:bg-violet-700 disabled:opacity-50">
              {aiBatchLoading ? "Thinking..." : "AI Suggest"}
            </button>
          )}
          <button onClick={load} className="px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Refresh</button>
        </div>
      </div>

      {/* ── Batch action bar ───────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="bg-slate-800 text-white rounded-xl px-5 py-3 mb-4 flex items-center justify-between">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <div className="flex gap-2">
            {BUCKETS.map(b => (
              <button key={b} onClick={() => handleBatchClassify(b)}
                className="px-3 py-1.5 bg-white/20 hover:bg-white/30 rounded-lg text-xs font-medium transition-colors">
                {bucketShortLabel[b] ?? b}
              </button>
            ))}
            <button onClick={() => { setSelected(new Set()) }}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs">Clear</button>
          </div>
        </div>
      )}

      {/* ── Empty state ────────────────────────────────────────────────────── */}
      {visible.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-8 text-center">
          <p className="text-green-800 font-medium text-lg">Queue is clear</p>
          <p className="text-green-600 text-sm mt-1">All transactions have been classified.</p>
        </div>
      )}

      {/* ── Transaction list ───────────────────────────────────────────────── */}
      <div ref={listRef} className="space-y-2">
        {visible.map((tx, idx) => (
          <TransactionRow
            key={tx.id}
            tx={tx}
            idx={idx}
            isFocused={idx === focusIdx}
            isSelected={selected.has(tx.id)}
            isAnimatingOut={animatingOut.has(tx.id)}
            isSaving={!!saving[tx.id]}
            cs={getCs(tx.id)}
            aiSuggestion={aiSuggestions[tx.id]}
            aiLoading={!!aiLoading[tx.id]}
            aiEnabled={aiEnabled}
            onFocus={() => setFocusIdx(idx)}
            onToggleSelect={() => {
              setSelected(prev => { const n = new Set(prev); n.has(tx.id) ? n.delete(tx.id) : n.add(tx.id); return n })
            }}
            onBucketClick={(bucket) => handleBucketClick(tx, bucket)}
            onConfirmExpanded={() => handleConfirmExpanded(tx)}
            onSetCs={(patch) => setCs(tx.id, patch)}
            onOpenDrawer={(mode) => setDrawer({ tx, mode })}
            onAiSuggest={() => handleAiSuggest(tx)}
            onApplyAi={() => {
              const s = aiSuggestions[tx.id]
              if (s) setCs(tx.id, { bucket: s.bucket, category: s.p10_category ?? s.llc_category ?? "", showCategory: s.bucket !== "Personal" && s.bucket !== "Exclude" })
            }}
          />
        ))}
      </div>

      {/* ── Side Drawer ────────────────────────────────────────────────────── */}
      {drawer && (
        <SideDrawer
          tx={drawer.tx}
          mode={drawer.mode}
          onClose={() => setDrawer(null)}
          onSplitConfirm={handleSplit}
          onRuleSave={handleRuleSave}
          classifyState={getCs(drawer.tx.id)}
        />
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/* ── Transaction Row Component ─────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════════════ */

interface RowProps {
  tx: any; idx: number; isFocused: boolean; isSelected: boolean
  isAnimatingOut: boolean; isSaving: boolean; cs: ClassifyState
  aiSuggestion: any; aiLoading: boolean; aiEnabled: boolean
  onFocus: () => void; onToggleSelect: () => void
  onBucketClick: (bucket: string) => void
  onConfirmExpanded: () => void
  onSetCs: (patch: Partial<ClassifyState>) => void
  onOpenDrawer: (mode: "split" | "att" | "rule") => void
  onAiSuggest: () => void; onApplyAi: () => void
}

function TransactionRow({
  tx, idx, isFocused, isSelected, isAnimatingOut, isSaving, cs,
  aiSuggestion, aiLoading, aiEnabled,
  onFocus, onToggleSelect, onBucketClick, onConfirmExpanded, onSetCs,
  onOpenDrawer, onAiSuggest, onApplyAi,
}: RowProps) {
  const border = statusBorder[tx.review_status] ?? "border-l-gray-300"
  const isAtt = tx.flag_reason?.toLowerCase().includes("at&t") && Math.abs(tx.amount) >= 300
  const needsCategory = cs.showCategory && (cs.bucket === "Peak 10" || cs.bucket === "Moonsmoke LLC" || cs.bucket === "Watersound Investments LLC")
  const noteSuggestions = useNoteSuggestions(cs.category, tx.merchant_name)

  return (
    <div
      data-idx={idx}
      onClick={onFocus}
      className={`
        bg-white rounded-xl border border-slate-200 border-l-4 ${border} shadow-sm
        transition-all duration-300
        ${isFocused ? "ring-2 ring-blue-400 ring-offset-1" : ""}
        ${isSelected ? "bg-blue-50/50" : ""}
        ${isAnimatingOut ? "opacity-0 scale-95 -translate-x-8" : "opacity-100"}
      `}
    >
      {/* ── Main Row: always visible ───────────────────────────────────────── */}
      <div className="px-4 py-3 flex items-center gap-3">
        {/* Checkbox */}
        <input type="checkbox" checked={isSelected} onChange={onToggleSelect}
          className="rounded shrink-0" onClick={e => e.stopPropagation()} />

        {/* Merchant + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-800 truncate text-sm">
              {tx.merchant_name || tx.description_raw || "Unknown"}
            </span>
            {tx.review_status === "flagged" && (
              <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium shrink-0">Flagged</span>
            )}
            {tx.bucket && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0 ${bucketBadge[tx.bucket] ?? "bg-gray-100"}`}>
                {tx.bucket}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-0.5 flex gap-2 flex-wrap">
            <span>{fmtDate(tx.transaction_date)}</span>
            <span>···{tx.account_mask ?? ""}</span>
            {tx.flag_reason && <span className="text-red-500 italic truncate max-w-[200px]">{tx.flag_reason}</span>}
          </div>
        </div>

        {/* Amount */}
        <div className={`font-bold text-sm shrink-0 ${tx.amount < 0 ? "text-green-600" : "text-slate-800"}`}>
          {tx.amount < 0 ? "-" : ""}{fmt(tx.amount)}
        </div>

        {/* ── Inline bucket buttons ────────────────────────────────────────── */}
        <div className="flex gap-1 shrink-0">
          {BUCKETS.map(b => (
            <button key={b}
              onClick={e => { e.stopPropagation(); onBucketClick(b) }}
              disabled={isSaving}
              title={`${b} (${BUCKETS.indexOf(b) + 1})`}
              className={`px-2 py-1 rounded text-xs font-medium transition-all disabled:opacity-50
                ${cs.bucket === b ? bucketBtnColor[b] : bucketBtnInactive}`}
            >
              {bucketShortLabel[b]}
            </button>
          ))}
          {/* More menu */}
          <div className="relative group">
            <button className="px-1.5 py-1 rounded text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              onClick={e => e.stopPropagation()}>
              &hellip;
            </button>
            <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 hidden group-hover:block z-30 w-36">
              <button onClick={() => onOpenDrawer(isAtt ? "att" : "split")}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50">
                {isAtt ? "AT&T Split" : "Split Transaction"} <span className="text-slate-400 ml-1">S</span>
              </button>
              <button onClick={() => onOpenDrawer("rule")}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50">
                Create Rule <span className="text-slate-400 ml-1">R</span>
              </button>
              {aiEnabled && !aiSuggestion && (
                <button onClick={onAiSuggest} disabled={aiLoading}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 text-violet-600">
                  {aiLoading ? "Thinking..." : "AI Suggest"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── AI Suggestion banner ───────────────────────────────────────────── */}
      {aiSuggestion && !cs.showCategory && (
        <div className="mx-4 mb-2 px-3 py-2 rounded-lg text-xs border bg-violet-50 border-violet-200 flex items-center justify-between">
          <div>
            <span className="font-medium text-violet-800">AI:</span>
            <span className={`ml-1 px-1.5 py-0.5 rounded-full font-medium ${bucketBadge[aiSuggestion.bucket] ?? "bg-gray-100"}`}>
              {aiSuggestion.bucket}
            </span>
            {aiSuggestion.p10_category && <span className="ml-1 text-slate-500">({aiSuggestion.p10_category})</span>}
            {aiSuggestion.llc_category && <span className="ml-1 text-slate-500">({aiSuggestion.llc_category})</span>}
            <span className={`ml-2 ${aiSuggestion.confidence >= 0.7 ? "text-green-600" : "text-amber-600"}`}>
              {Math.round(aiSuggestion.confidence * 100)}%
            </span>
            {aiSuggestion.reasoning && <span className="ml-2 text-slate-400 italic">{aiSuggestion.reasoning}</span>}
          </div>
          <button onClick={onApplyAi} className="px-2 py-1 bg-violet-600 text-white rounded text-xs hover:bg-violet-700">Apply</button>
        </div>
      )}

      {/* ── Expanded: category + notes (after P10/LLC/WS click) ────────── */}
      {needsCategory && (
        <div className="border-t border-slate-100 px-4 py-3 space-y-3 bg-slate-50/50">
          {/* Category selector */}
          {cs.bucket === "Peak 10" && (
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">P10 Category</label>
              <select value={cs.category ?? ""} onChange={e => onSetCs({ category: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" autoFocus>
                <option value="">— Select category —</option>
                {P10_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          {cs.bucket === "Moonsmoke LLC" && (
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">LLC Category</label>
              <select value={cs.category ?? ""} onChange={e => onSetCs({ category: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" autoFocus>
                <option value="">— Select category —</option>
                {LLC_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          {cs.bucket === "Watersound Investments LLC" && (
            <p className="text-xs text-slate-500 italic">No sub-categories for Watersound yet.</p>
          )}

          {/* Attendee warning */}
          {cs.bucket === "Peak 10" && cs.category === "Meals & Meetings - external" && (
            <div className="text-xs text-orange-600 font-medium">Attendee names required below</div>
          )}

          {/* Notes with suggestions */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">Notes</label>
            <input type="text" value={cs.notes ?? ""} onChange={e => onSetCs({ notes: e.target.value })}
              placeholder={cs.category === "Meals & Meetings - external" ? "Names and titles of all attendees..." : "Optional notes..."}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
            {noteSuggestions.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {noteSuggestions.slice(0, 6).map((s, i) => (
                  <button key={i} onClick={() => onSetCs({ notes: s.note })}
                    className="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 rounded text-xs text-slate-600 truncate max-w-[200px]">
                    {s.note} <span className="text-slate-400">({s.use_count})</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Confirm + Cancel */}
          <div className="flex gap-2">
            <button onClick={onConfirmExpanded} disabled={isSaving}
              className="flex-1 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium hover:bg-slate-900 disabled:opacity-50">
              {isSaving ? "Saving..." : `Confirm → ${cs.bucket}`}
            </button>
            <button onClick={() => onSetCs({ showCategory: false, bucket: undefined })}
              className="px-4 py-2 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
