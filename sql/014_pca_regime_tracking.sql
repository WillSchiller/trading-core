-- Migration: PCA Regime Tracking
-- Adds regime-aware signal tracking for asymmetric long/short strategies

-- Add regime tracking columns to pca_signals
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS pc1_momentum DECIMAL(12,8);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS regime_state VARCHAR(10);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(20);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS peak_pnl_bps DECIMAL(10,4);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS trough_pnl_bps DECIMAL(10,4);

-- Index for regime analysis
CREATE INDEX IF NOT EXISTS idx_pca_signals_regime ON pca_signals(regime_state, direction);
CREATE INDEX IF NOT EXISTS idx_pca_signals_exit_reason ON pca_signals(exit_reason);

-- PC1 momentum history table for regime analysis
CREATE TABLE IF NOT EXISTS pca_pc1_momentum (
  id SERIAL PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  pc1_return DECIMAL(12,8) NOT NULL,
  momentum_sum DECIMAL(12,8) NOT NULL,
  regime_state VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pca_pc1_momentum_ts ON pca_pc1_momentum(timestamp DESC);

-- View for regime-aware signal performance
CREATE OR REPLACE VIEW v_pca_regime_performance AS
SELECT
  asset,
  direction,
  regime_state,
  exit_reason,
  COUNT(*) as total_signals,
  COUNT(*) FILTER (WHERE resolved) as resolved_signals,
  ROUND(AVG(pnl_bps) FILTER (WHERE resolved)::numeric, 2) as avg_pnl_bps,
  ROUND(SUM(pnl_bps) FILTER (WHERE resolved)::numeric, 2) as total_pnl_bps,
  ROUND((AVG(hold_time_ms) FILTER (WHERE resolved) / 60000)::numeric, 1) as avg_hold_min,
  COUNT(*) FILTER (WHERE resolved AND pnl_bps > 0) as winning_trades,
  COUNT(*) FILTER (WHERE resolved AND pnl_bps <= 0) as losing_trades,
  ROUND(100.0 * COUNT(*) FILTER (WHERE resolved AND pnl_bps > 0)
    / NULLIF(COUNT(*) FILTER (WHERE resolved), 0), 1) as win_rate_pct,
  ROUND(AVG(peak_pnl_bps) FILTER (WHERE resolved)::numeric, 2) as avg_peak_pnl_bps,
  ROUND(AVG(trough_pnl_bps) FILTER (WHERE resolved)::numeric, 2) as avg_trough_pnl_bps
FROM pca_signals
WHERE timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000
GROUP BY asset, direction, regime_state, exit_reason
ORDER BY direction, regime_state, total_pnl_bps DESC;

-- View for regime state distribution
CREATE OR REPLACE VIEW v_pca_regime_summary AS
SELECT
  direction,
  regime_state,
  COUNT(*) as total_signals,
  COUNT(*) FILTER (WHERE resolved) as resolved,
  ROUND(SUM(pnl_bps) FILTER (WHERE resolved)::numeric, 2) as total_pnl_bps,
  ROUND(100.0 * COUNT(*) FILTER (WHERE resolved AND pnl_bps > 0)
    / NULLIF(COUNT(*) FILTER (WHERE resolved), 0), 1) as win_rate_pct
FROM pca_signals
WHERE timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000
GROUP BY direction, regime_state
ORDER BY direction, regime_state;
