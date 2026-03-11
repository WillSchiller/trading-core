CREATE TABLE IF NOT EXISTS hl_trade_volume (
  asset VARCHAR(20) NOT NULL,
  period_start BIGINT NOT NULL,
  buy_vol_usd NUMERIC(18,2) NOT NULL DEFAULT 0,
  sell_vol_usd NUMERIC(18,2) NOT NULL DEFAULT 0,
  buy_count INTEGER NOT NULL DEFAULT 0,
  sell_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (asset, period_start)
);

CREATE INDEX IF NOT EXISTS idx_trade_volume_ts ON hl_trade_volume(period_start DESC);
