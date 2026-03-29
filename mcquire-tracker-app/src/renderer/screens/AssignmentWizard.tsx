import { useState, useEffect, useCallback } from "react"
import { P10_CATEGORIES, LLC_CATEGORIES } from "../../shared/types"

/* ── Helpers ───────────────────────────────────────────────────────────────── */

const ENTITIES = ["Peak 10", "Moonsmoke LLC", "Watersound Investments LLC", "Personal", "Exclude"] as const

const entityColor: Record<string, string> = {
  "Peak 10":                    "bg-blue-600 text-white hover:bg-blue-700",
  "Moonsmoke LLC":              "bg-green-600 text-white hover:bg-green-700",
  "Watersound Investments LLC": "bg-purple-600 text-white hover:bg-purple-700",
  Personal:                     "bg-slate-600 text-white hover:bg-slate-700",
  Exclude:                      "bg-red-600 text-white hover:bg-red-700",
}

const entityBadge: Record<string, string> = {
  "Peak 10": "bg-blue-100 text-blue-800",
  "Moonsmoke LLC": "bg-green-100 text-green-800",
  "Watersound Investments LLC": "bg-purple-100 text-purple-800",
  Personal: "bg-gray-100 text-gray-700",
  Exclude: "bg-red-100 text-red-700",
}

const fmt = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (s: string) => {
  if (!s) return ""
  const d = new Date(s + "T00:00:00")
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/* ── Smart category ranking ────────────────────────────────────────────────── */

const RESTAURANT_KEYWORDS = ["restaurant", "dining", "food", "bar", "grill", "cafe", "bistro", "steakhouse", "sushi", "pizza", "taco", "bbq", "diner"]
const TRAVEL_KEYWORDS = ["airline", "hotel", "hilton", "marriott", "hyatt", "southwest", "united", "delta", "airbnb", "rental", "hertz", "avis", "alamo"]
const FUEL_KEYWORDS = ["shell", "exxon", "chevron", "valero", "buc-ee", "7-eleven", "gas", "fuel"]
const TELECOM_KEYWORDS = ["at&t", "verizon", "t-mobile", "sprint", "comcast", "spectrum"]
const SOFTWARE_KEYWORDS = ["apple", "google", "microsoft", "adobe", "anthropic", "openai", "github", "slack"]

function getSuggestedCategories(entity: string, tx: any): string[] {
  if (entity === "Personal" || entity === "Exclude" || entity === "Watersound Investments LLC") return []

  const allCats = entity === "Peak 10" ? [...P10_CATEGORIES] : [...LLC_CATEGORIES]
  const merchant = ((tx.merchant_name ?? "") + " " + (tx.description_raw ?? "")).toLowerCase()
  const catSource = (tx.category_source ?? "").toLowerCase()

  const scored: Array<{ cat: string; score: number }> = allCats.map(cat => {
    let score = 0
    const catLow = cat.toLowerCase()

    // Restaurant / meal signals
    if (catLow.includes("meal") || catLow.includes("entertainment")) {
      if (RESTAURANT_KEYWORDS.some(k => merchant.includes(k) || catSource.includes(k))) score += 10
      if (catSource.includes("restaurant") || catSource.includes("dining")) score += 15
    }

    // Travel signals
    if (catLow.includes("travel") || catLow.includes("lodging")) {
      if (TRAVEL_KEYWORDS.some(k => merchant.includes(k))) score += 10
    }

    // Fuel signals
    if (catLow.includes("travel") && FUEL_KEYWORDS.some(k => merchant.includes(k))) score += 12

    // Telecom signals
    if (catLow.includes("telephone") || catLow.includes("communication")) {
      if (TELECOM_KEYWORDS.some(k => merchant.includes(k))) score += 10
    }

    // Software/tech signals
    if (catLow.includes("software") || catLow.includes("computer") || catLow.includes("office supplies")) {
      if (SOFTWARE_KEYWORDS.some(k => merchant.includes(k))) score += 10
    }

    // Dues/subscriptions signals
    if (catLow.includes("dues") || catLow.includes("subscription")) {
      if (merchant.includes("membership") || merchant.includes("subscription") || merchant.includes("annual")) score += 10
    }

    return { cat, score }
  })

  // Sort: scored items first, then alphabetical
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.cat.localeCompare(b.cat)
  })

  return scored.map(s => s.cat)
}

/* ── Parse note suggestions into individual chips ──────────────────────────── */

function parseNoteSuggestions(rawNotes: Array<{ note: string; use_count: number }>): string[] {
  const nameSet = new Set<string>()

  for (const { note } of rawNotes) {
    // Split on commas, semicolons, " and ", " & "
    const parts = note.split(/[,;]|\s+and\s+|\s+&\s+/i)
    for (const p of parts) {
      const trimmed = p.trim()
      if (trimmed.length >= 2 && trimmed.length <= 80) {
        nameSet.add(trimmed)
      }
    }
  }

  return Array.from(nameSet)
}

/* ── Split State ───────────────────────────────────────────────────────────── */

interface SplitEntry {
  entity: string
  amount: string
  category: string
  notes: string
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/* ── Assignment Wizard Component ───────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════════════ */

interface WizardProps {
  transactions: any[]
  onClassify: (txId: string, update: any) => Promise<void>
  onSplit: (txId: string, fragments: any[]) => Promise<void>
  onClose: () => void
}

type WizardStep = "entity" | "category" | "notes"

export default function AssignmentWizard({ transactions, onClassify, onSplit, onClose }: WizardProps) {
  const [txIdx, setTxIdx] = useState(0)
  const [step, setStep] = useState<WizardStep>("entity")
  const [entity, setEntity] = useState("")
  const [category, setCategory] = useState("")
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)

  // Split mode
  const [isSplitMode, setIsSplitMode] = useState(false)
  const [splitEntries, setSplitEntries] = useState<SplitEntry[]>([
    { entity: "", amount: "", category: "", notes: "" },
    { entity: "", amount: "", category: "", notes: "" },
  ])

  // Note suggestions
  const [noteSuggestions, setNoteSuggestions] = useState<string[]>([])

  const tx = transactions[txIdx]
  const totalCount = transactions.length
  const isLastTx = txIdx >= totalCount - 1

  // Reset state when moving to a new transaction
  useEffect(() => {
    setStep("entity")
    setEntity("")
    setCategory("")
    setNotes("")
    setIsSplitMode(false)
    setSplitEntries([
      { entity: "", amount: "", category: "", notes: "" },
      { entity: "", amount: "", category: "", notes: "" },
    ])
    setNoteSuggestions([])
  }, [txIdx])

  // Load note suggestions when we reach the notes step
  useEffect(() => {
    if (step !== "notes" || !tx) return
    const merchant = tx.merchant_name ?? tx.description_raw
    window.api?.transactions?.getRecentNotes?.({ category: category || undefined, merchant: merchant || undefined })
      .then((res: any) => {
        const data = res?.data ?? res ?? []
        if (Array.isArray(data)) {
          setNoteSuggestions(parseNoteSuggestions(data))
        }
      })
      .catch(() => {})
  }, [step, category, tx])

  /* ── Entity selection ────────────────────────────────────────────────────── */
  const handleEntitySelect = useCallback((selectedEntity: string) => {
    setEntity(selectedEntity)

    // Personal and Exclude skip category step
    if (selectedEntity === "Personal" || selectedEntity === "Exclude") {
      setCategory("")
      setStep("notes")
      return
    }

    // Watersound has no sub-categories yet
    if (selectedEntity === "Watersound Investments LLC") {
      setCategory("")
      setStep("notes")
      return
    }

    // P10 and LLC go to category step
    setStep("category")
  }, [])

  /* ── Category selection ──────────────────────────────────────────────────── */
  const handleCategorySelect = useCallback((selectedCat: string) => {
    setCategory(selectedCat)
    setStep("notes")
  }, [])

  /* ── Toggle a note chip ──────────────────────────────────────────────────── */
  const toggleNoteChip = useCallback((chip: string) => {
    setNotes(prev => {
      const parts = prev.split(",").map(s => s.trim()).filter(Boolean)
      if (parts.includes(chip)) {
        return parts.filter(p => p !== chip).join(", ")
      } else {
        return [...parts, chip].join(", ")
      }
    })
  }, [])

  /* ── Finish: save and advance ────────────────────────────────────────────── */
  const handleFinish = useCallback(async () => {
    if (!tx) return
    setSaving(true)
    try {
      if (isSplitMode) {
        const fragments = splitEntries
          .filter(s => s.entity && s.amount)
          .map(s => ({
            amount: parseFloat(s.amount),
            bucket: s.entity,
            p10_category: s.entity === "Peak 10" ? s.category : undefined,
            llc_category: s.entity === "Moonsmoke LLC" ? s.category : undefined,
            description_notes: s.notes || undefined,
          }))
        if (fragments.length < 2) { alert("Enter at least 2 split fragments"); setSaving(false); return }
        await onSplit(tx.id, fragments)
      } else {
        const update: any = {
          bucket: entity,
          review_status: "manually_classified",
          description_notes: notes,
        }
        if (entity === "Peak 10") update.p10_category = category
        if (entity === "Moonsmoke LLC") update.llc_category = category
        await onClassify(tx.id, update)
      }

      // Advance to next transaction or close
      if (isLastTx) {
        onClose()
      } else {
        setTxIdx(i => i + 1)
      }
    } catch (e: any) {
      alert("Error: " + (e?.message ?? "unknown"))
    } finally {
      setSaving(false)
    }
  }, [tx, entity, category, notes, isSplitMode, splitEntries, isLastTx, onClassify, onSplit, onClose])

  /* ── Skip this transaction ───────────────────────────────────────────────── */
  const handleSkip = useCallback(() => {
    if (isLastTx) onClose()
    else setTxIdx(i => i + 1)
  }, [isLastTx, onClose])

  if (!tx) {
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
        <div className="bg-white rounded-2xl shadow-2xl p-8 text-center max-w-md">
          <p className="text-2xl font-bold text-green-700 mb-2">All done!</p>
          <p className="text-slate-500">All transactions have been assigned.</p>
          <button onClick={onClose} className="mt-4 px-6 py-2 bg-slate-800 text-white rounded-lg">Close</button>
        </div>
      </div>
    )
  }

  const suggestedCats = getSuggestedCategories(entity, tx)
  const isAtt = (tx.flag_reason ?? "").toLowerCase().includes("at&t") && Math.abs(tx.amount) >= 300

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* ── Header: progress + close ─────────────────────────────────────── */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Assign Transactions</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {txIdx + 1} of {totalCount}
              {entity && <span className="ml-2">
                &middot; <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${entityBadge[entity] ?? ""}`}>{entity}</span>
              </span>}
              {category && <span className="ml-1 text-xs text-slate-400">&rarr; {category}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleSkip} className="text-sm text-slate-400 hover:text-slate-600">Skip</button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">&times;</button>
          </div>
        </div>

        {/* ── Progress bar ─────────────────────────────────────────────────── */}
        <div className="h-1 bg-slate-100 shrink-0">
          <div className="h-1 bg-blue-500 transition-all duration-300" style={{ width: `${((txIdx + 1) / totalCount) * 100}%` }} />
        </div>

        {/* ── Transaction info (always visible) ────────────────────────────── */}
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-100 shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-bold text-slate-800 text-lg">{tx.merchant_name || tx.description_raw || "Unknown"}</div>
              <div className="text-sm text-slate-500 mt-1 flex gap-3 flex-wrap">
                <span>{fmtDate(tx.transaction_date)}</span>
                <span>···{tx.account_mask ?? ""}</span>
                {tx.category_source && <span className="italic">{tx.category_source}</span>}
              </div>
            </div>
            <div className={`text-2xl font-bold ${tx.amount < 0 ? "text-green-600" : "text-slate-800"}`}>
              {tx.amount < 0 ? "-" : ""}{fmt(tx.amount)}
            </div>
          </div>
          {tx.flag_reason && (
            <div className="mt-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 text-sm text-orange-700">
              {tx.flag_reason}
            </div>
          )}
        </div>

        {/* ── Step content (scrollable) ────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-5">

          {/* ═══ STEP 1: Entity ═══════════════════════════════════════════════ */}
          {step === "entity" && !isSplitMode && (
            <div className="space-y-4">
              <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Allocate to Entity</div>
              <div className="grid grid-cols-1 gap-2">
                {ENTITIES.map(e => (
                  <button key={e} onClick={() => handleEntitySelect(e)}
                    className={`w-full py-3 px-4 rounded-xl text-sm font-semibold transition-all text-left ${entityColor[e]}`}>
                    {e}
                  </button>
                ))}
              </div>

              {/* Split option */}
              <div className="pt-2 border-t border-slate-200">
                <button onClick={() => setIsSplitMode(true)}
                  className="w-full py-3 px-4 rounded-xl text-sm font-semibold bg-orange-100 text-orange-700 hover:bg-orange-200 transition-all text-left">
                  Split Transaction
                  {isAtt && <span className="ml-2 text-xs text-orange-500">(AT&T bill detected)</span>}
                </button>
              </div>
            </div>
          )}

          {/* ═══ STEP 1b: Split Mode ══════════════════════════════════════════ */}
          {step === "entity" && isSplitMode && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Split Transaction</div>
                <button onClick={() => setIsSplitMode(false)} className="text-xs text-slate-400 hover:text-slate-600">Cancel split</button>
              </div>
              <p className="text-xs text-slate-500">Total: {fmt(tx.amount)}. Enter amounts and select entities.</p>

              {splitEntries.map((entry, i) => (
                <div key={i} className="bg-slate-50 rounded-xl p-4 space-y-2 border border-slate-200">
                  <div className="text-xs font-semibold text-slate-400">Fragment {i + 1}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <input type="number" step="0.01" placeholder="Amount" value={entry.amount}
                      onChange={e => {
                        const updated = [...splitEntries]
                        updated[i] = { ...updated[i], amount: e.target.value }
                        setSplitEntries(updated)
                      }}
                      className="border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                    <select value={entry.entity}
                      onChange={e => {
                        const updated = [...splitEntries]
                        updated[i] = { ...updated[i], entity: e.target.value, category: "" }
                        setSplitEntries(updated)
                      }}
                      className="border border-slate-300 rounded-lg px-3 py-2 text-sm">
                      <option value="">Entity...</option>
                      {ENTITIES.map(en => <option key={en} value={en}>{en}</option>)}
                    </select>
                  </div>
                  {(entry.entity === "Peak 10" || entry.entity === "Moonsmoke LLC") && (
                    <select value={entry.category}
                      onChange={e => {
                        const updated = [...splitEntries]
                        updated[i] = { ...updated[i], category: e.target.value }
                        setSplitEntries(updated)
                      }}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
                      <option value="">Category...</option>
                      {(entry.entity === "Peak 10" ? P10_CATEGORIES : LLC_CATEGORIES).map(c => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  )}
                  <input type="text" placeholder="Notes (optional)" value={entry.notes}
                    onChange={e => {
                      const updated = [...splitEntries]
                      updated[i] = { ...updated[i], notes: e.target.value }
                      setSplitEntries(updated)
                    }}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
                </div>
              ))}

              <button onClick={() => setSplitEntries(prev => [...prev, { entity: "", amount: "", category: "", notes: "" }])}
                className="text-sm text-blue-600 hover:text-blue-800">+ Add fragment</button>

              <button onClick={handleFinish} disabled={saving}
                className="w-full py-3 bg-slate-800 text-white rounded-xl text-sm font-semibold hover:bg-slate-900 disabled:opacity-50">
                {saving ? "Saving..." : "Confirm Split"}
              </button>
            </div>
          )}

          {/* ═══ STEP 2: Category ═════════════════════════════════════════════ */}
          {step === "category" && (
            <div className="space-y-3">
              <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide">
                Select Category
                <span className="ml-2 text-xs font-normal normal-case text-slate-400">for {entity}</span>
              </div>

              {/* Suggested (high-score) categories first, visually distinct */}
              {suggestedCats.length > 0 && (
                <div className="space-y-1">
                  {suggestedCats.map((cat, i) => {
                    // First few are "suggested" (scored > 0 from our heuristic)
                    const isSuggested = i < 3 && RESTAURANT_KEYWORDS.some(k =>
                      ((tx.merchant_name ?? "") + (tx.category_source ?? "")).toLowerCase().includes(k)
                    ) || i === 0

                    return (
                      <button key={cat} onClick={() => handleCategorySelect(cat)}
                        className={`w-full py-2.5 px-4 rounded-lg text-sm text-left transition-all ${
                          isSuggested
                            ? "bg-blue-50 border border-blue-200 text-blue-800 font-medium hover:bg-blue-100"
                            : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
                        }`}>
                        {cat}
                        {isSuggested && i === 0 && <span className="ml-2 text-xs text-blue-400">suggested</span>}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ═══ STEP 3: Notes ════════════════════════════════════════════════ */}
          {step === "notes" && (
            <div className="space-y-4">
              <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Notes</div>

              {/* Suggestion chips (individual names parsed from comma-separated history) */}
              {noteSuggestions.length > 0 && (
                <div>
                  <div className="text-xs text-slate-400 mb-2">Suggested (click to add):</div>
                  <div className="flex flex-wrap gap-1.5">
                    {noteSuggestions.map((chip, i) => {
                      const isActive = notes.split(",").map(s => s.trim()).includes(chip)
                      return (
                        <button key={i} onClick={() => toggleNoteChip(chip)}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                            isActive
                              ? "bg-blue-600 text-white"
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                          }`}>
                          {chip}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Free text input */}
              <div>
                <label className="text-xs text-slate-400 block mb-1">
                  {entity === "Peak 10" && category === "Meals & Meetings - external"
                    ? "Attendee names (required):"
                    : "Additional notes:"}
                </label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder={entity === "Peak 10" && category === "Meals & Meetings - external"
                    ? "Names and titles of all attendees..."
                    : "Optional notes..."}
                  rows={3}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm resize-none" />
              </div>

              {/* Finish button */}
              <button onClick={handleFinish} disabled={saving}
                className="w-full py-3 bg-slate-800 text-white rounded-xl text-sm font-semibold hover:bg-slate-900 disabled:opacity-50">
                {saving ? "Saving..." : isLastTx ? "Finish (last one)" : "Finish & Next"}
              </button>
            </div>
          )}
        </div>

        {/* ── Step indicator (footer) ──────────────────────────────────────── */}
        <div className="px-6 py-3 border-t border-slate-100 flex items-center gap-4 shrink-0 bg-slate-50">
          {(["entity", "category", "notes"] as WizardStep[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                step === s ? "bg-blue-600 text-white"
                  : (s === "entity" && step !== "entity") || (s === "category" && step === "notes")
                    ? "bg-green-500 text-white"
                    : "bg-slate-200 text-slate-500"
              }`}>
                {(s === "entity" && step !== "entity") || (s === "category" && step === "notes") ? "\u2713" : i + 1}
              </div>
              <span className={`text-xs ${step === s ? "text-slate-700 font-medium" : "text-slate-400"}`}>
                {s === "entity" ? "Entity" : s === "category" ? "Category" : "Notes"}
              </span>
            </div>
          ))}

          {/* Back button */}
          {step !== "entity" && (
            <button onClick={() => setStep(step === "notes" && (entity === "Peak 10" || entity === "Moonsmoke LLC") ? "category" : "entity")}
              className="ml-auto text-xs text-slate-400 hover:text-slate-600">
              &larr; Back
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
