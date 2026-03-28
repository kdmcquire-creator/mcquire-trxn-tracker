import { useEffect, useState, useCallback } from "react"

function unwrap<T>(res: any, fallback: T): T {
  if (res === null || res === undefined) return fallback
  if (typeof res === "object" && "data" in res) return (res.data as T) ?? fallback
  return (res as T) ?? fallback
}

const fmt = (n: number, decimals = 2) =>
  n == null ? "—" : `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`

const fmtPct = (n: number) =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`

const fmtDate = (s: string) => {
  if (!s) return ""
  const d = new Date(s + "T00:00:00")
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export default function Investments() {
  const [summary, setSummary] = useState<any>(null)
  const [holdings, setHoldings] = useState<any[]>([])
  const [investTx, setInvestTx] = useState<any[]>([])
  const [accounts, setAccounts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<"holdings" | "transactions">("holdings")
  const [filterAccount, setFilterAccount] = useState("")
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [sumRaw, holdRaw, txRaw, acctRaw] = await Promise.all([
        window.api.investments.getPortfolioSummary().catch(() => null),
        window.api.investments.getHoldings().catch(() => []),
        window.api.investments.getTransactions().catch(() => []),
        window.api.accounts.list().catch(() => []),
      ])
      setSummary(unwrap<any>(sumRaw, null))
      setHoldings(unwrap<any[]>(holdRaw, []))
      setInvestTx(unwrap<any[]>(txRaw, []))
      const accts: any[] = unwrap<any[]>(acctRaw, [])
      setAccounts(accts.filter((a: any) =>
        a.account_type === "investment" || a.account_type === "brokerage"
      ))
    } catch (e: any) {
      setError("Failed to load investment data: " + (e?.message ?? "unknown"))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSync = async () => {
    setSyncing(true)
    try {
      await window.api.investments.syncAll().catch(() => {})
    } catch {}
    await load()
    setSyncing(false)
  }

  const filteredHoldings = filterAccount
    ? holdings.filter(h => h.account_id === filterAccount || String(h.account_mask ?? "").includes(filterAccount))
    : holdings

  const filteredTx = filterAccount
    ? investTx.filter(t => t.account_id === filterAccount || String(t.account_mask ?? "").includes(filterAccount))
    : investTx

  const totalValue = summary?.total_market_value ?? holdings.reduce((s, h) => s + (h.market_value ?? 0), 0)
  const totalCostBasis = holdings.reduce((s, h) => s + (h.cost_basis ?? 0), 0)
  const totalGainLoss = totalCostBasis ? totalValue - totalCostBasis : null
  const totalGainLossPct = totalCostBasis ? (totalGainLoss! / totalCostBasis) * 100 : null

  if (loading) return <div className="p-8 text-gray-500">Loading investment data...</div>
  if (error) return (
    <div className="p-8">
      <div className="text-red-600 mb-3">{error}</div>
      <button onClick={load} className="text-blue-600 underline text-sm">Retry</button>
    </div>
  )

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Investment Portfolio</h1>
          <p className="text-sm text-slate-500 mt-1">
            Fidelity, Schwab, Chase Brokerage · via Plaid
            {summary?.as_of_date && <span> · as of {fmtDate(summary.as_of_date)}</span>}
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {syncing ? "Syncing..." : "Sync Now"}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold">Total Portfolio Value</p>
          <p className="text-3xl font-bold text-slate-800 mt-1">{fmt(totalValue)}</p>
          {totalGainLossPct != null && (
            <p className={`text-sm mt-1 ${totalGainLoss! >= 0 ? "text-green-600" : "text-red-600"}`}>
              {fmtPct(totalGainLossPct)} {totalGainLoss! >= 0 ? "▲" : "▼"} {fmt(Math.abs(totalGainLoss!))} gain/loss
            </p>
          )}
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold">Accounts</p>
          <p className="text-3xl font-bold text-slate-800 mt-1">{accounts.length || "—"}</p>
          <p className="text-sm text-slate-500 mt-1">Brokerage accounts connected</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold">Holdings</p>
          <p className="text-3xl font-bold text-slate-800 mt-1">{holdings.length}</p>
          <p className="text-sm text-slate-500 mt-1">Positions across all accounts</p>
        </div>
      </div>

      {/* CPA warning */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-5 text-sm text-amber-800">
        ⚠️ <strong>CPA Review Required:</strong> Investment balances and cost basis from Plaid should be verified against brokerage statements before use in tax calculations.
      </div>

      {/* Account filter */}
      {accounts.length > 0 && (
        <div className="mb-4 flex items-center gap-3">
          <label className="text-sm text-slate-600">Filter by account:</label>
          <select
            value={filterAccount}
            onChange={e => setFilterAccount(e.target.value)}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All accounts</option>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.institution} ···{a.account_mask}</option>
            ))}
          </select>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-slate-200 mb-4">
        {(["holdings", "transactions"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2.5 text-sm font-medium transition-colors ${
              tab === t
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t === "holdings" ? `Holdings (${filteredHoldings.length})` : `Transactions (${filteredTx.length})`}
          </button>
        ))}
      </div>

      {/* Holdings table */}
      {tab === "holdings" && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {filteredHoldings.length === 0 ? (
            <div className="p-8 text-center text-slate-400">
              <div className="text-4xl mb-3">📈</div>
              <p className="font-medium text-slate-600">No holdings data</p>
              <p className="text-sm mt-1">Connect Fidelity, Schwab, or Chase Brokerage via Plaid in Settings → Account Management, then sync.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-3 text-slate-600">Security</th>
                  <th className="text-left px-4 py-3 text-slate-600">Ticker</th>
                  <th className="text-right px-4 py-3 text-slate-600">Qty</th>
                  <th className="text-right px-4 py-3 text-slate-600">Price</th>
                  <th className="text-right px-4 py-3 text-slate-600">Market Value</th>
                  <th className="text-right px-4 py-3 text-slate-600">Cost Basis</th>
                  <th className="text-right px-4 py-3 text-slate-600">Gain/Loss</th>
                  <th className="text-left px-4 py-3 text-slate-600">Account</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredHoldings.map((h, i) => {
                  const gl = h.cost_basis ? (h.market_value ?? 0) - h.cost_basis : null
                  const glPct = h.cost_basis ? (gl! / h.cost_basis) * 100 : null
                  return (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-800 max-w-[200px] truncate">{h.security_name || "—"}</td>
                      <td className="px-4 py-3 text-slate-600">{h.ticker || "—"}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{h.quantity?.toFixed(4) ?? "—"}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{h.price ? fmt(h.price) : "—"}</td>
                      <td className="px-4 py-3 text-right font-medium text-slate-800">{h.market_value ? fmt(h.market_value) : "—"}</td>
                      <td className="px-4 py-3 text-right text-slate-500">
                        {h.cost_basis ? fmt(h.cost_basis) : <span className="text-amber-500">⚠️ N/A</span>}
                      </td>
                      <td className={`px-4 py-3 text-right ${gl == null ? "text-slate-400" : gl >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {gl == null ? "—" : `${gl >= 0 ? "+" : ""}${fmt(gl)} (${fmtPct(glPct!)})`}
                      </td>
                      <td className="px-4 py-3 text-slate-500 text-xs">···{h.account_mask ?? h.account_id?.slice(-4) ?? ""}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="bg-slate-50 border-t border-slate-200">
                <tr>
                  <td colSpan={4} className="px-4 py-3 font-semibold text-slate-700">Total</td>
                  <td className="px-4 py-3 text-right font-bold text-slate-800">{fmt(totalValue)}</td>
                  <td className="px-4 py-3 text-right font-medium text-slate-600">{totalCostBasis ? fmt(totalCostBasis) : "—"}</td>
                  <td className={`px-4 py-3 text-right font-medium ${totalGainLoss == null ? "text-slate-400" : totalGainLoss >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {totalGainLoss == null ? "—" : `${totalGainLoss >= 0 ? "+" : ""}${fmt(totalGainLoss)}`}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}

      {/* Investment transactions */}
      {tab === "transactions" && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {filteredTx.length === 0 ? (
            <div className="p-8 text-center text-slate-400">No investment transaction history yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-3 text-slate-600">Date</th>
                  <th className="text-left px-4 py-3 text-slate-600">Type</th>
                  <th className="text-left px-4 py-3 text-slate-600">Security</th>
                  <th className="text-right px-4 py-3 text-slate-600">Qty</th>
                  <th className="text-right px-4 py-3 text-slate-600">Amount</th>
                  <th className="text-left px-4 py-3 text-slate-600">Account</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredTx.slice(0, 200).map((t, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    <td className="px-4 py-2 text-slate-600 whitespace-nowrap">{fmtDate(t.transaction_date ?? t.date)}</td>
                    <td className="px-4 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        t.transaction_type === "buy" ? "bg-green-100 text-green-700"
                        : t.transaction_type === "sell" ? "bg-red-100 text-red-700"
                        : t.transaction_type === "dividend" ? "bg-blue-100 text-blue-700"
                        : "bg-gray-100 text-gray-600"
                      }`}>
                        {t.transaction_type ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-800 max-w-[200px] truncate">{t.security_name || t.ticker || "—"}</td>
                    <td className="px-4 py-2 text-right text-slate-600">{t.quantity?.toFixed(4) ?? "—"}</td>
                    <td className={`px-4 py-2 text-right font-medium ${(t.transaction_amount ?? 0) < 0 ? "text-green-600" : "text-slate-800"}`}>
                      {t.transaction_amount != null ? fmt(t.transaction_amount) : "—"}
                    </td>
                    <td className="px-4 py-2 text-slate-500 text-xs">···{t.account_mask ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
