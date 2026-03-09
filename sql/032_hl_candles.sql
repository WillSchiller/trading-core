CREATE TABLE IF NOT EXISTS hl_candles (
  timestamp BIGINT NOT NULL,
  asset VARCHAR(20) NOT NULL,
  open NUMERIC(18,8) NOT NULL,
  high NUMERIC(18,8) NOT NULL,
  low NUMERIC(18,8) NOT NULL,
  close NUMERIC(18,8) NOT NULL,
  volume NUMERIC(24,8),
  trade_count INT,
  PRIMARY KEY (asset, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_hl_candles_ts ON hl_candles(timestamp DESC);
