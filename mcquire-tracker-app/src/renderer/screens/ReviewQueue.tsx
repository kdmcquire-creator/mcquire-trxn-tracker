import { useEffect, useState, useCallback } from "react"
import AssignmentWizard from "./AssignmentWizard"

function unwrap<T>(res: any, fallback: T): T {
  if (res === null || res === undefined) return fallback
  if (typeof res === "object" && "data" in res) return (res.data as T) ?? fallback
  return (res as T) ?? fallback
}

const bucketBadge: Record<string, string> = {
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
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

interface Props {
  onPendingChange?: (count: number) => void
}

export default function ReviewQueue({ onPendingChange }: Props) {
  const [transactions, setTransactions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<"all" | "pending_review" | "flagged">("all")
  const [wizardOpen, setWizardOpen] = useState(false)

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

  const visible = transactions.filter(t =>
    filterStatus === "all" ? true : t.review_status === filterStatus
  )

  /* ── Wizard callbacks ────────────────────────────────────────────────────── */
  const handleClassify = useCallback(async (txId: string, update: any) => {
    await window.api.transactions.classify(txId, update)
    setTransactions(prev => prev.filter(t => t.id !== txId))
    onPendingChange?.(transactions.length - 1)
  }, [transactions.length, onPendingChange])

  const handleSplit = useCallback(async (txId: string, fragments: any[]) => {
    await window.api.transactions.split(txId, fragments)
    setTransactions(prev => prev.filter(t => t.id !== txId))
    onPendingChange?.(transactions.length - 1)
  }, [transactions.length, onPendingChange])

  const handleWizardClose = useCallback(() => {
    setWizardOpen(false)
    load() // refresh list after wizard closes
  }, [load])

  if (loading) return <div className="p-8 text-gray-500">Loading review queue...</div>
  if (error) return <div className="p-8 text-red-600">{error} <button onClick={load} className="underline ml-2">Retry</button></div>

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Review Queue</h1>
          <p className="text-sm text-slate-500 mt-1">
            {visible.length} transaction{visible.length !== 1 ? "s" : ""} need your attention
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700">
            <option value="all">All ({transactions.length})</option>
            <option value="pending_review">Pending ({transactions.filter(t => t.review_status === "pending_review").length})</option>
            <option value="flagged">Flagged ({transactions.filter(t => t.review_status === "flagged").length})</option>
          </select>
          <button onClick={load} className="px-3 py-2 border border-slate-300 text-sm rounded-lg hover:bg-slate-50">Refresh</button>
          {visible.length > 0 && (
            <button onClick={() => setWizardOpen(true)}
              className="px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors">
              Assign Transactions
            </button>
          )}
        </div>
      </div>

      {/* ── Empty state ────────────────────────────────────────────────────── */}
      {visible.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-8 text-center">
          <p className="text-green-800 font-medium text-lg">Queue is clear</p>
          <p className="text-green-600 text-sm mt-1">All transactions have been classified.</p>
        </div>
      )}

      {/* ── Transaction list (preview, not for editing) ────────────────────── */}
      {visible.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-3 text-slate-600">Date</th>
                  <th className="text-left px-4 py-3 text-slate-600">Merchant</th>
                  <th className="text-left px-4 py-3 text-slate-600">Account</th>
                  <th className="text-right px-4 py-3 text-slate-600">Amount</th>
                  <th className="text-left px-4 py-3 text-slate-600">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map(tx => (
                  <tr key={tx.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{fmtDate(tx.transaction_date)}</td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-800 truncate max-w-xs">
                        {tx.merchant_name || tx.description_raw || "Unknown"}
                      </div>
                      {tx.flag_reason && <div className="text-xs text-orange-500 truncate max-w-xs">{tx.flag_reason}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">···{tx.account_mask ?? ""}</td>
                    <td className={`px-4 py-2.5 text-right font-medium whitespace-nowrap ${tx.amount < 0 ? "text-green-600" : "text-slate-800"}`}>
                      {tx.amount < 0 ? "-" : ""}{fmt(tx.amount)}
                    </td>
                    <td className="px-4 py-2.5">
                      {tx.review_status === "flagged"
                        ? <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">Flagged</span>
                        : <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">Pending</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Assignment Wizard (modal overlay) ──────────────────────────────── */}
      {wizardOpen && (
        <AssignmentWizard
          transactions={visible}
          onClassify={handleClassify}
          onSplit={handleSplit}
          onClose={handleWizardClose}
        />
      )}
    </div>
  )
}
