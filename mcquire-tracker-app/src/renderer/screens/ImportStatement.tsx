import React, { useState } from "react"

const baseName = (p: string) => p.split(/[\\/]/).pop() || p

interface Preview { filePath: string; fileName: string; data?: any; error?: string }

export default function ImportStatement() {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [previews, setPreviews] = useState<Preview[]>([])
  const [result, setResult] = useState<string | null>(null)

  const previewPaths = async (paths: string[]) => {
    setBusy(true); setResult(null)
    const out: Preview[] = []
    for (const p of paths) {
      try {
        const r = await window.api.import.usaaPdfPreview(p)
        out.push({ filePath: p, fileName: baseName(p), data: r?.success ? r.data : undefined, error: r?.success ? undefined : (r?.error || "Couldn't read this PDF") })
      } catch (e: any) {
        out.push({ filePath: p, fileName: baseName(p), error: e?.message || "Couldn't read this PDF" })
      }
    }
    setPreviews(out); setBusy(false)
  }

  const pick = async () => {
    const r = await window.api.import.usaaPdfPick()
    if (r?.success && r.data?.length) previewPaths(r.data)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const paths = Array.from(e.dataTransfer.files).map((f: any) => f.path).filter(Boolean)
    if (paths.length) previewPaths(paths)
  }
  const doImport = async () => {
    setBusy(true); setResult(null)
    const paths = previews.filter(p => p.data).map(p => p.filePath)
    try {
      const r = await window.api.import.usaaPdfRun(paths)
      if (r?.success) {
        const d = r.data
        setResult(`Imported ${d.imported} transaction${d.imported === 1 ? "" : "s"} (${d.classified} classified, ${d.excluded} transfers/payments excluded). ${d.duplicates} were already in your data.`)
        setPreviews([])
      } else setResult(r?.error || "Import failed")
    } finally { setBusy(false) }
  }

  const importable = previews.filter(p => p.data && (p.data.newClassified + p.data.newExcluded) > 0).length

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-slate-800">Import Statement</h1>
      <p className="text-sm text-slate-500 mt-1">
        Drop a <strong>USAA checking statement PDF</strong> here. It's parsed, matched against what you
        already have (so re-imports don't duplicate), and classified. Transfers, Venmo, and card payments
        are auto-excluded; real expenses are categorized.
      </p>

      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`mt-5 border-2 border-dashed rounded-xl p-8 text-center transition-colors ${dragging ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-slate-50"}`}
      >
        <div className="text-3xl">🏦</div>
        <div className="text-sm text-slate-600 mt-2">Drag &amp; drop statement PDFs here, or</div>
        <button onClick={pick} disabled={busy}
          className="mt-3 px-4 py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-50"
          style={{ background: "#1F3864" }}>
          {busy ? "Reading…" : "Choose PDFs…"}
        </button>
      </div>

      {result && <div className="mt-3 text-sm text-slate-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{result}</div>}

      {previews.length > 0 && (
        <div className="mt-6 space-y-2">
          {previews.map(p => (
            <div key={p.filePath} className="border border-slate-200 rounded-xl p-4 bg-white">
              <div className="font-semibold text-slate-800 text-sm">{p.fileName}</div>
              {p.error ? (
                <div className="text-sm text-red-600 mt-1">⚠ {p.error}</div>
              ) : (
                <>
                  <div className="text-xs text-slate-500 mt-1">
                    {p.data.accountMask ? <>USAA …{p.data.accountMask}</> : "Unknown account"}
                    {p.data.periodStart && <> · {p.data.periodStart} → {p.data.periodEnd}</>}
                    {!p.data.accountFound && <span className="text-orange-600"> · new account (will be created)</span>}
                  </div>
                  <div className="text-sm text-slate-700 mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    <span><strong>{p.data.newClassified}</strong> new expenses</span>
                    <span><strong>{p.data.newExcluded}</strong> transfers/payments → excluded</span>
                    <span className="text-slate-500"><strong>{p.data.duplicates}</strong> already have</span>
                  </div>
                  {!p.data.reconciles && (
                    <div className="text-xs text-orange-600 mt-1">⚠ Parsed totals didn't match the statement's summary — review after import.</div>
                  )}
                </>
              )}
            </div>
          ))}
          <button onClick={doImport} disabled={busy || importable === 0}
            className="mt-2 px-5 py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-40"
            style={{ background: "#2E75B6" }}>
            {busy ? "Importing…" : `Import ${importable} statement${importable === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  )
}
