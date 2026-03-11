CREATE TABLE IF NOT EXISTS mm_paper_stats (
  timestamp BIGINT PRIMARY KEY,
  run_hours NUMERIC(10,2),
  total_fills INTEGER,
  total_volume_usd NUMERIC(18,2),
  spread_pnl NUMERIC(18,6),
  rebates_pnl NUMERIC(18,6),
  adverse_cost NUMERIC(18,6),
  net_pnl NUMERIC(18,6),
  avg_edge_bps NUMERIC(10,4),
  fills_per_hour NUMERIC(10,2),
  toxic_pct NUMERIC(6,4)
);

CREATE TABLE IF NOT EXISTS mm_paper_fills (
  id SERIAL PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  asset VARCHAR(20) NOT NULL,
  side VARCHAR(4) NOT NULL,
  price NUMERIC(24,12) NOT NULL,
  notional NUMERIC(18,2) NOT NULL,
  edge_bps NUMERIC(10,4),
  adverse_bps NUMERIC(10,4),
  mid_at_fill NUMERIC(24,12)
);

CREATE INDEX IF NOT EXISTS idx_mm_fills_ts ON mm_paper_fills(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mm_fills_asset ON mm_paper_fills(asset, timestamp DESC);
