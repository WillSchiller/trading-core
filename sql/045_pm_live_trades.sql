CREATE TABLE IF NOT EXISTS pm_live_trades (
  id BIGSERIAL PRIMARY KEY,
  trader_address VARCHAR(100) NOT NULL,
  trader_alias VARCHAR(200),
  condition_id VARCHAR(200),
  token_id VARCHAR(200),
  side VARCHAR(10) NOT NULL,
  size NUMERIC(24,8),
  price NUMERIC(12,8),
  outcome VARCHAR(200),
  market_slug VARCHAR(255),
  our_size NUMERIC(24,8),
  our_entry_price NUMERIC(12,8),
  current_price NUMERIC(12,8),
  pnl NUMERIC(24,8),
  resolved BOOLEAN DEFAULT false,
  resolution_price NUMERIC(12,8),
  trader_timestamp BIGINT,
  observed_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pm_live_trader ON pm_live_trades (trader_address);
CREATE INDEX IF NOT EXISTS idx_pm_live_resolved ON pm_live_trades (resolved);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_live_dedup
  ON pm_live_trades (trader_address, condition_id, token_id, side, trader_timestamp);
