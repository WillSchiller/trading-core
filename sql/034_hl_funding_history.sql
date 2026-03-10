CREATE TABLE IF NOT EXISTS hl_funding_history (
  asset VARCHAR(20) NOT NULL,
  timestamp BIGINT NOT NULL,
  funding_rate NUMERIC(18,10) NOT NULL,
  premium NUMERIC(18,10),
  PRIMARY KEY (asset, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_hl_funding_ts ON hl_funding_history(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_hl_funding_asset_ts ON hl_funding_history(asset, timestamp DESC);
