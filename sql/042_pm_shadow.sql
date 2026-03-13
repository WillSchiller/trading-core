CREATE TABLE IF NOT EXISTS pm_shadow_trades (
  id BIGSERIAL PRIMARY KEY,
  trader_address VARCHAR(42) NOT NULL,
  trader_alias VARCHAR(100) NOT NULL DEFAULT '',
  condition_id VARCHAR(66) NOT NULL,
  token_id VARCHAR(80) NOT NULL,
  side VARCHAR(4) NOT NULL,
  size NUMERIC(14,2) NOT NULL,
  price NUMERIC(8,4) NOT NULL,
  outcome VARCHAR(100) NOT NULL DEFAULT '',
  market_slug VARCHAR(200) NOT NULL DEFAULT '',
  market_question TEXT NOT NULL DEFAULT '',
  neg_risk BOOLEAN NOT NULL DEFAULT false,
  our_size NUMERIC(12,4),
  our_entry_price NUMERIC(8,4),
  current_price NUMERIC(8,4),
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolution_price NUMERIC(8,4),
  pnl_if_copied NUMERIC(12,4),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  trader_timestamp BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pm_shadow_trader ON pm_shadow_trades(trader_address);
CREATE INDEX IF NOT EXISTS idx_pm_shadow_observed ON pm_shadow_trades(observed_at);
CREATE INDEX IF NOT EXISTS idx_pm_shadow_condition ON pm_shadow_trades(condition_id);
CREATE INDEX IF NOT EXISTS idx_pm_shadow_resolved ON pm_shadow_trades(resolved);

CREATE OR REPLACE VIEW v_pm_shadow_performance AS
SELECT
  trader_alias,
  trader_address,
  COUNT(*) AS total_trades,
  COUNT(*) FILTER (WHERE resolved) AS resolved_trades,
  COUNT(*) FILTER (WHERE resolved AND pnl_if_copied > 0) AS wins,
  COUNT(*) FILTER (WHERE resolved AND pnl_if_copied <= 0) AS losses,
  ROUND(
    COUNT(*) FILTER (WHERE resolved AND pnl_if_copied > 0)::numeric /
    NULLIF(COUNT(*) FILTER (WHERE resolved), 0) * 100, 1
  ) AS win_rate_pct,
  ROUND(COALESCE(SUM(pnl_if_copied) FILTER (WHERE resolved), 0)::numeric, 2) AS total_pnl,
  ROUND(COALESCE(AVG(pnl_if_copied) FILTER (WHERE resolved), 0)::numeric, 2) AS avg_pnl,
  COUNT(DISTINCT condition_id) AS unique_markets,
  COUNT(DISTINCT DATE(observed_at)) AS active_days,
  ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT DATE(observed_at)), 0), 1) AS trades_per_day
FROM pm_shadow_trades
WHERE side = 'BUY'
GROUP BY trader_alias, trader_address
ORDER BY total_pnl DESC;
