import { useEffect, useState, useCallback } from 'react'
import { api } from '../api'

const P10_CATEGORIES = [
  'Office Supplies/Equipment', 'Telephone & Communication', 'Computer/Internet',
  'Printing & Reproduction', 'Postage & Delivery', 'D&O insurance',
  'Dues & Subscriptions', 'Meals & Meetings - internal', 'Meals & Meetings - external',
  'Meals & Meetings - internal and external mixed attendees', 'Parking', 'Lodging',
  'Travel', 'Sponsorships/Memberships', 'Rent', 'Salary', 'Legal', 'Insurance',
  'Office furniture and other assets', 'Other',
] as const

const LLC_CATEGORIES = [
  'Rent - Business Lodging', 'Lodging - Business Housing', 'Utilities - Home Office',
  'Executive Wellness', 'Payroll - Salary', 'Business Services - Payroll',
  'Business Services - Software', 'Business Services - Other', 'Telephone - Business Line',
  'Bank Fees', 'Taxes - Payroll', 'Meals & Entertainment', 'Travel', 'Office Expenses',
  'Business Expenses - Other',
] as const

const bucketColors: Record<string, string> = {
  'Peak 10': 'bg-blue-100 text-blue-800',
  'Moonsmoke LLC': 'bg-green-100 text-green-800',
  Personal: 'bg-slate-100 text-slate-700',
  Exclude: 'bg-red-100 text-red-700',
}

const fmt = (n: number) =>
  `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (s: string) => {
  if (!s) return ''
  const d = new Date(s + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

interface Props {
  onPendingChange?: (count: number) => void
}

export default function ReviewQueue({ onPendingChange }: Props) {
  const [transactions, setTransactions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [classifyState, setClassifyState] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending_review' | 'flagged'>('all')
  const [splitState, setSplitState] = useState<Record<string, { a1: string; a2: string; show: boolean }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.getPending()
      setTransactions(res.data)
      onPendingChange?.(res.data.length)
    } catch (err) {
      console.error('Review load error:', err)
    } finally {
      setLoading(false)
    }
  }, [onPendingChange])

  useEffect(() => { load() }, [load])

  const visible = transactions.filter(t =>
    filterStatus === 'all' ? true : t.review_status === filterStatus
  )

  const getCs = (id: string) => classifyState[id] ?? {}
  const setCs = (id: string, patch: any) =>
    setClassifyState(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }))

  const getSplit = (id: string) => splitState[id] ?? { a1: '', a2: '', show: false }
  const setSplit = (id: string, patch: any) =>
    setSplitState(prev => ({ ...prev, [id]: { ...getSplit(id), ...patch } }))

  const handleClassify = async (tx: any) => {
    const cs = getCs(tx.id)
    if (!cs.bucket) return
    setSaving(prev => ({ ...prev, [tx.id]: true }))
    try {
      const update: any = {
        bucket: cs.bucket,
        review_status: 'manually_classified',
        description_notes: cs.notes ?? tx.description_notes ?? '',
      }
      if (cs.bucket === 'Peak 10') update.p10_category = cs.category ?? ''
      if (cs.bucket === 'Moonsmoke LLC') update.llc_category = cs.category ?? ''
      await api.classify(tx.id, update)
      setTransactions(prev => prev.filter(t => t.id !== tx.id))
      setExpandedId(null)
      onPendingChange?.(transactions.length - 1)
    } catch (e: any) {
      alert('Error: ' + (e?.message ?? 'unknown'))
    } finally {
      setSaving(prev => ({ ...prev, [tx.id]: false }))
    }
  }

  const handleSplit = async (tx: any) => {
    const sp = getSplit(tx.id)
    const a1 = parseFloat(sp.a1)
    const a2 = parseFloat(sp.a2)
    if (isNaN(a1) || isNaN(a2)) { alert('Enter valid amounts for both fragments.'); return }
    const cs = getCs(tx.id)
    setSaving(prev => ({ ...prev, [tx.id]: true }))
    try {
      await api.split(tx.id, [
        { amount: a1, bucket: cs.bucket ?? 'Peak 10', category: cs.category, notes: cs.notes ?? '' },
        { amount: a2, bucket: cs.splitBucket ?? 'Personal', notes: cs.splitNotes ?? '' },
      ])
      setTransactions(prev => prev.filter(t => t.id !== tx.id))
      setExpandedId(null)
      onPendingChange?.(transactions.length - 1)
    } catch (e: any) {
      alert('Split error: ' + (e?.message ?? 'unknown'))
    } finally {
      setSaving(prev => ({ ...prev, [tx.id]: false }))
    }
  }

  if (loading) {
    return <div className="p-6 text-slate-400 text-center mt-12">Loading review queue...</div>
  }

  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Review Queue</h2>
          <p className="text-xs text-slate-400">{visible.length} item{visible.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-2">
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value as any)}
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs text-slate-600"
          >
            <option value="all">All ({transactions.length})</option>
            <option value="pending_review">Pending ({transactions.filter(t => t.review_status === 'pending_review').length})</option>
            <option value="flagged">Flagged ({transactions.filter(t => t.review_status === 'flagged').length})</option>
          </select>
          <button onClick={load} className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg active:bg-blue-700">
            Refresh
          </button>
        </div>
      </div>

      {visible.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-6 text-center">
          <div className="text-3xl mb-2">✅</div>
          <p className="text-green-800 font-medium">Queue is clear</p>
          <p className="text-green-600 text-xs mt-1">All transactions classified.</p>
        </div>
      )}

      {/* Transaction cards */}
      {visible.map(tx => {
        const cs = getCs(tx.id)
        const sp = getSplit(tx.id)
        const isExpanded = expandedId === tx.id
        const isSaving = saving[tx.id]
        const borderColor = tx.review_status === 'flagged' ? 'border-l-red-500' : 'border-l-orange-400'

        return (
          <div key={tx.id} className={`bg-white rounded-xl border border-slate-200 border-l-4 ${borderColor} shadow-sm`}>
            {/* Card header — tap to expand */}
            <button
              className="w-full p-3 text-left flex items-start gap-2"
              onClick={() => setExpandedId(isExpanded ? null : tx.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-sm text-slate-800 truncate">
                    {tx.merchant_name || tx.description_raw || 'Unknown'}
                  </span>
                  {tx.review_status === 'flagged' && (
                    <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium">Flagged</span>
                  )}
                  {tx.bucket && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${bucketColors[tx.bucket] ?? 'bg-slate-100'}`}>
                      {tx.bucket}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-400 mt-0.5 flex gap-2">
                  <span>{fmtDate(tx.transaction_date)}</span>
                  <span>{tx.account_mask ? `···${tx.account_mask}` : ''}</span>
                </div>
                {tx.flag_reason && (
                  <div className="text-xs text-red-500 mt-1 italic truncate">{tx.flag_reason}</div>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className={`font-bold text-base ${tx.amount < 0 ? 'text-green-600' : 'text-slate-800'}`}>
                  {tx.amount < 0 ? '-' : ''}{fmt(tx.amount)}
                </div>
                <div className="text-[10px] text-slate-400">{isExpanded ? '▲' : '▼'}</div>
              </div>
            </button>

            {/* Expanded classification controls */}
            {isExpanded && (
              <div className="border-t border-slate-100 p-3 space-y-3">
                {/* Flag reason banner */}
                {tx.flag_reason && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-xs text-red-700">
                    <strong>Action needed:</strong> {tx.flag_reason}
                  </div>
                )}

                {/* Bucket selector — pill buttons */}
                <div>
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5 block">Classify As</label>
                  <div className="flex flex-wrap gap-1.5">
                    {['Peak 10', 'Moonsmoke LLC', 'Personal', 'Exclude'].map(b => (
                      <button
                        key={b}
                        onClick={() => setCs(tx.id, { bucket: b, category: '' })}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                          cs.bucket === b
                            ? b === 'Peak 10' ? 'bg-blue-600 text-white'
                              : b === 'Moonsmoke LLC' ? 'bg-green-600 text-white'
                              : b === 'Exclude' ? 'bg-red-600 text-white'
                              : 'bg-slate-600 text-white'
                            : 'bg-slate-100 text-slate-600 active:bg-slate-200'
                        }`}
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Category selector */}
                {cs.bucket === 'Peak 10' && (
                  <div>
                    <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 block">P10 Category</label>
                    <select
                      value={cs.category ?? ''}
                      onChange={e => setCs(tx.id, { category: e.target.value })}
                      className="w-full border border-slate-300 rounded-lg px-2 py-2 text-sm"
                    >
                      <option value="">-- Select --</option>
                      {P10_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                )}

                {cs.bucket === 'Moonsmoke LLC' && (
                  <div>
                    <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 block">LLC Category</label>
                    <select
                      value={cs.category ?? ''}
                      onChange={e => setCs(tx.id, { category: e.target.value })}
                      className="w-full border border-slate-300 rounded-lg px-2 py-2 text-sm"
                    >
                      <option value="">-- Select --</option>
                      {LLC_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                )}

                {/* Notes */}
                <div>
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 block">
                    Notes
                    {cs.bucket === 'Peak 10' && cs.category === 'Meals & Meetings - external' && (
                      <span className="text-orange-500 ml-1 normal-case">-- attendee names required</span>
                    )}
                  </label>
                  <input
                    type="text"
                    value={cs.notes ?? tx.description_notes ?? ''}
                    onChange={e => setCs(tx.id, { notes: e.target.value })}
                    placeholder={cs.bucket === 'Peak 10' && cs.category === 'Meals & Meetings - external'
                      ? 'Names and titles of attendees...'
                      : 'Optional notes...'}
                    className="w-full border border-slate-300 rounded-lg px-2 py-2 text-sm"
                  />
                </div>

                {/* Split tool toggle */}
                <button
                  onClick={() => setSplit(tx.id, { show: !sp.show })}
                  className="text-xs text-blue-600 underline"
                >
                  {sp.show ? 'Hide split tool' : 'Split transaction'}
                </button>

                {sp.show && (
                  <div className="bg-slate-50 rounded-lg p-3 space-y-2">
                    <p className="text-[10px] text-slate-400">Total: {fmt(tx.amount)}. Enter amounts for each fragment.</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-slate-400 block mb-0.5">Fragment 1</label>
                        <input type="number" step="0.01" value={sp.a1}
                          onChange={e => setSplit(tx.id, { a1: e.target.value })}
                          className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" placeholder="0.00" />
                        <select value={cs.bucket ?? ''} onChange={e => setCs(tx.id, { bucket: e.target.value })}
                          className="w-full border border-slate-300 rounded px-2 py-1 text-xs mt-1">
                          <option value="">Bucket</option>
                          <option>Peak 10</option><option>Moonsmoke LLC</option><option>Personal</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-400 block mb-0.5">Fragment 2</label>
                        <input type="number" step="0.01" value={sp.a2}
                          onChange={e => setSplit(tx.id, { a2: e.target.value })}
                          className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" placeholder="0.00" />
                        <select value={cs.splitBucket ?? 'Personal'} onChange={e => setCs(tx.id, { splitBucket: e.target.value })}
                          className="w-full border border-slate-300 rounded px-2 py-1 text-xs mt-1">
                          <option>Peak 10</option><option>Moonsmoke LLC</option><option>Personal</option>
                        </select>
                      </div>
                    </div>
                    <button
                      onClick={() => handleSplit(tx)}
                      disabled={isSaving}
                      className="w-full py-2 bg-orange-600 text-white text-xs rounded-lg active:bg-orange-700 disabled:opacity-50"
                    >
                      {isSaving ? 'Splitting...' : 'Confirm Split'}
                    </button>
                  </div>
                )}

                {/* Confirm button */}
                {cs.bucket && !sp.show && (
                  <button
                    onClick={() => handleClassify(tx)}
                    disabled={isSaving}
                    className="w-full py-3 bg-slate-800 text-white rounded-xl text-sm font-medium active:bg-slate-900 disabled:opacity-50"
                  >
                    {isSaving ? 'Saving...' : `Confirm: ${cs.bucket}`}
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
