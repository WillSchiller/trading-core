-- Polymarket copy-trading tables

CREATE TABLE IF NOT EXISTS pm_tracked_traders (
  id SERIAL PRIMARY KEY,
  address VARCHAR(42) NOT NULL UNIQUE,
  alias VARCHAR(100) NOT NULL DEFAULT '',
  pnl NUMERIC(12,2) NOT NULL DEFAULT 0,
  volume NUMERIC(16,2) NOT NULL DEFAULT 0,
  bankroll_estimate NUMERIC(12,2) NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pm_traders_enabled ON pm_tracked_traders(enabled);
CREATE INDEX IF NOT EXISTS idx_pm_traders_address ON pm_tracked_traders(address);

CREATE TABLE IF NOT EXISTS pm_copy_trades (
  id BIGSERIAL PRIMARY KEY,
  trader_address VARCHAR(42) NOT NULL,
  condition_id VARCHAR(66) NOT NULL,
  token_id VARCHAR(80) NOT NULL,
  side VARCHAR(4) NOT NULL,
  size NUMERIC(12,4) NOT NULL,
  price NUMERIC(8,4) NOT NULL,
  outcome VARCHAR(100) NOT NULL DEFAULT '',
  market_slug VARCHAR(200) NOT NULL DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'pending',
  paper BOOLEAN NOT NULL DEFAULT true,
  order_id VARCHAR(100),
  fill_price NUMERIC(8,4),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pm_trades_trader ON pm_copy_trades(trader_address);
CREATE INDEX IF NOT EXISTS idx_pm_trades_status ON pm_copy_trades(status);
CREATE INDEX IF NOT EXISTS idx_pm_trades_created ON pm_copy_trades(created_at);

CREATE TABLE IF NOT EXISTS pm_positions (
  id BIGSERIAL PRIMARY KEY,
  condition_id VARCHAR(66) NOT NULL,
  token_id VARCHAR(80) NOT NULL,
  side VARCHAR(4) NOT NULL DEFAULT 'BUY',
  outcome VARCHAR(100) NOT NULL DEFAULT '',
  market_slug VARCHAR(200) NOT NULL DEFAULT '',
  market_question TEXT NOT NULL DEFAULT '',
  avg_entry NUMERIC(8,4) NOT NULL,
  size NUMERIC(12,4) NOT NULL,
  current_price NUMERIC(8,4) NOT NULL DEFAULT 0,
  unrealized_pnl NUMERIC(12,4) NOT NULL DEFAULT 0,
  realized_pnl NUMERIC(12,4) NOT NULL DEFAULT 0,
  status VARCHAR(10) NOT NULL DEFAULT 'open',
  paper BOOLEAN NOT NULL DEFAULT true,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pm_positions_status ON pm_positions(status);
CREATE INDEX IF NOT EXISTS idx_pm_positions_condition ON pm_positions(condition_id);

CREATE TABLE IF NOT EXISTS pm_kill_switch_events (
  id SERIAL PRIMARY KEY,
  reason TEXT NOT NULL,
  daily_pnl NUMERIC(12,4) NOT NULL DEFAULT 0,
  total_exposure NUMERIC(12,4) NOT NULL DEFAULT 0,
  positions_open INTEGER NOT NULL DEFAULT 0,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
