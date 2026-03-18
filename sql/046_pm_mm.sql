-- Polymarket Market Maker tables

CREATE TABLE IF NOT EXISTS pmm_fills (
  id BIGSERIAL PRIMARY KEY,
  condition_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  price NUMERIC(10, 6) NOT NULL,
  size NUMERIC(18, 6) NOT NULL,
  notional_usd NUMERIC(18, 6) NOT NULL,
  fill_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mid_at_fill NUMERIC(10, 6) NOT NULL,
  edge_cents NUMERIC(10, 4),
  adverse_cents NUMERIC(10, 4),
  ofi NUMERIC(8, 4),
  vpin NUMERIC(8, 4),
  ewma_vol NUMERIC(12, 8),
  book_imbalance NUMERIC(8, 4)
);

CREATE INDEX IF NOT EXISTS idx_pmm_fills_condition ON pmm_fills (condition_id, fill_time);
CREATE INDEX IF NOT EXISTS idx_pmm_fills_time ON pmm_fills (fill_time);

CREATE TABLE IF NOT EXISTS pmm_positions (
  condition_id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  question TEXT,
  net_shares NUMERIC(18, 6) NOT NULL DEFAULT 0,
  avg_entry NUMERIC(10, 6) NOT NULL DEFAULT 0,
  realized_pnl NUMERIC(18, 6) NOT NULL DEFAULT 0,
  fills INTEGER NOT NULL DEFAULT 0,
  last_fill_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pmm_stats (
  id BIGSERIAL PRIMARY KEY,
  snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_hours NUMERIC(10, 2) NOT NULL,
  total_fills INTEGER NOT NULL,
  total_volume_usd NUMERIC(18, 4) NOT NULL,
  spread_pnl NUMERIC(18, 6) NOT NULL,
  adverse_cost NUMERIC(18, 6) NOT NULL,
  net_pnl NUMERIC(18, 6) NOT NULL,
  avg_edge_cents NUMERIC(10, 4),
  fills_per_hour NUMERIC(10, 2),
  toxic_pct NUMERIC(6, 4),
  markets_active INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pmm_stats_time ON pmm_stats (snapshot_time);

CREATE TABLE IF NOT EXISTS pmm_active_markets (
  condition_id TEXT PRIMARY KEY,
  question TEXT,
  slug TEXT,
  yes_token_id TEXT NOT NULL,
  no_token_id TEXT NOT NULL,
  mid_price NUMERIC(10, 6),
  volume_24h NUMERIC(18, 4),
  liquidity NUMERIC(18, 4),
  end_date TEXT,
  score NUMERIC(10, 4),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
