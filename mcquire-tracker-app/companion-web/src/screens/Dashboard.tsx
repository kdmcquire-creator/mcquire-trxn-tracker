import { useEffect, useState } from 'react'
import { api } from '../api'

const fmt = (n: number) =>
  `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

interface Props {
  onNavigate: (screen: 'dashboard' | 'review') => void
  onReviewCountUpdate: (count: number) => void
}

export default function Dashboard({ onNavigate, onReviewCountUpdate }: Props) {
  const [data, setData] = useState<{
    buckets: Record<string, { total: number; count: number }>
    reviewCount: number
    flaggedCount: number
    recentTx: any[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [runningRules, setRunningRules] = useState(false)
  const [rulesResult, setRulesResult] = useState<number | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await api.getDashboard()
      setData(res.data)
      onReviewCountUpdate(res.data.reviewCount)
    } catch (err) {
      console.error('Dashboard load error:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleRunRules = async () => {
    setRunningRules(true)
    setRulesResult(null)
    try {
      const res = await api.runRules()
      setRulesResult(res.resolved)
      await load()
    } catch {} finally {
      setRunningRules(false)
    }
  }

  if (loading) {
    return <div className="p-6 text-slate-400 text-center mt-12">Loading...</div>
  }

  if (!data) {
    return (
      <div className="p-6 text-center mt-12">
        <p className="text-red-500 mb-3">Failed to load dashboard</p>
        <button onClick={load} className="text-blue-600 underline">Retry</button>
      </div>
    )
  }

  const p10 = data.buckets['Peak 10'] ?? { total: 0, count: 0 }
  const llc = data.buckets['Moonsmoke LLC'] ?? { total: 0, count: 0 }
  const personal = data.buckets['Personal'] ?? { total: 0, count: 0 }

  return (
    <div className="p-4 space-y-4">
      {/* Rules result banner */}
      {rulesResult !== null && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-800 flex items-center justify-between">
          <span>{rulesResult} transaction{rulesResult !== 1 ? 's' : ''} auto-classified</span>
          <button onClick={() => setRulesResult(null)} className="text-green-600 ml-2 font-bold">X</button>
        </div>
      )}

      {/* Review queue alert */}
      {data.reviewCount > 0 && (
        <button
          onClick={() => onNavigate('review')}
          className="w-full bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-center justify-between active:bg-orange-100"
        >
          <div className="text-left">
            <div className="text-sm font-semibold text-orange-700">Needs Review</div>
            <div className="text-2xl font-bold text-orange-600">{data.reviewCount}</div>
            {data.flaggedCount > 0 && (
              <div className="text-xs text-red-600 mt-0.5">+ {data.flaggedCount} flagged</div>
            )}
          </div>
          <div className="text-3xl">📋</div>
        </button>
      )}

      {/* Bucket cards */}
      <div className="space-y-3">
        <div className="bg-white rounded-xl border border-slate-200 p-4 border-l-4 border-l-blue-500">
          <div className="text-xs font-semibold text-blue-600 uppercase">Peak 10 (W2)</div>
          <div className="text-2xl font-bold mt-1">{fmt(p10.total)}</div>
          <div className="text-xs text-slate-400 mt-0.5">{p10.count} transactions</div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 border-l-4 border-l-green-500">
          <div className="text-xs font-semibold text-green-600 uppercase">Moonsmoke LLC</div>
          <div className="text-2xl font-bold mt-1">{fmt(llc.total)}</div>
          <div className="text-xs text-slate-400 mt-0.5">{llc.count} transactions</div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 border-l-4 border-l-slate-400">
          <div className="text-xs font-semibold text-slate-500 uppercase">Personal</div>
          <div className="text-2xl font-bold mt-1">{fmt(personal.total)}</div>
          <div className="text-xs text-slate-400 mt-0.5">{personal.count} transactions</div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleRunRules}
          disabled={runningRules}
          className="flex-1 py-3 bg-slate-700 text-white text-sm font-medium rounded-xl active:bg-slate-800 disabled:opacity-50"
        >
          {runningRules ? 'Running...' : 'Run Rules'}
        </button>
        <button
          onClick={load}
          className="flex-1 py-3 bg-blue-600 text-white text-sm font-medium rounded-xl active:bg-blue-700"
        >
          Refresh
        </button>
      </div>

      {/* Recent transactions */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="text-sm font-semibold text-slate-700 mb-3">Recent Activity</div>
        {data.recentTx.length === 0 ? (
          <div className="text-sm text-slate-400 italic">No transactions yet</div>
        ) : (
          <div className="space-y-2">
            {data.recentTx.map((tx: any) => (
              <div key={tx.id} className="flex items-center justify-between text-sm py-1 border-b border-slate-50 last:border-0">
                <div className="min-w-0 flex-1 mr-3">
                  <div className="text-slate-700 truncate text-sm">
                    {tx.merchant_name ?? tx.description_raw}
                  </div>
                  <div className="text-xs text-slate-400 flex gap-2 mt-0.5">
                    <span>{tx.transaction_date}</span>
                    {tx.bucket && (
                      <span className={`px-1.5 py-0 rounded text-[10px] font-medium ${
                        tx.bucket === 'Peak 10' ? 'bg-blue-50 text-blue-700' :
                        tx.bucket === 'Moonsmoke LLC' ? 'bg-green-50 text-green-700' :
                        'bg-slate-100 text-slate-600'
                      }`}>
                        {tx.bucket}
                      </span>
                    )}
                  </div>
                </div>
                <div className={`font-semibold shrink-0 ${tx.amount < 0 ? 'text-green-600' : 'text-slate-800'}`}>
                  {tx.amount < 0 ? '-' : ''}{fmt(tx.amount)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
