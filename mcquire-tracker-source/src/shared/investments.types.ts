// src/shared/investments.types.ts
// Shared types for Phase 3 investment tracking — used by main process and renderer

export interface InvestmentHolding {
  id: string
  account_id: string
  account_name: string
  account_mask: string
  institution: string
  record_type: 'holding'
  security_name: string | null
  ticker: string | null
  quantity: number | null
  price: number | null
  market_value: number | null
  cost_basis: number | null
  gain_loss: number | null        // derived: market_value - cost_basis
  gain_loss_pct: number | null    // derived
  snapshot_date: string
  currency: string
}

export interface InvestmentTransaction {
  id: string
  account_id: string
  account_name: string
  account_mask: string
  institution: string
  record_type: 'transaction'
  security_name: string | null
  ticker: string | null
  transaction_type: string | null
  transaction_amount: number | null
  quantity: number | null
  price: number | null
  transaction_date: string
  currency: string
}

export interface PortfolioSummary {
  total_market_value: number
  total_cost_basis: number | null
  total_gain_loss: number | null
  total_gain_loss_pct: number | null
  as_of_date: string
  account_count: number
  holdings_count: number
  has_incomplete_cost_basis: boolean
}

export interface AccountSummary {
  account_id: string
  account_name: string
  account_mask: string
  institution: string
  market_value: number
  cost_basis: number | null
  holding_count: number
  last_synced_at: string | null
}

export interface HistoricalSnapshot {
  snapshot_date: string
  total_value: number
}

// IPC channel names for Phase 3
export const INVESTMENT_IPC = {
  SYNC_HOLDINGS: 'investments:sync-holdings',
  SYNC_TRANSACTIONS: 'investments:sync-transactions',
  SYNC_ALL: 'investments:sync-all',

  GET_PORTFOLIO_SUMMARY: 'investments:get-portfolio-summary',
  GET_ACCOUNT_SUMMARIES: 'investments:get-account-summaries',
  GET_HOLDINGS: 'investments:get-holdings',
  GET_TRANSACTIONS: 'investments:get-transactions',
  GET_HISTORICAL: 'investments:get-historical',

  EXPORT_PORTFOLIO: 'investments:export-portfolio',
} as const
