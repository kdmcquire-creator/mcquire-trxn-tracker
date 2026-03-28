import { useState } from 'react'
import { api, setToken } from '../api'

interface Props {
  onSuccess: () => void
}

export default function Login({ onSuccess }: Props) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pin.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await api.login(pin)
      setToken(res.token)
      onSuccess()
    } catch {
      setError('Invalid PIN')
      setPin('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-800 flex items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-xs space-y-6">
        <div className="text-center">
          <div className="text-4xl mb-3">💰</div>
          <h1 className="text-2xl font-bold text-white">McQuire Tracker</h1>
          <p className="text-slate-400 text-sm mt-1">Enter your PIN to continue</p>
        </div>

        <div>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={pin}
            onChange={e => setPin(e.target.value)}
            placeholder="PIN"
            className="w-full text-center text-2xl tracking-[0.5em] bg-slate-700 text-white border border-slate-600 rounded-xl px-4 py-4 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-slate-500 placeholder:tracking-normal placeholder:text-base"
            autoFocus
          />
        </div>

        {error && (
          <p className="text-red-400 text-sm text-center">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading || !pin.trim()}
          className="w-full py-3 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 text-lg"
        >
          {loading ? 'Verifying...' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
