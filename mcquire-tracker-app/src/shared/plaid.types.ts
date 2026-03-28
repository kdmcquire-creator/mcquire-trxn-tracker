// src/shared/plaid.types.ts
// Shared types for Plaid integration — used by both main process and renderer

export interface PlaidItem {
  id: string
  institution_id: string
  institution_name: string
  plaid_item_id: string
  status: 'active' | 'error' | 'login_required'
  error_code: string | null
  consent_expiry: string | null
  last_successful_sync: string | null
  created_at: string
}

export interface Account {
  id: string
  plaid_item_id: string | null
  plaid_account_id: string | null
  institution: string
  account_name: string
  account_mask: string
  account_type: 'depository' | 'credit' | 'investment' | 'brokerage'
  entity: 'Personal' | 'Moonsmoke LLC' | 'Peak 10' | 'Watersound Investments LLC'
  default_bucket: 'Personal' | 'Moonsmoke LLC' | 'Peak 10' | 'Watersound Investments LLC' | ''
  import_method: 'plaid' | 'watched_folder'
  watched_folder_path: string | null
  is_active: number
  created_at: string
  last_synced_at: string | null
  notes: string | null
}

export interface SyncLogEntry {
  id: number
  sync_type: 'plaid_pull' | 'watched_folder' | 'manual_import'
  account_id: string | null
  source_file: string | null
  transactions_found: number
  transactions_new: number
  transactions_duplicate: number
  transactions_classified: number
  transactions_queued: number
  status: 'success' | 'partial' | 'error'
  error_message: string | null
  started_at: string
  completed_at: string | null
}

export interface SyncResult {
  transactions_found: number
  transactions_new: number
  transactions_duplicate: number
  transactions_classified: number
  transactions_queued: number
  error?: string
}

export interface PlaidLinkResult {
  public_token: string
  institution_id: string
  institution_name: string
  accounts: Array<{
    id: string
    name: string
    mask: string
    type: string
    subtype: string
  }>
}

export interface IpcResult<T = void> {
  success: boolean
  data?: T
  error?: string
}

// IPC channel names — single source of truth
export const IPC = {
  // Plaid Link
  PLAID_CREATE_LINK_TOKEN: 'plaid:create-link-token',
  PLAID_EXCHANGE_TOKEN: 'plaid:exchange-token',
  PLAID_OPEN_LINK: 'plaid:open-link',
  PLAID_REAUTH: 'plaid:reauth',

  // Sync
  PLAID_SYNC_ALL: 'plaid:sync-all',
  PLAID_SYNC_ACCOUNT: 'plaid:sync-account',
  PLAID_GET_SYNC_STATUS: 'plaid:get-sync-status',

  // Accounts
  ACCOUNTS_LIST: 'accounts:list',
  ACCOUNTS_GET: 'accounts:get',
  ACCOUNTS_UPDATE: 'accounts:update',
  ACCOUNTS_DISABLE: 'accounts:disable',
  ACCOUNTS_DELETE: 'accounts:delete',

  // Plaid items
  PLAID_ITEMS_LIST: 'plaid-items:list',
  PLAID_ITEMS_DELETE: 'plaid-items:delete',

  // Sync log
  SYNC_LOG_LIST: 'sync-log:list',

  // Settings
  SETTINGS_GET_PLAID_CONFIG: 'settings:get-plaid-config',
  SETTINGS_SAVE_PLAID_CONFIG: 'settings:save-plaid-config',
  SETTINGS_GET_SYNC_SCHEDULE: 'settings:get-sync-schedule',
  SETTINGS_SAVE_SYNC_SCHEDULE: 'settings:save-sync-schedule',

  // Events pushed from main → renderer
  EVENT_SYNC_STARTED: 'event:sync-started',
  EVENT_SYNC_PROGRESS: 'event:sync-progress',
  EVENT_SYNC_COMPLETED: 'event:sync-completed',
  EVENT_SYNC_ERROR: 'event:sync-error',
  EVENT_REAUTH_REQUIRED: 'event:reauth-required',
} as const
