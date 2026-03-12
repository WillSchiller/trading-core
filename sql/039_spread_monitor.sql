CREATE TABLE IF NOT EXISTS cross_venue_spreads (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  asset VARCHAR(20) NOT NULL,
  binance_symbol VARCHAR(20),
  hl_mid NUMERIC(24,12) NOT NULL,
  binance_mid NUMERIC(24,12) NOT NULL,
  spread_bps NUMERIC(10,2) NOT NULL,
  abs_spread_bps NUMERIC(10,2) NOT NULL,
  fetch_latency_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cv_spreads_ts ON cross_venue_spreads (timestamp);
CREATE INDEX IF NOT EXISTS idx_cv_spreads_asset ON cross_venue_spreads (asset, timestamp);
CREATE INDEX IF NOT EXISTS idx_cv_spreads_wide ON cross_venue_spreads (abs_spread_bps) WHERE abs_spread_bps > 10;
