// src/renderer/screens/Settings/AccountManagement.tsx
//
// Phase 2 — Settings → Account Management
// Handles: connect Chase/Schwab/Fidelity via Plaid, view account status,
// re-authenticate expired sessions, disable accounts.

import { useState, useEffect, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccountRow {
  id: string
  institution: string
  account_name: string
  account_mask: string
  account_type: string
  entity: string
  default_bucket: string
  import_method: 'plaid' | 'watched_folder'
  is_active: number
  last_synced_at: string | null
  plaid_status: 'active' | 'error' | 'login_required' | null
  error_code: string | null
  plaid_item_id: string | null
  notes: string | null
}

interface PlaidItemRow {
  id: string
  institution_name: string
  plaid_item_id: string
  status: 'active' | 'error' | 'login_required' | 'disabled'
  last_successful_sync: string | null
  error_code: string | null
}

type AccountEntity = 'Personal' | 'Moonsmoke LLC' | 'Peak 10' | 'Watersound Investments LLC'
type AccountBucket = 'Personal' | 'Moonsmoke LLC' | 'Peak 10' | 'Watersound Investments LLC' | ''

// Access window.api (set by contextBridge in preload)
declare const window: Window & {
  api: {
    plaid: {
      getConfig: () => Promise<any>
      saveConfig: (c: any) => Promise<any>
      createLinkToken: () => Promise<any>
      openLink: (token: string) => Promise<any>
      exchangeToken: (payload: any) => Promise<any>
      reauth: (itemId: string) => Promise<any>
      syncAll: () => Promise<any>
      syncAccount: (itemId: string) => Promise<any>
      getSyncStatus: () => Promise<any>
      listItems: () => Promise<any>
      deleteItem: (itemId: string) => Promise<any>
      onSyncStarted: (cb: (d: any) => void) => void
      onSyncCompleted: (cb: (d: any) => void) => void
      onSyncError: (cb: (d: any) => void) => void
      onReauthRequired: (cb: (d: any) => void) => void
      removeAllListeners: () => void
    }
    accounts: {
      list: () => Promise<any>
      update: (a: any) => Promise<any>
      disable: (id: string) => Promise<any>
      delete: (id: string) => Promise<any>
    }
  }
}

// ─── Helper components ────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string | null }) {
  if (!status || status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-800">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
        Active
      </span>
    )
  }
  if (status === 'login_required') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-800">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        Re-auth required
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-800">
      <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
      Error
    </span>
  )
}

function InstitutionIcon({ name }: { name: string }) {
  const n = name.toLowerCase()
  const color = n.includes('chase')
    ? 'bg-blue-700'
    : n.includes('fidelity')
    ? 'bg-green-700'
    : n.includes('schwab')
    ? 'bg-blue-500'
    : n.includes('usaa')
    ? 'bg-gray-600'
    : n.includes('apple')
    ? 'bg-gray-800'
    : 'bg-indigo-600'

  return (
    <div className={`w-8 h-8 rounded-full ${color} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
      {name.slice(0, 2).toUpperCase()}
    </div>
  )
}

// ─── Account edit modal ───────────────────────────────────────────────────────

function EditAccountModal({
  account,
  onSave,
  onClose,
}: {
  account: AccountRow
  onSave: (updated: Partial<AccountRow>) => void
  onClose: () => void
}) {
  const [entity, setEntity] = useState<AccountEntity>(account.entity as AccountEntity)
  const [bucket, setBucket] = useState<AccountBucket>((account.default_bucket ?? '') as AccountBucket)
  const [notes, setNotes] = useState(account.notes || '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    await onSave({ id: account.id, account_name: account.account_name, entity, default_bucket: bucket, notes })
    setSaving(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[420px] p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-gray-900 mb-1">{account.account_name}</h3>
        <p className="text-sm text-gray-500 mb-5">
          {account.institution} ···{account.account_mask}
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Entity</label>
            <select
              value={entity}
              onChange={(e) => setEntity(e.target.value as AccountEntity)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="Personal">Personal</option>
              <option value="Moonsmoke LLC">Moonsmoke LLC</option>
              <option value="Peak 10">Peak 10</option>
              <option value="Watersound Investments LLC">Watersound Investments LLC</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Default Bucket</label>
            <select
              value={bucket}
              onChange={(e) => setBucket(e.target.value as AccountBucket)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">No default (follow rules)</option>
              <option value="Personal">Personal</option>
              <option value="Moonsmoke LLC">Moonsmoke LLC</option>
              <option value="Peak 10">Peak 10</option>
              <option value="Watersound Investments LLC">Watersound Investments LLC</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. Britt family card"
            />
          </div>
        </div>

        <div className="flex gap-3 mt-6 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-brand-blue text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Connect Account wizard ───────────────────────────────────────────────────

function ConnectPlaidWizard({
  linkResult,
  onComplete,
  onClose,
}: {
  linkResult: { institution_id: string; institution_name: string; accounts: any[] }
  onComplete: () => void
  onClose: () => void
}) {
  const [accountConfigs, setAccountConfigs] = useState<
    Array<{
      plaid_account_id: string
      account_name: string
      account_mask: string
      account_type: string
      entity: AccountEntity
      default_bucket: AccountBucket
      selected: boolean
    }>
  >(
    linkResult.accounts.map((a) => ({
      plaid_account_id: a.id,
      account_name: a.name,
      account_mask: a.mask || '',
      account_type: a.type,
      entity: 'Personal' as AccountEntity,
      default_bucket: 'Personal' as AccountBucket,
      selected: true,
    }))
  )
  const [saving, setSaving] = useState(false)
  const [publicToken] = useState<string>((linkResult as any).public_token)

  // Pre-set sensible defaults based on known account masks from the workflow doc
  useEffect(() => {
    setAccountConfigs((prev) =>
      prev.map((a) => {
        const mask = a.account_mask
        const name = a.account_name.toLowerCase()
        if (mask === '2255' || name.includes('bus complete')) {
          return { ...a, entity: 'Moonsmoke LLC', default_bucket: 'Moonsmoke LLC' }
        }
        return a
      })
    )
  }, [])

  async function handleSave() {
    setSaving(true)
    const selectedAccounts = accountConfigs.filter((a) => a.selected)
    const result = await window.api.plaid.exchangeToken({
      public_token: publicToken,
      institution_id: linkResult.institution_id,
      institution_name: linkResult.institution_name,
      accounts: selectedAccounts,
    })
    setSaving(false)
    if (result.success) {
      onComplete()
    } else {
      alert(`Failed to connect: ${result.error}`)
    }
  }

  function updateConfig(idx: number, field: string, value: string | boolean) {
    setAccountConfigs((prev) =>
      prev.map((a, i) => (i === idx ? { ...a, [field]: value } : a))
    )
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-2xl w-[520px] max-h-[80vh] overflow-y-auto p-6">
        <h3 className="font-semibold text-gray-900 mb-1">
          Connected to {linkResult.institution_name}
        </h3>
        <p className="text-sm text-gray-500 mb-5">
          Select which accounts to track and assign each to an entity.
        </p>

        <div className="space-y-3">
          {accountConfigs.map((acct, idx) => (
            <div
              key={acct.plaid_account_id}
              className={`border rounded-lg p-4 ${acct.selected ? 'border-brand-blue bg-blue-50' : 'border-gray-200 opacity-60'}`}
            >
              <div className="flex items-center gap-3 mb-3">
                <input
                  type="checkbox"
                  checked={acct.selected}
                  onChange={(e) => updateConfig(idx, 'selected', e.target.checked)}
                  className="w-4 h-4 text-brand-blue"
                />
                <div>
                  <span className="font-medium text-sm text-gray-900">{acct.account_name}</span>
                  <span className="ml-2 text-xs text-gray-500">···{acct.account_mask} · {acct.account_type}</span>
                </div>
              </div>

              {acct.selected && (
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Entity</label>
                    <select
                      value={acct.entity}
                      onChange={(e) => updateConfig(idx, 'entity', e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs"
                    >
                      <option value="Personal">Personal</option>
                      <option value="Moonsmoke LLC">Moonsmoke LLC</option>
                      <option value="Peak 10">Peak 10</option>
                      <option value="Watersound Investments LLC">Watersound Investments LLC</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Default Bucket</label>
                    <select
                      value={acct.default_bucket}
                      onChange={(e) => updateConfig(idx, 'default_bucket', e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs"
                    >
                      <option value="">No default (follow rules)</option>
                      <option value="Personal">Personal</option>
                      <option value="Moonsmoke LLC">Moonsmoke LLC</option>
                      <option value="Peak 10">Peak 10</option>
                      <option value="Watersound Investments LLC">Watersound Investments LLC</option>
                    </select>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex gap-3 mt-6 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || accountConfigs.filter((a) => a.selected).length === 0}
            className="px-4 py-2 bg-brand-blue text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Connecting…' : 'Connect Accounts'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Screen ─────────────────────────────────────────────────────────────

export default function AccountManagement() {
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [items, setItems] = useState<PlaidItemRow[]>([])
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [editingAccount, setEditingAccount] = useState<AccountRow | null>(null)
  const [linkResult, setLinkResult] = useState<any | null>(null)
  const [syncingItem, setSyncingItem] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async () => {
    setLoading(true)
    const [acctRes, itemRes] = await Promise.all([
      window.api.accounts.list(),
      window.api.plaid.listItems(),
    ])
    if (acctRes.success) setAccounts(acctRes.data)
    if (itemRes.success) setItems(itemRes.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // ─── Connect via Plaid ────────────────────────────────────────────────────────

  async function handleConnectPlaid() {
    setConnecting(true)
    try {
      // 1. Get link token
      const tokenRes = await window.api.plaid.createLinkToken()
      if (!tokenRes.success) {
        alert(`Could not start Plaid Link: ${tokenRes.error}`)
        return
      }

      // 2. Open Plaid Link window
      const linkRes = await window.api.plaid.openLink(tokenRes.data)
      if (!linkRes.success) {
        if (!linkRes.error?.includes('closed')) {
          alert(`Plaid Link error: ${linkRes.error}`)
        }
        return
      }

      // 3. Show account selection wizard
      setLinkResult(linkRes.data)
    } finally {
      setConnecting(false)
    }
  }

  async function handleReauth(item: PlaidItemRow) {
    const result = await window.api.plaid.reauth(item.plaid_item_id)
    if (result.success) {
      showToast(`${item.institution_name} re-authenticated successfully.`)
      load()
    } else {
      alert(`Re-authentication failed: ${result.error}`)
    }
  }

  async function handleSyncItem(item: PlaidItemRow) {
    setSyncingItem(item.plaid_item_id)
    const result = await window.api.plaid.syncAccount(item.plaid_item_id)
    setSyncingItem(null)
    if (result.success) {
      const r = result.data
      showToast(
        `${item.institution_name}: ${r.transactions_new} new, ${r.transactions_queued} queued for review.`
      )
      load()
    } else {
      alert(`Sync failed: ${result.error}`)
    }
  }

  async function handleDisableAccount(account: AccountRow) {
    if (!confirm(`Disable "${account.account_name}"? Historical transactions will be kept.`)) return
    await window.api.accounts.disable(account.id)
    load()
  }

  async function handleDeleteAccount(account: AccountRow) {
    if (!confirm(`Permanently remove "${account.account_name}"? The account record will be deleted. Historical transactions are kept but will no longer be linked to an account.`)) return
    await window.api.accounts.delete(account.id)
    showToast(`${account.account_name} removed.`)
    load()
  }

  async function handleDeleteItem(item: PlaidItemRow) {
    if (
      !confirm(
        `Remove connection to ${item.institution_name}? The access token will be deleted. Historical transactions are kept.`
      )
    )
      return
    await window.api.plaid.deleteItem(item.plaid_item_id)
    showToast(`${item.institution_name} disconnected.`)
    load()
  }

  async function handleSaveAccount(updated: Partial<AccountRow>) {
    await window.api.accounts.update(updated)
    showToast('Account updated.')
    load()
  }

  // Group accounts by institution
  const activeAccounts = accounts.filter((a) => a.is_active === 1)
  const disabledAccounts = accounts.filter((a) => a.is_active === 0)

  const plaidItems = items.filter((i) => i.status !== 'disabled')
  const reauthNeeded = plaidItems.filter((i) => i.status === 'login_required')

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 bg-gray-900 text-white px-4 py-3 rounded-lg shadow-xl text-sm z-50">
          {toast}
        </div>
      )}

      {/* Re-auth banner */}
      {reauthNeeded.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="font-semibold text-red-800 text-sm mb-2">
            ⚠️ Re-authentication required
          </p>
          <div className="space-y-2">
            {reauthNeeded.map((item) => (
              <div key={item.id} className="flex items-center justify-between">
                <span className="text-sm text-red-700">
                  {item.institution_name} — session expired
                </span>
                <button
                  onClick={() => handleReauth(item)}
                  className="px-3 py-1 bg-red-600 text-white rounded text-xs font-medium hover:bg-red-700"
                >
                  Re-authenticate
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Account Management</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage Plaid connections and watched-folder imports.
          </p>
        </div>
        <button
          onClick={handleConnectPlaid}
          disabled={connecting}
          className="flex items-center gap-2 px-4 py-2 bg-brand-blue text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {connecting ? (
            <span className="animate-spin">⟳</span>
          ) : (
            <span>＋</span>
          )}
          Add Account via Plaid
        </button>
      </div>

      {/* Plaid connections */}
      {plaidItems.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
            Plaid Connections
          </h3>
          <div className="space-y-2">
            {plaidItems.map((item) => (
              <div
                key={item.id}
                className="bg-white border border-gray-200 rounded-xl p-4 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <InstitutionIcon name={item.institution_name} />
                  <div>
                    <p className="font-medium text-sm text-gray-900">{item.institution_name}</p>
                    <p className="text-xs text-gray-500">
                      {item.last_successful_sync
                        ? `Last synced ${new Date(item.last_successful_sync).toLocaleString()}`
                        : 'Never synced'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={item.status} />
                  {item.status === 'login_required' ? (
                    <button
                      onClick={() => handleReauth(item)}
                      className="px-3 py-1.5 bg-red-600 text-white rounded text-xs font-medium hover:bg-red-700"
                    >
                      Re-authenticate
                    </button>
                  ) : (
                    <button
                      onClick={() => handleSyncItem(item)}
                      disabled={syncingItem === item.plaid_item_id}
                      className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded text-xs hover:bg-gray-50 disabled:opacity-50"
                    >
                      {syncingItem === item.plaid_item_id ? 'Syncing…' : 'Sync Now'}
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteItem(item)}
                    className="text-gray-400 hover:text-red-500 text-sm px-1"
                    title="Remove connection"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Accounts table */}
      <section>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
          Tracked Accounts ({activeAccounts.length})
        </h3>

        {loading ? (
          <div className="text-center py-8 text-gray-400 text-sm">Loading accounts…</div>
        ) : activeAccounts.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <p className="text-4xl mb-3">🏦</p>
            <p className="font-medium">No accounts connected yet.</p>
            <p className="text-sm mt-1">Click "Add Account via Plaid" to connect Chase, Schwab, or Fidelity.</p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Account</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Entity</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Import</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Last Sync</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {activeAccounts.map((acct) => (
                  <tr key={acct.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <InstitutionIcon name={acct.institution} />
                        <div>
                          <p className="font-medium text-gray-900">{acct.account_name}</p>
                          <p className="text-xs text-gray-500">
                            {acct.institution} ···{acct.account_mask}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 capitalize">{acct.account_type}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          acct.entity === 'Moonsmoke LLC'
                            ? 'bg-green-100 text-green-800'
                            : acct.entity === 'Peak 10'
                            ? 'bg-blue-100 text-blue-800'
                            : acct.entity === 'Watersound Investments LLC'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {acct.entity}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 capitalize">
                      {acct.import_method === 'plaid' ? '🔗 Plaid' : '📁 Folder'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={acct.plaid_status} />
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {acct.last_synced_at
                        ? new Date(acct.last_synced_at).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        <button
                          onClick={() => setEditingAccount(acct)}
                          className="text-xs text-brand-blue hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDisableAccount(acct)}
                          className="text-xs text-gray-400 hover:text-orange-500"
                        >
                          Disable
                        </button>
                        <button
                          onClick={() => handleDeleteAccount(acct)}
                          className="text-xs text-gray-400 hover:text-red-600"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Disabled accounts (collapsed) */}
      {disabledAccounts.length > 0 && (
        <details className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <summary className="text-sm text-gray-600 cursor-pointer font-medium">
            {disabledAccounts.length} disabled account{disabledAccounts.length > 1 ? 's' : ''}
          </summary>
          <div className="mt-3 space-y-2">
            {disabledAccounts.map((acct) => (
              <div key={acct.id} className="flex items-center justify-between text-sm text-gray-500">
                <span>
                  {acct.institution} ···{acct.account_mask} — {acct.account_name}
                </span>
                <button
                  onClick={async () => {
                    await window.api.accounts.update({ id: acct.id, is_active: 1 })
                    load()
                  }}
                  className="text-xs text-brand-blue hover:underline"
                >
                  Re-enable
                </button>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Modals */}
      {editingAccount && (
        <EditAccountModal
          account={editingAccount}
          onSave={handleSaveAccount}
          onClose={() => setEditingAccount(null)}
        />
      )}

      {linkResult && (
        <ConnectPlaidWizard
          linkResult={linkResult}
          onComplete={() => {
            setLinkResult(null)
            showToast('Accounts connected! Starting initial sync…')
            load()
          }}
          onClose={() => setLinkResult(null)}
        />
      )}
    </div>
  )
}
