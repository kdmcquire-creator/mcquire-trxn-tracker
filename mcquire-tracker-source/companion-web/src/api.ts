const TOKEN_KEY = 'mcquire_token'

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function isAuthenticated(): boolean {
  return !!getToken()
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(path, { ...options, headers })

  if (res.status === 401) {
    clearToken()
    window.location.reload()
    throw new Error('Session expired')
  }

  const json = await res.json()
  if (!json.success) throw new Error(json.error ?? 'Request failed')
  return json
}

export const api = {
  login: (pin: string) =>
    apiFetch<{ success: boolean; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    }),

  logout: () =>
    apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {}).finally(() => clearToken()),

  getDashboard: () =>
    apiFetch<{
      success: boolean
      data: {
        buckets: Record<string, { total: number; count: number }>
        reviewCount: number
        flaggedCount: number
        recentTx: any[]
      }
    }>('/api/dashboard'),

  getPending: () =>
    apiFetch<{ success: boolean; data: any[] }>('/api/transactions/pending'),

  getTransactions: (filters?: Record<string, string>) => {
    const params = new URLSearchParams(filters ?? {})
    return apiFetch<{ success: boolean; data: any[] }>(`/api/transactions?${params}`)
  },

  classify: (id: string, update: Record<string, any>) =>
    apiFetch<{ success: boolean }>('/api/transactions/classify', {
      method: 'POST',
      body: JSON.stringify({ id, update }),
    }),

  runRules: () =>
    apiFetch<{ success: boolean; resolved: number }>('/api/transactions/run-rules', {
      method: 'POST',
    }),

  split: (parentId: string, fragments: any[]) =>
    apiFetch<{ success: boolean }>('/api/transactions/split', {
      method: 'POST',
      body: JSON.stringify({ parentId, fragments }),
    }),
}
