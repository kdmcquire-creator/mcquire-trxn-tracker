import { useEffect, useState, useRef } from "react"
import type { Screen } from "../App"

function unwrap<T>(res: any, fallback: T): T {
  if (res === null || res === undefined) return fallback
  if (typeof res === "object" && "data" in res) return (res.data as T) ?? fallback
  return (res as T) ?? fallback
}

interface BucketData {
  peak10: { count: number; total: number }
  llc: { count: number; total: number }
  personal: { income: number; expenses: number; count: number }
  pending_review: number
  flagged: number
}

const fmt = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

interface Props {
  onNavigate: (s: Screen) => void
}

export default function Dashboard({ onNavigate }: Props) {
  const [buckets, setBuckets] = useState<BucketData | null>(null)
  const [accounts, setAccounts] = useState<any[]>([])
  const [recentTx, setRecentTx] = useState<any[]>([])
  const [investmentTotal, setInvestmentTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [runningRules, setRunningRules] = useState(false)
  const [rulesResult, setRulesResult] = useState<{ resolved: number } | null>(null)

  // Import CSV panel state
  const [showImport, setShowImport] = useState(false)
  const [importFile, setImportFile] = useState<string | null>(null)
  const [preview, setPreview] = useState<any | null>(null)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<any | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const progressListenerRef = useRef<((_e: any, data: any) => void) | null>(null)

  const load = async () => {
    try {
      // Bucket totals
      const totalsRaw = await window.api.db.getBucketTotals().catch(() => null)
      const totalsMap = unwrap<Record<string, { total: number; count: number }>>(totalsRaw, {})

      if (Object.keys(totalsMap).length > 0) {
        const p10 = totalsMap["Peak 10"] ?? { total: 0, count: 0 }
        const llc = totalsMap["Moonsmoke LLC"] ?? { total: 0, count: 0 }
        const pers = totalsMap["Personal"] ?? { total: 0, count: 0 }
        setBuckets({
          peak10: { count: p10.count, total: p10.total },
          llc: { count: llc.count, total: llc.total },
          personal: { count: pers.count, expenses: pers.total, income: 0 },
          pending_review: 0,
          flagged: 0,
        })
      } else {
        // Fallback: build from raw transactions
        const allTxRaw = await window.api.transactions.getAll().catch(() => [])
        const allTx: any[] = unwrap<any[]>(allTxRaw, [])
        const p10 = allTx.filter((t: any) => t.bucket === "Peak 10")
        const llc = allTx.filter((t: any) => t.bucket === "Moonsmoke LLC")
        const personal = allTx.filter((t: any) => t.bucket === "Personal")
        const pending = allTx.filter((t: any) => t.review_status === "pending_review")
        const flagged = allTx.filter((t: any) => t.review_status === "flagged")
        setBuckets({
          peak10: { count: p10.length, total: p10.reduce((s: number, t: any) => s + (t.amount || 0), 0) },
          llc: { count: llc.length, total: llc.reduce((s: number, t: any) => s + (t.amount || 0), 0) },
          personal: {
            count: personal.length,
            expenses: personal.filter((t: any) => t.amount > 0).reduce((s: number, t: any) => s + t.amount, 0),
            income: personal.filter((t: any) => t.amount < 0).reduce((s: number, t: any) => s + Math.abs(t.amount), 0),
          },
          pending_review: pending.length,
          flagged: flagged.length,
        })
      }

      // Accounts
      const acctsRaw = await window.api.accounts.list().catch(() => [])
      const accts: any[] = unwrap<any[]>(acctsRaw, [])
      setAccounts(Array.isArray(accts) ? accts : [])

      // Recent transactions
      const recentRaw = await window.api.transactions.getAll({ limit: 8 }).catch(() => [])
      const recent: any[] = unwrap<any[]>(recentRaw, [])
      setRecentTx(Array.isArray(recent) ? recent.slice(0, 8) : [])

      // Investment total
      const invRaw = await window.api.investments.getPortfolioSummary().catch(() => null)
      const inv = unwrap<any>(invRaw, null)
      setInvestmentTotal(inv?.total_market_value ?? 0)

    } catch (err) {
      console.error("Dashboard load error:", err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const handleRunRules = async () => {
    setRunningRules(true)
    setRulesResult(null)
    try {
      const raw = await window.api.transactions.runRulesAll()
      const result = unwrap<{ resolved: number }>(raw, { resolved: 0 })
      setRulesResult(result)
      await load()
    } catch {}
    finally { setRunningRules(false) }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      await window.api.plaid?.syncAll?.()
    } catch {}
    await load()
    setSyncing(false)
  }

  const handleSelectFile = async () => {
    const raw = await window.api.import.selectFile()
    const filePath = unwrap<string | null>(raw, null)
    if (!filePath) return
    setImportFile(filePath)
    setPreview(null)
    setImportResult(null)
    setImportError(null)
    try {
      const prevRaw = await window.api.import.preview(filePath)
      const prev = unwrap<any>(prevRaw, null)
      setPreview(prev)
    } catch (e: any) {
      setImportError("Preview failed: " + e.message)
    }
  }

  const handleRunImport = async () => {
    if (!importFile) return
    setImporting(true)
    setImportProgress("Starting import…")
    setImportResult(null)
    setImportError(null)

    // Listen for progress events
    const listener = (_e: any, data: any) => {
      setImportProgress(`${data.stage}: ${data.message} (${data.current}/${data.total})`)
    }
    ;(window as any).electron?.ipcRenderer.on("import:progress", listener)
    progressListenerRef.current = listener

    try {
      const raw = await window.api.import.run(importFile)
      const result = unwrap<any>(raw, null)
      setImportResult(result)
      setImportProgress(null)
      await load()
    } catch (e: any) {
      setImportError("Import failed: " + e.message)
      setImportProgress(null)
    } finally {
      setImporting(false)
      if (progressListenerRef.current) {
        ;(window as any).electron?.ipcRenderer.removeListener("import:progress", progressListenerRef.current)
        progressListenerRef.current = null
      }
    }
  }

  if (loading) return <div className="p-8 text-gray-500">Loading...</div>

  const b = {
    peak10: { count: buckets?.peak10?.count ?? 0, total: buckets?.peak10?.total ?? 0 },
    llc: { count: buckets?.llc?.count ?? 0, total: buckets?.llc?.total ?? 0 },
    personal: { income: buckets?.personal?.income ?? 0, expenses: buckets?.personal?.expenses ?? 0, count: buckets?.personal?.count ?? 0 },
    pending_review: buckets?.pending_review ?? 0,
    flagged: buckets?.flagged ?? 0,
  }

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-navy">Dashboard</h1>
        <div className="flex gap-2">
          <button
            onClick={handleRunRules}
            disabled={runningRules}
            className="btn btn-secondary flex items-center gap-2"
            title="Run classification rules against all pending transactions"
          >
            {runningRules ? "Running..." : "⚡ Run Rules"}
          </button>
          <button
            onClick={() => { setShowImport(v => !v); setImportResult(null); setImportError(null); setPreview(null); setImportFile(null) }}
            className="btn btn-secondary flex items-center gap-2"
          >
            📂 Import CSV
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="btn btn-primary flex items-center gap-2"
          >
            {syncing ? "Syncing..." : "🔄 Sync Now"}
          </button>
        </div>
      </div>

      {/* Run Rules result banner */}
      {rulesResult && (
        <div className="mb-4 bg-green-50 border border-green-200 rounded-lg px-4 py-2 text-sm text-green-800 flex items-center justify-between">
          <span>⚡ Rules applied — {rulesResult.resolved} transaction{rulesResult.resolved !== 1 ? 's' : ''} auto-classified.
            {rulesResult.resolved === 0 ? ' Remaining pending items need manual review.' : ''}
          </span>
          <button onClick={() => setRulesResult(null)} className="text-green-600 hover:text-green-900 ml-4">✕</button>
        </div>
      )}

      {/* Import CSV Panel */}
      {showImport && (
        <div className="card mb-6 border border-blue-200 bg-blue-50/50">
          <div className="font-semibold text-navy mb-3">📂 Import CSV</div>
          <div className="flex items-center gap-3 mb-3">
            <button onClick={handleSelectFile} className="btn btn-secondary text-sm">
              {importFile ? "Change File" : "Select CSV File"}
            </button>
            {importFile && (
              <span className="text-sm text-gray-600 truncate max-w-sm">{importFile.split(/[\\/]/).pop()}</span>
            )}
          </div>

          {preview && !importResult && (
            <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3 text-sm space-y-1">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <span className="text-gray-500">Total rows:</span><span className="font-medium">{preview.totalRows?.toLocaleString()}</span>
                <span className="text-gray-500">New transactions:</span><span className="font-medium text-green-700">{preview.newRows?.toLocaleString()}</span>
                <span className="text-gray-500">Already imported:</span><span className="font-medium">{preview.duplicates?.toLocaleString()}</span>
                <span className="text-gray-500">Date range:</span><span className="font-medium">{preview.dateRange}</span>
              </div>
              {preview.errors?.length > 0 && (
                <div className="mt-2 text-red-600 text-xs">{preview.errors.join('; ')}</div>
              )}
              <button
                onClick={handleRunImport}
                disabled={importing || !preview.columnMappingValid}
                className="btn btn-primary text-sm mt-2 w-full"
              >
                {importing ? "Importing…" : `Import ${preview.newRows?.toLocaleString()} transactions`}
              </button>
            </div>
          )}

          {importProgress && (
            <div className="text-sm text-blue-700 bg-blue-100 rounded px-3 py-2 mb-3">{importProgress}</div>
          )}

          {importResult && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm">
              <div className="font-semibold text-green-800 mb-1">✅ Import complete</div>
              <div className="text-green-700">
                {importResult.imported} imported · {importResult.classified} auto-classified · {importResult.queued} queued for review
              </div>
              {importResult.errors?.length > 0 && (
                <div className="text-orange-600 mt-1 text-xs">{importResult.errors.length} row errors</div>
              )}
              <button onClick={() => { setShowImport(false); onNavigate("review") }} className="btn btn-primary text-sm mt-2">
                Go to Review Queue →
              </button>
            </div>
          )}

          {importError && (
            <div className="text-red-600 text-sm bg-red-50 rounded px-3 py-2">{importError}</div>
          )}
        </div>
      )}

      {/* Bucket cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card border-l-4 border-brand-blue">
          <div className="text-xs font-semibold text-brand-blue uppercase mb-1">🏢 Peak 10 (W2)</div>
          <div className="text-2xl font-bold text-gray-900">{fmt(b.peak10.total)}</div>
          <div className="text-sm text-gray-500 mt-1">{b.peak10.count} transactions</div>
          <div className="text-xs text-gray-400 mt-1">Expense reimbursement pending</div>
        </div>
        <div className="card border-l-4 border-green-600">
          <div className="text-xs font-semibold text-green-700 uppercase mb-1">💼 Moonsmoke LLC</div>
          <div className="text-2xl font-bold text-gray-900">{fmt(b.llc.total)}</div>
          <div className="text-sm text-gray-500 mt-1">{b.llc.count} transactions</div>
          <div className="text-xs text-gray-400 mt-1">Schedule C</div>
        </div>
        <div className="card border-l-4 border-gray-400">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-1">🏠 Personal</div>
          <div className="text-lg font-bold text-gray-900">
            {fmt(b.personal.expenses)} <span className="text-sm font-normal text-gray-500">expenses</span>
          </div>
          <div className="text-sm text-gray-500">{fmt(b.personal.income)} income</div>
          <div className="text-xs text-gray-400 mt-1">{b.personal.count} transactions</div>
        </div>
      </div>

      {/* Review queue and investments row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div
          className="card cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => onNavigate("review")}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-orange-600 uppercase">Needs Review</div>
              <div className="text-3xl font-bold text-orange-600 mt-1">{b.pending_review}</div>
            </div>
            <div className="text-4xl">📋</div>
          </div>
          {b.flagged > 0 && (
            <div className="text-xs text-red-600 mt-2">+ {b.flagged} flagged items</div>
          )}
        </div>
        <div
          className="card cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => onNavigate("investments")}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-indigo-600 uppercase">Portfolio Value</div>
              <div className="text-2xl font-bold text-gray-900 mt-1">{fmt(investmentTotal)}</div>
            </div>
            <div className="text-4xl">📈</div>
          </div>
          <div className="text-xs text-gray-400 mt-2">Fidelity · Schwab · Chase</div>
        </div>
        <div className="card">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Accounts</div>
          {accounts.length === 0 ? (
            <div className="text-sm text-gray-400 italic">No accounts connected</div>
          ) : (
            accounts.slice(0, 4).map((a: any) => (
              <div key={a.id} className="flex items-center justify-between text-sm py-0.5">
                <span className="text-gray-700">
                  {a.institution} ···{a.account_mask}
                </span>
                <span className={`badge ${a.is_active ? "badge-classified" : "badge-personal"}`}>
                  {a.last_synced_at
                    ? new Date(a.last_synced_at).toLocaleDateString()
                    : "Never synced"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Recent activity */}
        <div className="card col-span-2">
          <div className="font-semibold text-gray-700 mb-3">Recent Activity</div>
          {recentTx.length === 0 ? (
            <div className="text-sm text-gray-400 italic">
              No transactions yet. Connect accounts or import CSV files to get started.
            </div>
          ) : (
            <div className="space-y-1">
              {recentTx.map((tx: any) => (
                <div
                  key={tx.id}
                  className="flex items-center justify-between text-sm py-0.5 border-b border-gray-50"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-gray-400 text-xs flex-shrink-0">
                      {tx.transaction_date}
                    </span>
                    <span className="text-gray-700 truncate">
                      {tx.merchant_name ?? tx.description_raw}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                    <span
                      className={`badge ${
                        tx.bucket === "Peak 10"
                          ? "badge-p10"
                          : tx.bucket === "Moonsmoke LLC"
                          ? "badge-llc"
                          : "badge-personal"
                      }`}
                    >
                      {tx.bucket || "Unclassified"}
                    </span>
                    <span className="text-gray-700 font-medium">{fmt(tx.amount)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
