CREATE TABLE IF NOT EXISTS spread_episodes (
  id BIGSERIAL PRIMARY KEY,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  asset VARCHAR(20) NOT NULL,
  binance_symbol VARCHAR(20),
  duration_ms INTEGER NOT NULL,
  ticks INTEGER NOT NULL,
  peak_abs_bps NUMERIC(10,2) NOT NULL,
  avg_spread_bps NUMERIC(10,2) NOT NULL,
  direction VARCHAR(20) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spread_ep_asset ON spread_episodes (asset, start_time);
CREATE INDEX IF NOT EXISTS idx_spread_ep_duration ON spread_episodes (duration_ms DESC);
CREATE INDEX IF NOT EXISTS idx_spread_ep_time ON spread_episodes (start_time);
