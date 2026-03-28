import { useState, useEffect } from 'react'
import { isAuthenticated, clearToken } from './api'
import Login from './components/Login'
import Dashboard from './screens/Dashboard'
import ReviewQueue from './screens/ReviewQueue'

type Screen = 'dashboard' | 'review'

export default function App() {
  const [authed, setAuthed] = useState(isAuthenticated())
  const [screen, setScreen] = useState<Screen>('dashboard')
  const [reviewCount, setReviewCount] = useState(0)

  useEffect(() => {
    // Re-check on focus (e.g., returning from another tab)
    const handler = () => setAuthed(isAuthenticated())
    window.addEventListener('focus', handler)
    return () => window.removeEventListener('focus', handler)
  }, [])

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Top bar */}
      <header className="bg-slate-800 text-white px-4 py-3 flex items-center justify-between sticky top-0 z-50">
        <h1 className="text-lg font-bold tracking-tight">McQuire Tracker</h1>
        <button
          onClick={() => { clearToken(); setAuthed(false) }}
          className="text-xs text-slate-300 hover:text-white"
        >
          Sign Out
        </button>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto pb-20">
        {screen === 'dashboard' && (
          <Dashboard
            onNavigate={setScreen}
            onReviewCountUpdate={setReviewCount}
          />
        )}
        {screen === 'review' && (
          <ReviewQueue onPendingChange={setReviewCount} />
        )}
      </main>

      {/* Bottom tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex z-50"
           style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <button
          onClick={() => setScreen('dashboard')}
          className={`flex-1 py-3 text-center text-xs font-medium ${
            screen === 'dashboard' ? 'text-blue-600' : 'text-slate-400'
          }`}
        >
          <div className="text-xl mb-0.5">{screen === 'dashboard' ? '📊' : '📊'}</div>
          Dashboard
        </button>
        <button
          onClick={() => setScreen('review')}
          className={`flex-1 py-3 text-center text-xs font-medium relative ${
            screen === 'review' ? 'text-blue-600' : 'text-slate-400'
          }`}
        >
          <div className="text-xl mb-0.5">📋</div>
          Review
          {reviewCount > 0 && (
            <span className="absolute top-1 right-1/4 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
              {reviewCount > 99 ? '99+' : reviewCount}
            </span>
          )}
        </button>
      </nav>
    </div>
  )
}
