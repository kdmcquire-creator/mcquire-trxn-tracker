import { useEffect, useState, useCallback } from "react"
import { P10_CATEGORIES, LLC_CATEGORIES } from "../../shared/types"

function unwrap<T>(res: any, fallback: T): T {
  if (res === null || res === undefined) return fallback
  if (typeof res === "object" && "data" in res) return (res.data as T) ?? fallback
  return (res as T) ?? fallback
}

const BUCKETS = ["Peak 10", "Moonsmoke LLC", "Personal", "Exclude"]
const STATUSES = ["auto_classified", "manually_classified", "pending_review", "flagged"]

const bucketColor: Record<string, string> = {
  "Peak 10": "bg-blue-100 text-blue-800",
  "Moonsmoke LLC": "bg-green-100 text-green-700",
  Personal: "bg-gray-100 text-gray-600",
  Exclude: "bg-red-100 text-red-600",
}
const statusColor: Record<string, string> = {
  pending_review: "text-orange-600",
  flagged: "text-red-600",
  auto_classified: "text-green-600",
  manually_classified: "text-slate-500",
}

const fmt = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (s: string) => {
  if (!s) return ""
  const d = new Date(s + "T00:00:00")
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" })
}

export default function Transactions() {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editRow, setEditRow] = useState<any | null>(null)
  const [editState, setEditState] = useState<any>({})
  const [saving, setSaving] = useState(false)

  // Filters
  const [search, setSearch] = useState("")
  const [filterBucket, setFilterBucket] = useState("")
  const [filterStatus, setFilterStatus] = useState("")
  const [filterAccount, _setFilterAccount] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [sortBy, setSortBy] = useState<"date" | "amount" | "merchant">("date")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 100

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const raw = await window.api.transactions.getAll().catch(() => [])
      setRows(unwrap<any[]>(raw, []))
    } catch (e: any) {
      setError("Failed to load: " + (e?.message ?? "unknown"))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Filtering + sorting
  const filtered = rows
    .filter(t => {
      if (filterBucket && t.bucket !== filterBucket) return false
      if (filterStatus && t.review_status !== filterStatus) return false
      if (filterAccount && !String(t.account_mask ?? "").includes(filterAccount)) return false
      if (dateFrom && t.transaction_date < dateFrom) return false
      if (dateTo && t.transaction_date > dateTo) return false
      if (search) {
        const q = search.toLowerCase()
        if (!String(t.merchant_name ?? "").toLowerCase().includes(q) &&
            !String(t.description_raw ?? "").toLowerCase().includes(q) &&
            !String(t.description_notes ?? "").toLowerCase().includes(q)) return false
      }
      return true
    })
    .sort((a, b) => {
      let v = 0
      if (sortBy === "date") v = (a.transaction_date ?? "").localeCompare(b.transaction_date ?? "")
      if (sortBy === "amount") v = (a.amount ?? 0) - (b.amount ?? 0)
      if (sortBy === "merchant") v = (a.merchant_name ?? "").localeCompare(b.merchant_name ?? "")
      return sortDir === "asc" ? v : -v
    })

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const totalAmount = filtered.reduce((s, t) => s + (t.amount ?? 0), 0)

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc")
    else { setSortBy(col); setSortDir("desc") }
  }

  const openEdit = (tx: any) => {
    setEditRow(tx)
    setEditState({
      bucket: tx.bucket ?? "",
      category: tx.p10_category || tx.llc_category || "",
      notes: tx.description_notes ?? "",
      review_status: tx.review_status ?? "",
    })
  }

  const saveEdit = async () => {
    if (!editRow) return
    setSaving(true)
    try {
      const update: any = {
        bucket: editState.bucket,
        review_status: "manually_classified",
        description_notes: editState.notes,
      }
      if (editState.bucket === "Peak 10") update.p10_category = editState.category
      if (editState.bucket === "Moonsmoke LLC") update.llc_category = editState.category
      await window.api.transactions.classify(editRow.id, update)
      setRows(prev => prev.map(r => r.id === editRow.id ? { ...r, ...update } : r))
      setEditRow(null)
    } catch (e: any) {
      alert("Save error: " + (e?.message ?? "unknown"))
    } finally {
      setSaving(false)
    }
  }

  const exportCSV = () => {
    const headers = ["Date", "Account", "Merchant", "Bucket", "Category", "Amount", "Notes", "Status"]
    const rows2 = filtered.map(t => [
      t.transaction_date, t.account_mask ?? "", t.merchant_name ?? t.description_raw ?? "",
      t.bucket ?? "", t.p10_category || t.llc_category || "",
      t.amount?.toFixed(2) ?? "", t.description_notes ?? "", t.review_status ?? ""
    ])
    const csv = [headers, ...rows2].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a"); a.href = url; a.download = "mcquire_transactions.csv"; a.click()
    URL.revokeObjectURL(url)
  }

  const SortIcon = ({ col }: { col: typeof sortBy }) =>
    sortBy === col ? <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span> : <span className="ml-1 text-slate-300">↕</span>

  if (loading) return <div className="p-8 text-gray-500">Loading transactions...</div>
  if (error) return <div className="p-8 text-red-600">{error} <button onClick={load} className="underline ml-2">Retry</button></div>

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">All Transactions</h1>
          <p className="text-sm text-slate-500 mt-1">
            {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} transactions
            &nbsp;·&nbsp;
            <span className={totalAmount < 0 ? "text-green-600" : "text-slate-700"}>
              Total: {totalAmount < 0 ? "+" : ""}{fmt(totalAmount)}
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="px-3 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50">Refresh</button>
          <button onClick={exportCSV} className="px-3 py-2 bg-slate-700 text-white text-sm rounded-lg hover:bg-slate-800">Export CSV</button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <input
          type="text" placeholder="Search merchant..." value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
          className="col-span-2 border border-slate-300 rounded-lg px-3 py-2 text-sm"
        />
        <select value={filterBucket} onChange={e => { setFilterBucket(e.target.value); setPage(1) }}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm">
          <option value="">All buckets</option>
          {BUCKETS.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1) }}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm">
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1) }}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm" title="From date" />
        <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1) }}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm" title="To date" />
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 text-slate-600 cursor-pointer whitespace-nowrap" onClick={() => toggleSort("date")}>
                  Date <SortIcon col="date" />
                </th>
                <th className="text-left px-4 py-3 text-slate-600">Account</th>
                <th className="text-left px-4 py-3 text-slate-600 cursor-pointer" onClick={() => toggleSort("merchant")}>
                  Merchant <SortIcon col="merchant" />
                </th>
                <th className="text-left px-4 py-3 text-slate-600">Bucket</th>
                <th className="text-left px-4 py-3 text-slate-600">Category</th>
                <th className="text-right px-4 py-3 text-slate-600 cursor-pointer" onClick={() => toggleSort("amount")}>
                  Amount <SortIcon col="amount" />
                </th>
                <th className="text-left px-4 py-3 text-slate-600">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paginated.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No transactions match filters</td></tr>
              )}
              {paginated.map(tx => (
                <tr key={tx.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-2 whitespace-nowrap text-slate-600">{fmtDate(tx.transaction_date)}</td>
                  <td className="px-4 py-2 text-slate-500 whitespace-nowrap">···{tx.account_mask ?? ""}</td>
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-800 truncate max-w-xs">
                      {tx.merchant_name || tx.description_raw || "—"}
                    </div>
                    {tx.description_notes && (
                      <div className="text-xs text-slate-400 truncate max-w-xs">{tx.description_notes}</div>
                    )}
                    {tx.flag_reason && (
                      <div className="text-xs text-red-500">⚠️ {tx.flag_reason}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {tx.bucket && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${bucketColor[tx.bucket] ?? "bg-gray-100 text-gray-600"}`}>
                        {tx.bucket}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-500 text-xs max-w-[140px] truncate">
                    {tx.p10_category || tx.llc_category || ""}
                  </td>
                  <td className={`px-4 py-2 text-right font-medium whitespace-nowrap ${tx.amount < 0 ? "text-green-600" : "text-slate-800"}`}>
                    {tx.amount < 0 ? "+" : ""}{fmt(tx.amount)}
                  </td>
                  <td className={`px-4 py-2 text-xs whitespace-nowrap ${statusColor[tx.review_status] ?? "text-slate-400"}`}>
                    {(tx.review_status ?? "").replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => openEdit(tx)}
                      className="text-blue-600 hover:text-blue-800 text-xs font-medium"
                    >Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="border-t border-slate-100 px-4 py-3 flex items-center justify-between text-sm text-slate-600">
            <span>Page {page} of {totalPages} · {filtered.length.toLocaleString()} rows</span>
            <div className="flex gap-2">
              <button onClick={() => setPage(1)} disabled={page === 1} className="px-2 py-1 border rounded disabled:opacity-40">«</button>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-2 py-1 border rounded disabled:opacity-40">‹</button>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-2 py-1 border rounded disabled:opacity-40">›</button>
              <button onClick={() => setPage(totalPages)} disabled={page === totalPages} className="px-2 py-1 border rounded disabled:opacity-40">»</button>
            </div>
          </div>
        )}
      </div>

      {/* Edit Drawer / Modal */}
      {editRow && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-800">Edit Transaction</h2>
              <button onClick={() => setEditRow(null)} className="text-slate-400 hover:text-slate-600 text-xl">✕</button>
            </div>
            <div className="text-sm text-slate-600 mb-4">
              <div className="font-medium text-slate-800">{editRow.merchant_name || editRow.description_raw}</div>
              <div>{fmtDate(editRow.transaction_date)} · {fmt(editRow.amount)}</div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">Bucket</label>
                <select value={editState.bucket} onChange={e => setEditState((s: any) => ({ ...s, bucket: e.target.value, category: "" }))}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
                  <option value="">— Select —</option>
                  {BUCKETS.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>

              {editState.bucket === "Peak 10" && (
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">P10 Category</label>
                  <select value={editState.category} onChange={e => setEditState((s: any) => ({ ...s, category: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">— Select —</option>
                    {P10_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}

              {editState.bucket === "Moonsmoke LLC" && (
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">LLC Category</label>
                  <select value={editState.category} onChange={e => setEditState((s: any) => ({ ...s, category: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
                    <option value="">— Select —</option>
                    {LLC_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}

              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase block mb-1">Description / Notes</label>
                <input type="text" value={editState.notes} onChange={e => setEditState((s: any) => ({ ...s, notes: e.target.value }))}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>

            <div className="flex gap-3 mt-5">
              <button onClick={() => setEditRow(null)} className="flex-1 py-2 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">Cancel</button>
              <button onClick={saveEdit} disabled={saving} className="flex-1 py-2 bg-slate-800 text-white rounded-lg text-sm hover:bg-slate-900 disabled:opacity-50">
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
