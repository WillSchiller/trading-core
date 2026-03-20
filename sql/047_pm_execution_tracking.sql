ALTER TABLE pm_live_trades
  ADD COLUMN IF NOT EXISTS order_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS fill_price NUMERIC(12,8),
  ADD COLUMN IF NOT EXISTS fill_size NUMERIC(24,8),
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_status VARCHAR(20) DEFAULT 'paper',
  ADD COLUMN IF NOT EXISTS real_pnl NUMERIC(24,8);

CREATE INDEX IF NOT EXISTS idx_pm_live_execution_status ON pm_live_trades (execution_status);
