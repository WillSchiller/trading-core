CREATE TABLE IF NOT EXISTS perps_executions (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  asset TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  entry_price NUMERIC(24,12) NOT NULL,
  exit_price NUMERIC(24,12),
  quantity NUMERIC(24,12) NOT NULL,
  notional_usd NUMERIC(24,12) NOT NULL,
  realized_pnl NUMERIC(24,12),
  unrealized_pnl NUMERIC(24,12),
  client_order_id TEXT NOT NULL,
  entry_order_id TEXT,
  exit_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('pending_open', 'open', 'closing', 'closed', 'failed')),
  is_paper_trade BOOLEAN NOT NULL DEFAULT true,
  signal_timestamp BIGINT NOT NULL,
  z_score NUMERIC(12,6) NOT NULL,
  residual NUMERIC(12,8) NOT NULL,
  confidence NUMERIC(8,6) NOT NULL,
  exit_reason TEXT,
  leverage INTEGER NOT NULL DEFAULT 1,
  margin_type TEXT NOT NULL DEFAULT 'ISOLATED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_order_id)
);

CREATE INDEX IF NOT EXISTS idx_perps_executions_status ON perps_executions(status);
CREATE INDEX IF NOT EXISTS idx_perps_executions_asset ON perps_executions(asset);
CREATE INDEX IF NOT EXISTS idx_perps_executions_created ON perps_executions(created_at);
CREATE INDEX IF NOT EXISTS idx_perps_executions_signal_ts ON perps_executions(signal_timestamp, asset);

CREATE TABLE IF NOT EXISTS perps_kill_switch_events (
  id BIGSERIAL PRIMARY KEY,
  reason TEXT NOT NULL,
  daily_pnl NUMERIC(24,12) NOT NULL DEFAULT 0,
  total_pnl NUMERIC(24,12) NOT NULL DEFAULT 0,
  consecutive_losses INTEGER NOT NULL DEFAULT 0,
  positions_closed_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE VIEW v_perps_daily_pnl AS
SELECT
  DATE(created_at AT TIME ZONE 'UTC') AS trade_date,
  COUNT(*) FILTER (WHERE status = 'closed') AS closed_trades,
  COUNT(*) FILTER (WHERE realized_pnl > 0) AS wins,
  COUNT(*) FILTER (WHERE realized_pnl < 0) AS losses,
  COALESCE(SUM(realized_pnl) FILTER (WHERE status = 'closed'), 0) AS total_pnl,
  COALESCE(AVG(realized_pnl) FILTER (WHERE status = 'closed'), 0) AS avg_pnl,
  MAX(realized_pnl) AS best_trade,
  MIN(realized_pnl) AS worst_trade
FROM perps_executions
GROUP BY DATE(created_at AT TIME ZONE 'UTC')
ORDER BY trade_date DESC;

CREATE OR REPLACE VIEW v_perps_open_positions AS
SELECT
  id, symbol, asset, direction, side,
  entry_price, quantity, notional_usd,
  unrealized_pnl, leverage, margin_type,
  is_paper_trade, signal_timestamp, z_score,
  created_at,
  EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 AS hold_time_ms
FROM perps_executions
WHERE status IN ('pending_open', 'open', 'closing')
ORDER BY created_at DESC;

CREATE OR REPLACE VIEW v_perps_performance_by_asset AS
SELECT
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
GROUP BY asset
ORDER BY total_pnl DESC;
