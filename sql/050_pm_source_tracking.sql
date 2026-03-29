ALTER TABLE pm_live_trades
  ADD COLUMN IF NOT EXISTS source VARCHAR(10) DEFAULT 'node',
  ADD COLUMN IF NOT EXISTS model_version VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_pm_live_source ON pm_live_trades (source);
