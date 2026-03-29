import { useEffect, useState, useCallback } from "react"

function unwrap<T>(res: any, fallback: T): T {
  if (res === null || res === undefined) return fallback
  if (typeof res === "object" && "data" in res) return (res.data as T) ?? fallback
  return (res as T) ?? fallback
}

/* ── Parse note suggestions into individual name chips ─────────────────────── */
function parseNoteSuggestions(rawNotes: Array<{ note: string; use_count: number }>): string[] {
  const nameSet = new Set<string>()
  for (const { note } of rawNotes) {
    const parts = note.split(/[,;]|\s+and\s+|\s+&\s+/i)
    for (const p of parts) {
      const trimmed = p.trim()
      if (trimmed.length >= 2 && trimmed.length <= 80) nameSet.add(trimmed)
    }
  }
  return Array.from(nameSet)
}

const REPORT_TYPES = [
  { id: "expense_report", label: "Peak 10 Expense Report", icon: "🏢", description: "Submission-ready Excel file for reimbursement. Covers the period you specify." },
  { id: "pnl", label: "Moonsmoke LLC P&L", icon: "📈", description: "Income statement by month, accrual basis." },
  { id: "balance_sheet", label: "Moonsmoke LLC Balance Sheet", icon: "📊", description: "Quarterly snapshots." },
  { id: "cashflow", label: "Moonsmoke LLC Cashflow", icon: "💵", description: "Direct-method cash flow by quarter." },
  { id: "full_tracker", label: "Full Tracker Export", icon: "📋", description: "Complete 9-tab Excel workbook — all buckets. Suitable for CPA." },
  { id: "personal_summary", label: "Personal Income/Expense Summary", icon: "🏠", description: "Side-by-side 2025/2026 summaries." },
]

interface Readiness {
  ready: boolean
  blockers: string[]
  warnings: string[]
}

interface BlockerTx {
  id: string
  transaction_date: string
  p10_category: string | null
  merchant_name: string | null
  description_raw: string
  description_notes: string | null
  amount: number
  account_mask: string | null
  account_name: string | null
  flag_reason: string | null
  review_status: string
}

const fmt = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (s: string) => {
  if (!s) return ""
  const d = new Date(s + "T00:00:00")
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export default function Reports() {
  const [selectedReport, setSelectedReport] = useState<string | null>(null)
  const [periodLabel, setPeriodLabel] = useState("December 2025 – February 2026")
  const [dateFrom, setDateFrom] = useState("2025-12-01")
  const [dateTo, setDateTo] = useState("2026-02-28")
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [checkingReadiness, setCheckingReadiness] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [lastGenerated, setLastGenerated] = useState<{ path: string; report: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Blocker modal state
  const [showBlockerModal, setShowBlockerModal] = useState(false)
  const [blockerMeals, setBlockerMeals] = useState<BlockerTx[]>([])
  const [blockerAttSplits, setBlockerAttSplits] = useState<BlockerTx[]>([])
  const [loadingBlockers, setLoadingBlockers] = useState(false)
  const [savingNote, setSavingNote] = useState(false)
  // Per-transaction note editing dialog
  const [editingBlocker, setEditingBlocker] = useState<BlockerTx | null>(null)
  const [blockerNoteDraft, setBlockerNoteDraft] = useState("")
  const [blockerSuggestions, setBlockerSuggestions] = useState<string[]>([])

  const toggleBlockerChip = useCallback((chip: string) => {
    setBlockerNoteDraft(prev => {
      const parts = prev.split(",").map(s => s.trim()).filter(Boolean)
      if (parts.includes(chip)) return parts.filter(p => p !== chip).join(", ")
      return [...parts, chip].join(", ")
    })
  }, [])

  const openBlockerEdit = useCallback(async (tx: BlockerTx) => {
    setEditingBlocker(tx)
    setBlockerNoteDraft(tx.description_notes ?? "")
    setBlockerSuggestions([])
    // Load suggestions
    try {
      const res = await window.api?.transactions?.getRecentNotes?.({
        category: tx.p10_category ?? undefined,
        merchant: (tx.merchant_name ?? tx.description_raw) || undefined,
      })
      const data = res?.data ?? res ?? []
      if (Array.isArray(data)) setBlockerSuggestions(parseNoteSuggestions(data))
    } catch {}
  }, [])

  const saveBlockerNote = useCallback(async () => {
    if (!editingBlocker || !blockerNoteDraft.trim()) return
    setSavingNote(true)
    try {
      await window.api.transactions.classify(editingBlocker.id, {
        description_notes: blockerNoteDraft.trim(),
        review_status: "manually_classified",
      })
      setBlockerMeals(prev => prev.filter(t => t.id !== editingBlocker.id))
      setEditingBlocker(null)
    } catch (e: any) {
      alert("Save failed: " + (e?.message ?? "unknown"))
    } finally {
      setSavingNote(false)
    }
  }, [editingBlocker, blockerNoteDraft])

  const checkReadiness = async () => {
    setCheckingReadiness(true)
    setError(null)
    try {
      const raw = await window.api.reports.checkExpenseReportReadiness().catch(() => null)
      const result = unwrap<{ ready: boolean; blockers: string[]; warnings: string[] } | null>(raw, null)
      if (result) {
        setReadiness({
          ready: result.ready ?? !result.blockers?.length,
          blockers: result.blockers ?? [],
          warnings: result.warnings ?? [],
        })
      } else {
        setReadiness({ ready: true, blockers: [], warnings: ["Could not verify readiness — check manually before submitting."] })
      }
    } catch (e: any) {
      setError("Readiness check failed: " + (e?.message ?? "unknown"))
    } finally {
      setCheckingReadiness(false)
    }
  }

  useEffect(() => {
    if (selectedReport === "expense_report") {
      checkReadiness()
    } else {
      setReadiness(null)
    }
  }, [selectedReport])

  const openBlockerModal = async () => {
    setShowBlockerModal(true)
    setLoadingBlockers(true)
    try {
      const raw = await window.api.reports.getBlockerTransactions({ dateFrom, dateTo }).catch(() => null)
      const result = unwrap<{ meals: BlockerTx[]; attSplits: BlockerTx[] } | null>(raw, null)
      setBlockerMeals(result?.meals ?? [])
      setBlockerAttSplits(result?.attSplits ?? [])
    } catch {
      // leave lists empty
    } finally {
      setLoadingBlockers(false)
    }
  }

  // (save logic is in saveBlockerNote above)

  const generate = async () => {
    if (!selectedReport) return
    setGenerating(true)
    setError(null)
    try {
      let result: any
      const payload = { dateFrom, dateTo, periodLabel }

      switch (selectedReport) {
        case "expense_report":
          result = await window.api.reports.generateExpenseReport(payload)
          break
        case "pnl":
          result = await window.api.statements.pandl(payload)
          break
        case "balance_sheet":
          result = await window.api.statements.balanceSheet(payload)
          break
        case "cashflow":
          result = await window.api.statements.cashflow(payload)
          break
        case "full_tracker":
          result = await window.api.statements.fullTracker(payload)
          break
        case "personal_summary":
          result = await window.api.statements.personalSummary(payload)
          break
      }

      const data = unwrap<any>(result, null)
      const filePath: string = data?.filePath ?? data?.file_path ?? (typeof data === "string" ? data : "") ?? ""
      if (data !== null && data !== undefined) {
        setLastGenerated({ path: filePath, report: REPORT_TYPES.find(r => r.id === selectedReport)?.label ?? selectedReport! })
      } else {
        throw new Error("No result returned from generator")
      }
    } catch (e: any) {
      setError("Generation failed: " + (e?.message ?? "unknown error"))
    } finally {
      setGenerating(false)
    }
  }

  const openFile = async (path: string) => {
    if (path) {
      try { await window.api.shell.openPath(path) } catch {}
    }
  }

  const openFolder = async () => {
    try { await window.api.statements.openFolder() } catch {}
  }

  const selectedInfo = REPORT_TYPES.find(r => r.id === selectedReport)

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Reports</h1>
        <p className="text-sm text-slate-500 mt-1">Generate expense reports and financial statements</p>
      </div>

      {/* Report type selector */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
        {REPORT_TYPES.map(r => (
          <button
            key={r.id}
            onClick={() => { setSelectedReport(r.id); setLastGenerated(null); setError(null) }}
            className={`text-left p-4 rounded-xl border-2 transition-all ${
              selectedReport === r.id
                ? "border-blue-500 bg-blue-50"
                : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
            }`}
          >
            <div className="text-2xl mb-2">{r.icon}</div>
            <div className="font-semibold text-slate-800 text-sm">{r.label}</div>
            <div className="text-xs text-slate-500 mt-1">{r.description}</div>
          </button>
        ))}
      </div>

      {/* Configuration panel */}
      {selectedReport && (
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-lg font-bold text-slate-800 mb-4">
            {selectedInfo?.icon} {selectedInfo?.label}
          </h2>

          {/* Date range */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
            {selectedReport === "expense_report" && (
              <div className="md:col-span-3">
                <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">Period Label (shown on report)</label>
                <input
                  type="text"
                  value={periodLabel}
                  onChange={e => setPeriodLabel(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  placeholder="e.g. December 2025 – February 2026"
                />
              </div>
            )}
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">Date From</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">Date To</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>

          {/* Readiness check — expense report only */}
          {selectedReport === "expense_report" && (
            <div className="mb-5">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-sm font-semibold text-slate-700">Readiness Check</span>
                <button
                  onClick={checkReadiness}
                  disabled={checkingReadiness}
                  className="text-xs text-blue-600 underline disabled:opacity-50"
                >
                  {checkingReadiness ? "Checking..." : "Re-check"}
                </button>
              </div>

              {readiness && (
                <div className="space-y-2">
                  {readiness.blockers.length > 0 && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                      <p className="text-sm font-semibold text-red-700 mb-1">🚫 Blockers — resolve before generating:</p>
                      <ul className="text-sm text-red-600 space-y-1 mb-3">
                        {readiness.blockers.map((b, i) => <li key={i}>• {b}</li>)}
                      </ul>
                      <button
                        onClick={openBlockerModal}
                        className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
                      >
                        Resolve Blockers
                      </button>
                    </div>
                  )}

                  {readiness.warnings.length > 0 && (
                    <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
                      <p className="text-sm font-semibold text-orange-700 mb-1">⚠️ Warnings:</p>
                      <ul className="text-sm text-orange-600 space-y-1">
                        {readiness.warnings.map((w, i) => <li key={i}>• {w}</li>)}
                      </ul>
                    </div>
                  )}

                  {readiness.ready && readiness.blockers.length === 0 && (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
                      ✅ Ready to generate
                    </div>
                  )}

                  {/* Known open items */}
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600">
                    <p className="font-semibold mb-1">📋 Known open items:</p>
                    <ul className="space-y-0.5">
                      <li>• AT&T splits pending: Dec 26 ($478.91), Jan 20 ($478.20), Feb 20 ($463.73) — pull line 832-687-0468 from att.com/billdetail</li>
                      <li>• Bari Houston Jan 6 ($955.63) — add attendee names before submitting</li>
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Success */}
          {lastGenerated && (
            <div className="mb-4 bg-green-50 border border-green-200 rounded-lg p-4">
              <p className="text-sm font-semibold text-green-800 mb-2">✅ {lastGenerated.report} generated</p>
              <div className="flex items-center gap-3 flex-wrap">
                {lastGenerated.path && (
                  <>
                    <code className="text-xs text-green-700 bg-green-100 px-2 py-1 rounded truncate max-w-xs">{lastGenerated.path}</code>
                    <button onClick={() => openFile(lastGenerated.path)} className="text-xs text-green-700 underline whitespace-nowrap">Open file</button>
                  </>
                )}
                <button onClick={openFolder} className="text-xs text-green-700 underline whitespace-nowrap">Open exports folder</button>
              </div>
            </div>
          )}

          {/* Generate button */}
          <button
            onClick={generate}
            disabled={generating || (selectedReport === "expense_report" && !!readiness?.blockers?.length)}
            className="w-full py-3 bg-slate-800 text-white rounded-lg font-medium hover:bg-slate-900 disabled:opacity-50 transition-colors"
          >
            {generating ? "Generating..." : `Generate ${selectedInfo?.label}`}
          </button>

          {selectedReport === "expense_report" && !!readiness?.blockers?.length && (
            <p className="text-xs text-red-500 text-center mt-2">Resolve blockers above before generating</p>
          )}
        </div>
      )}

      {!selectedReport && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-8 text-center text-slate-400">
          Select a report type above to configure and generate
        </div>
      )}

      {/* ── Blocker Resolution Modal ─────────────────────────────────────────── */}
      {showBlockerModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-lg font-bold text-slate-800">Resolve Blockers</h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  Click a transaction to add attendee names
                </p>
              </div>
              <button onClick={() => { setShowBlockerModal(false); checkReadiness() }}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none">&times;</button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {loadingBlockers && <p className="text-sm text-slate-500 py-8 text-center">Loading...</p>}

              {!loadingBlockers && (
                <>
                  {/* Meals — clickable rows */}
                  {blockerMeals.length > 0 ? (
                    <div>
                      <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">
                        Missing attendee names ({blockerMeals.length})
                      </div>
                      <div className="space-y-1">
                        {blockerMeals.map(tx => (
                          <button key={tx.id} onClick={() => openBlockerEdit(tx)}
                            className="w-full text-left bg-white border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 rounded-xl px-4 py-3 transition-all flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold text-slate-800 text-sm truncate">
                                {tx.merchant_name || tx.description_raw}
                              </div>
                              <div className="text-xs text-slate-500 mt-0.5 flex gap-2">
                                <span>{fmtDate(tx.transaction_date)}</span>
                                <span>···{tx.account_mask ?? ""}</span>
                                <span className="text-slate-400">{tx.p10_category}</span>
                              </div>
                            </div>
                            <div className="font-bold text-slate-800 text-sm shrink-0">{fmt(tx.amount)}</div>
                            <div className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium shrink-0">Needs notes</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">
                      All meals have attendee names.
                    </div>
                  )}

                  {/* AT&T splits */}
                  {blockerAttSplits.length > 0 && (
                    <div>
                      <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">
                        AT&T bills pending split ({blockerAttSplits.length})
                      </div>
                      <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 text-sm text-orange-800 space-y-2">
                        <p>Resolve these in the Review Queue — enter the Peak 10 line cost from att.com/billdetail.</p>
                        {blockerAttSplits.map(tx => (
                          <div key={tx.id} className="flex justify-between text-sm">
                            <span>{fmtDate(tx.transaction_date)} — {tx.merchant_name || tx.description_raw}</span>
                            <span className="font-medium">{fmt(tx.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-slate-100 flex justify-end shrink-0">
              <button onClick={() => { setShowBlockerModal(false); checkReadiness() }}
                className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-900">
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Blocker Note Edit Dialog (pops up on row click) ────────────────── */}
      {editingBlocker && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            {/* Transaction info */}
            <div className="px-6 py-4 bg-slate-50 rounded-t-2xl border-b border-slate-100">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-bold text-slate-800 text-lg">{editingBlocker.merchant_name || editingBlocker.description_raw}</div>
                  <div className="text-sm text-slate-500 mt-1 flex gap-3">
                    <span>{fmtDate(editingBlocker.transaction_date)}</span>
                    <span>···{editingBlocker.account_mask ?? ""}</span>
                    <span className="text-slate-400">{editingBlocker.p10_category}</span>
                  </div>
                </div>
                <div className="text-xl font-bold text-slate-800">{fmt(editingBlocker.amount)}</div>
              </div>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Attendee Names</div>

              {/* Suggestion chips */}
              {blockerSuggestions.length > 0 && (
                <div>
                  <div className="text-xs text-slate-400 mb-2">Suggested (click to add):</div>
                  <div className="flex flex-wrap gap-1.5">
                    {blockerSuggestions.map((chip, i) => {
                      const isActive = blockerNoteDraft.split(",").map(s => s.trim()).includes(chip)
                      return (
                        <button key={i} onClick={() => toggleBlockerChip(chip)}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                            isActive ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                          }`}>
                          {chip}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Free text */}
              <textarea value={blockerNoteDraft} onChange={e => setBlockerNoteDraft(e.target.value)}
                placeholder="Names and titles of all attendees..."
                rows={3}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-blue-400" />

              {/* Finish */}
              <div className="flex gap-2">
                <button onClick={saveBlockerNote} disabled={savingNote || !blockerNoteDraft.trim()}
                  className="flex-1 py-2.5 bg-slate-800 text-white rounded-lg text-sm font-semibold hover:bg-slate-900 disabled:opacity-50">
                  {savingNote ? "Saving..." : "Finish"}
                </button>
                <button onClick={() => setEditingBlocker(null)}
                  className="px-4 py-2.5 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
