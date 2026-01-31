-- Add multi-run support: run_id + mode columns for side-by-side paper/live execution

ALTER TABLE perps_executions
  ADD COLUMN IF NOT EXISTS run_id TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live'));

ALTER TABLE perps_kill_switch_events
  ADD COLUMN IF NOT EXISTS run_id TEXT NOT NULL DEFAULT 'default';

-- Replace unique constraint: now scoped per run
ALTER TABLE perps_executions DROP CONSTRAINT IF EXISTS perps_executions_client_order_id_key;
ALTER TABLE perps_executions ADD CONSTRAINT perps_executions_run_client_order_id_key UNIQUE (run_id, client_order_id);

-- Add indexes for run_id scoped queries
CREATE INDEX IF NOT EXISTS idx_perps_executions_run_id ON perps_executions(run_id);
CREATE INDEX IF NOT EXISTS idx_perps_executions_run_status ON perps_executions(run_id, status);
CREATE INDEX IF NOT EXISTS idx_perps_executions_run_asset_status ON perps_executions(run_id, asset, status);
CREATE INDEX IF NOT EXISTS idx_perps_executions_run_created ON perps_executions(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_perps_kill_switch_run ON perps_kill_switch_events(run_id);

-- Drop and recreate views (column list changed, CREATE OR REPLACE can't rename columns)
DROP VIEW IF EXISTS v_perps_daily_pnl;
DROP VIEW IF EXISTS v_perps_open_positions;
DROP VIEW IF EXISTS v_perps_performance_by_asset;

CREATE VIEW v_perps_daily_pnl AS
SELECT
  run_id,
  mode,
  DATE(created_at AT TIME ZONE 'UTC') AS trade_date,
  COUNT(*) FILTER (WHERE status = 'closed') AS closed_trades,
  COUNT(*) FILTER (WHERE realized_pnl > 0) AS wins,
  COUNT(*) FILTER (WHERE realized_pnl < 0) AS losses,
  COALESCE(SUM(realized_pnl) FILTER (WHERE status = 'closed'), 0) AS total_pnl,
  COALESCE(AVG(realized_pnl) FILTER (WHERE status = 'closed'), 0) AS avg_pnl,
  MAX(realized_pnl) AS best_trade,
  MIN(realized_pnl) AS worst_trade
FROM perps_executions
GROUP BY run_id, mode, DATE(created_at AT TIME ZONE 'UTC')
ORDER BY trade_date DESC;

CREATE VIEW v_perps_open_positions AS
SELECT
  id, run_id, mode, symbol, asset, direction, side,
  entry_price, quantity, notional_usd,
  unrealized_pnl, leverage, margin_type,
  is_paper_trade, signal_timestamp, z_score,
  created_at,
  EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 AS hold_time_ms
FROM perps_executions
WHERE status IN ('pending_open', 'open', 'closing')
ORDER BY created_at DESC;

CREATE VIEW v_perps_performance_by_asset AS
SELECT
  run_id,
  mode,
  asset,
  COUNT(*) FILTER (WHERE status = 'closed') AS total_trades,
  COUNT(*) FILTER (WHERE realized_pnl > 0) AS wins,
  COUNT(*) FILTER (WHERE realized_pnl <= 0) AS losses,
  COALESCE(SUM(realized_pnl) FILTER (WHERE status = 'closed'), 0) AS total_pnl,
  COALESCE(AVG(realized_pnl) FILTER (WHERE status = 'closed'), 0) AS avg_pnl,
  CASE
    WHEN COUNT(*) FILTER (WHERE status = 'closed') > 0
    THEN ROUND(100.0 * COUNT(*) FILTER (WHERE realized_pnl > 0) / COUNT(*) FILTER (WHERE status = 'closed'), 1)
    ELSE 0
  END AS win_rate_pct
FROM perps_executions
GROUP BY run_id, mode, asset
ORDER BY total_pnl DESC;
