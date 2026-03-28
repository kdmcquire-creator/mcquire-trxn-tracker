
export type Bucket = 'Peak 10' | 'Moonsmoke LLC' | 'Personal' | 'Watersound Investments LLC' | 'Exclude'
export type ReviewStatus = 'pending_review' | 'auto_classified' | 'manually_classified' | 'flagged'
export type ImportMethod = 'plaid' | 'watched_folder'
export type RuleSection = 'llc_always' | 'p10_always' | 'p10_conditional' | 'personal_override' | 'special' | 'ask_kyle' | 'exclusion'
export type RuleAction = 'classify' | 'ask_kyle' | 'exclude' | 'split_flag'
export type RuleMatchType = 'exact' | 'contains' | 'starts_with' | 'regex'

export interface Account {
  id: string
  plaid_item_id: string | null
  plaid_account_id: string | null
  institution: string
  account_name: string
  account_mask: string
  account_type: 'depository' | 'credit' | 'investment' | 'brokerage'
  entity: string
  default_bucket: Bucket | ''
  import_method: ImportMethod
  watched_folder_path: string | null
  is_active: number
  created_at: string
  last_synced_at: string | null
  notes: string | null
}

export interface Transaction {
  id: string
  account_id: string
  plaid_transaction_id: string | null
  source_row_hash: string | null
  transaction_date: string
  posting_date: string | null
  description_raw: string
  merchant_name: string | null
  amount: number
  category_source: string | null
  bucket: Bucket | null
  p10_category: string | null
  llc_category: string | null
  description_notes: string | null
  rule_id: string | null
  review_status: ReviewStatus
  flag_reason: string | null
  split_parent_id: string | null
  is_split_child: number
  period_label: string | null
  expense_report_id: string | null
  created_at: string
  updated_at: string
  account_name?: string
  account_mask?: string
  institution?: string
}

export interface Rule {
  id: string
  rule_name: string
  section: RuleSection
  match_type: RuleMatchType
  match_value: string
  account_mask_filter: string | null
  amount_min: number | null
  amount_max: number | null
  day_of_week_filter: string | null
  date_from_filter: string | null
  date_to_filter: string | null
  bucket: string | null
  p10_category: string | null
  llc_category: string | null
  description_notes: string | null
  flag_reason: string | null
  action: RuleAction
  priority_order: number
  is_active: number
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Investment {
  id: string
  account_id: string
  plaid_investment_transaction_id: string | null
  record_type: 'holding' | 'transaction'
  security_name: string | null
  ticker: string | null
  quantity: number | null
  price: number | null
  market_value: number | null
  cost_basis: number | null
  transaction_type: string | null
  transaction_amount: number | null
  transaction_date: string | null
  snapshot_date: string | null
  currency: string
  created_at: string
  account_name?: string
  institution?: string
}

export interface ExpenseReport {
  id: string
  report_period: string
  date_generated: string
  file_path: string
  status: 'draft' | 'submitted' | 'reimbursed'
  total_amount: number
  transaction_count: number
  notes: string | null
}

export interface SyncLogEntry {
  id: number
  sync_type: string
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

export interface BucketSummary {
  peak10: { count: number; total: number }
  llc: { count: number; total: number }
  personal: { income: number; expenses: number; count: number }
  pending_review: number
  flagged: number
}

export interface ActionItem {
  id: string
  text: string
  resolved: boolean
  created_at: string
}

export interface ClassificationResult {
  transactions_new: number
  transactions_classified: number
  transactions_queued: number
  transactions_duplicate: number
}

export interface SplitFragment {
  amount: number
  bucket: Bucket
  p10_category?: string
  llc_category?: string
  description_notes?: string
}

export interface AppSettings {
  notification_email: string
  auto_sync_enabled: boolean
  auto_sync_cron: string
  review_email_threshold: number
  last_backup_date: string | null
  expense_report_period_label: string
  peak10_already_reimbursed_through: string
}

export interface ValidationResult {
  valid: boolean
  blocking: string[]
  warnings: string[]
}

export const P10_CATEGORIES = [
  'Office Supplies/Equipment',
  'Telephone & Communication',
  'Computer/Internet',
  'Printing & Reproduction',
  'Postage & Delivery',
  'D&O insurance',
  'Dues & Subscriptions',
  'Meals & Meetings - internal',
  'Meals & Meetings - external',
  'Meals & Meetings - internal and external mixed attendees',
  'Parking',
  'Lodging',
  'Travel',
  'Sponsorships/Memberships',
  'Rent',
  'Salary',
  'Legal',
  'Insurance',
  'Office furniture and other assets',
  'Other',
] as const

export const LLC_CATEGORIES = [
  'Rent - Business Lodging',
  'Lodging - Business Housing',
  'Utilities - Home Office',
  'Executive Wellness',
  'Payroll - Salary',
  'Business Services - Payroll',
  'Business Services - Software',
  'Business Services - Other',
  'Telephone - Business Line',
  'Bank Fees',
  'Taxes - Payroll',
  'Meals & Entertainment',
  'Travel',
  'Office Expenses',
  'Business Expenses - Other'
] as const

export type P10Category = typeof P10_CATEGORIES[number]
export type LLCCategory = typeof LLC_CATEGORIES[number]
