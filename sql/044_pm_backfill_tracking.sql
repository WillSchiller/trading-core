ALTER TABLE pm_tracked_traders ADD COLUMN IF NOT EXISTS backfilled_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_shadow_dedup
  ON pm_shadow_trades (trader_address, condition_id, token_id, side, trader_timestamp);
