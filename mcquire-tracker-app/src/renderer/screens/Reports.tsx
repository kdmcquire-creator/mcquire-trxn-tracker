import { useEffect, useState } from "react"

function unwrap<T>(res: any, fallback: T): T {
  if (res === null || res === undefined) return fallback
  if (typeof res === "object" && "data" in res) return (res.data as T) ?? fallback
  return (res as T) ?? fallback
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
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({})
  const [savingNote, setSavingNote] = useState<Record<string, boolean>>({})

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
      const meals = result?.meals ?? []
      const atts = result?.attSplits ?? []
      setBlockerMeals(meals)
      setBlockerAttSplits(atts)
      // Initialize note drafts from existing values
      const drafts: Record<string, string> = {}
      meals.forEach(tx => { drafts[tx.id] = tx.description_notes ?? "" })
      setNoteDraft(drafts)
    } catch {
      // leave lists empty
    } finally {
      setLoadingBlockers(false)
    }
  }

  const saveNote = async (txId: string) => {
    const notes = noteDraft[txId] ?? ""
    if (!notes.trim()) return
    setSavingNote(prev => ({ ...prev, [txId]: true }))
    try {
      await window.api.transactions.classify(txId, {
        description_notes: notes.trim(),
        review_status: "manually_classified",
      })
      setBlockerMeals(prev => prev.filter(t => t.id !== txId))
    } catch (e: any) {
      alert("Save failed: " + (e?.message ?? "unknown"))
    } finally {
      setSavingNote(prev => ({ ...prev, [txId]: false }))
    }
  }

  const saveAllNotes = async () => {
    const toSave = blockerMeals.filter(tx => (noteDraft[tx.id] ?? "").trim())
    for (const tx of toSave) {
      await saveNote(tx.id)
    }
    // Re-run readiness after saving all
    await checkReadiness()
    if (blockerMeals.length === 0 && blockerAttSplits.length === 0) {
      setShowBlockerModal(false)
    }
  }

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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl my-8">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <div>
                <h2 className="text-lg font-bold text-slate-800">Resolve Blockers</h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  Add attendee names to clear the Meals &amp; Meetings blocker. AT&T splits must be resolved in the Review Queue.
                </p>
              </div>
              <button
                onClick={() => { setShowBlockerModal(false); checkReadiness() }}
                className="text-slate-400 hover:text-slate-600 text-2xl leading-none"
              >
                ×
              </button>
            </div>

            <div className="px-6 py-4 space-y-6">
              {loadingBlockers && (
                <p className="text-sm text-slate-500 py-8 text-center">Loading transactions...</p>
              )}

              {/* Meals & Meetings — missing attendees */}
              {!loadingBlockers && (
                <>
                  {blockerMeals.length > 0 ? (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-semibold text-slate-700">
                          Meals &amp; Meetings — missing attendee names ({blockerMeals.length})
                        </h3>
                        <button
                          onClick={saveAllNotes}
                          className="px-4 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-lg hover:bg-slate-900"
                        >
                          Save All
                        </button>
                      </div>

                      <div className="overflow-x-auto border border-slate-200 rounded-lg">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-slate-50 border-b border-slate-200">
                              <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap">Date</th>
                              <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap">Category</th>
                              <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap">Merchant</th>
                              <th className="text-left px-3 py-2 text-xs font-semibold text-red-500 uppercase whitespace-nowrap">Description / Notes ⚠</th>
                              <th className="text-right px-3 py-2 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap">Amount</th>
                              <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500 uppercase whitespace-nowrap">Account</th>
                              <th className="px-3 py-2"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {blockerMeals.map(tx => {
                              const isMissingNotes = !(noteDraft[tx.id] ?? "").trim()
                              return (
                                <tr key={tx.id} className={isMissingNotes ? "bg-red-50" : "bg-white"}>
                                  <td className="px-3 py-2 whitespace-nowrap text-slate-700">{fmtDate(tx.transaction_date)}</td>
                                  <td className="px-3 py-2 whitespace-nowrap text-slate-600 text-xs">{tx.p10_category}</td>
                                  <td className="px-3 py-2 text-slate-800 font-medium max-w-[180px] truncate">{tx.merchant_name || tx.description_raw}</td>
                                  <td className="px-3 py-2 min-w-[220px]">
                                    <input
                                      type="text"
                                      value={noteDraft[tx.id] ?? ""}
                                      onChange={e => setNoteDraft(prev => ({ ...prev, [tx.id]: e.target.value }))}
                                      placeholder="Names and titles of all attendees..."
                                      className={`w-full border rounded px-2 py-1 text-sm ${
                                        isMissingNotes
                                          ? "border-red-400 bg-red-50 placeholder-red-300 focus:border-red-500"
                                          : "border-slate-300 focus:border-blue-400"
                                      } focus:outline-none`}
                                    />
                                  </td>
                                  <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-slate-800">{fmt(tx.amount)}</td>
                                  <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                                    {tx.account_mask ? `···${tx.account_mask}` : tx.account_name ?? ""}
                                  </td>
                                  <td className="px-3 py-2">
                                    <button
                                      onClick={() => saveNote(tx.id)}
                                      disabled={savingNote[tx.id] || isMissingNotes}
                                      className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-40 whitespace-nowrap"
                                    >
                                      {savingNote[tx.id] ? "Saving..." : "Save"}
                                    </button>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-700">
                      ✅ No Meals &amp; Meetings transactions with missing attendee names in this period.
                    </div>
                  )}

                  {/* AT&T splits */}
                  {blockerAttSplits.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold text-slate-700 mb-3">
                        AT&T bills pending split ({blockerAttSplits.length})
                      </h3>
                      <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 text-sm text-orange-800 space-y-2">
                        <p className="font-medium">These must be resolved in the Review Queue — open each flagged AT&T charge and enter the Peak 10 line cost from att.com/billdetail.</p>
                        <ul className="space-y-1">
                          {blockerAttSplits.map(tx => (
                            <li key={tx.id} className="flex justify-between">
                              <span>{fmtDate(tx.transaction_date)} — {tx.merchant_name || tx.description_raw}</span>
                              <span className="font-medium">{fmt(tx.amount)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Modal footer */}
            <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
              <button
                onClick={() => { setShowBlockerModal(false); checkReadiness() }}
                className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-900"
              >
                Done — Re-check Readiness
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
