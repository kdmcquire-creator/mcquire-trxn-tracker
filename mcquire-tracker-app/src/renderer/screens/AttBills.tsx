import React, { useState, useEffect, useCallback } from "react"

interface AttBill {
  id: string; account_number: string; issue_date: string; autopay_date: string | null
  bill_total: number; line_0468: number; status: string; matched_txn_id: string | null
}
interface Candidate { id: string; amount: number; date: string; description: string }

const fmt = (n: number) => "$" + (n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const monthLabel = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" })

function summarize(results: any[]): string {
  const c = (o: string) => results.filter(r => r.outcome === o).length
  const parts: string[] = []
  if (c("split")) parts.push(`${c("split")} split automatically`)
  if (c("pending")) parts.push(`${c("pending")} waiting for the charge to post`)
  if (c("review")) parts.push(`${c("review")} need a quick confirm`)
  if (c("duplicate-upload")) parts.push(`${c("duplicate-upload")} already uploaded`)
  const bad = results.filter(r => r.outcome === "unparsed" || r.outcome === "error").length
  if (bad) parts.push(`${bad} couldn't be read`)
  return parts.join(" · ") || "Nothing to process"
}

function StatusBadge({ status }: { status: string }) {
  const cls = "text-xs font-semibold rounded-full px-2.5 py-0.5"
  if (status === "split") return <span className={`${cls} text-green-700 bg-green-100`}>✓ Split</span>
  if (status === "review") return <span className={`${cls} text-orange-700 bg-orange-100`}>⚠ Needs confirm</span>
  return <span className={`${cls} text-slate-600 bg-slate-100`}>⏳ Waiting for charge</span>
}

export default function AttBills() {
  const [bills, setBills] = useState<AttBill[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Record<string, Candidate[]>>({})

  const refresh = useCallback(() => {
    window.api?.attBills?.list?.().then((r: any) => setBills(r?.data ?? [])).catch(() => {})
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const handleResults = (r: any) => { setMsg(summarize(r?.data ?? [])); refresh() }

  const pick = async () => {
    setBusy(true); setMsg(null)
    try { handleResults(await window.api.attBills.pick()) } finally { setBusy(false) }
  }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const paths = Array.from(e.dataTransfer.files).map((f: any) => f.path).filter(Boolean)
    if (!paths.length) return
    setBusy(true); setMsg(null)
    try { handleResults(await window.api.attBills.importPaths(paths)) } finally { setBusy(false) }
  }
  const loadCandidates = async (billId: string) => {
    const r = await window.api.attBills.reviewCandidates(billId)
    setCandidates(prev => ({ ...prev, [billId]: r?.data ?? [] }))
  }
  const confirm = async (billId: string, chargeId: string) => {
    await window.api.attBills.confirm(billId, chargeId); refresh()
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-slate-800">AT&amp;T Bills</h1>
      <p className="text-sm text-slate-500 mt-1">
        Upload your AT&amp;T bill PDFs. The <strong>832-687-0468</strong> line is applied to
        <strong> Peak 10 / Telephone &amp; Communication</strong>; the rest to <strong>Personal</strong> — split
        onto the matching autopay charge automatically. A bill uploaded before its charge posts waits and
        applies itself later.
      </p>

      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`mt-5 border-2 border-dashed rounded-xl p-8 text-center transition-colors ${dragging ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-slate-50"}`}
      >
        <div className="text-3xl">📄</div>
        <div className="text-sm text-slate-600 mt-2">Drag &amp; drop bill PDFs here, or</div>
        <button onClick={pick} disabled={busy}
          className="mt-3 px-4 py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-50"
          style={{ background: "#1F3864" }}>
          {busy ? "Processing…" : "Choose PDFs…"}
        </button>
      </div>

      {msg && <div className="mt-3 text-sm text-slate-700 bg-slate-100 rounded-lg px-3 py-2">{msg}</div>}

      <div className="mt-6 space-y-2">
        {bills.map(b => {
          const remainder = Math.round((b.bill_total - b.line_0468) * 100) / 100
          return (
            <div key={b.id} className="border border-slate-200 rounded-xl p-4 bg-white">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-800">{monthLabel(b.issue_date)} — {fmt(b.bill_total)}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    0468 → Peak 10: <strong>{fmt(b.line_0468)}</strong> · rest → Personal: <strong>{fmt(remainder)}</strong>
                  </div>
                </div>
                <StatusBadge status={b.status} />
              </div>

              {b.status === "review" && (
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <div className="text-xs text-slate-500 mb-1">Couldn't auto-pick the charge. Choose the right one:</div>
                  {(candidates[b.id] ?? []).length === 0 ? (
                    <button onClick={() => loadCandidates(b.id)} className="text-xs text-blue-600 hover:text-blue-800">Show matching charges…</button>
                  ) : (
                    (candidates[b.id] ?? []).map(c => (
                      <div key={c.id} className="flex items-center justify-between text-xs mt-1.5">
                        <span className="text-slate-600">{c.date} · {fmt(c.amount)} · {c.description.slice(0, 44)}</span>
                        <button onClick={() => confirm(b.id, c.id)}
                          className="ml-2 px-2 py-1 rounded bg-blue-600 text-white font-semibold hover:bg-blue-700">Use this → split</button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )
        })}
        {bills.length === 0 && <div className="text-sm text-slate-400 py-4">No bills uploaded yet.</div>}
      </div>
    </div>
  )
}
