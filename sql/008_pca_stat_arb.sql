-- PCA Statistical Arbitrage Tables
-- Factor model snapshots

CREATE TABLE IF NOT EXISTS pca_factor_models (
  id SERIAL PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  num_factors INT NOT NULL,
  variance_explained DECIMAL(6,4)[] NOT NULL,
  pc1_loadings JSONB NOT NULL,
  pc2_loadings JSONB,
  eigenvalues DECIMAL(12,8)[],
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pca_factor_models_ts ON pca_factor_models(timestamp);

-- PCA signals
CREATE TABLE IF NOT EXISTS pca_signals (
  id SERIAL PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  asset VARCHAR(10) NOT NULL,
  direction VARCHAR(10) NOT NULL,
  z_score DECIMAL(6,3) NOT NULL,
  residual DECIMAL(12,8) NOT NULL,
  confidence DECIMAL(6,4),
  pc1_return DECIMAL(12,8),
  pc2_return DECIMAL(12,8),
  all_residuals JSONB,
  resolved BOOLEAN DEFAULT FALSE,
  exit_timestamp BIGINT,
  exit_z_score DECIMAL(6,3),
  hold_time_ms BIGINT,
  entry_price DECIMAL(18,8),
  exit_price DECIMAL(18,8),
  pnl_bps DECIMAL(10,4),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pca_signals_ts ON pca_signals(timestamp);
CREATE INDEX idx_pca_signals_asset ON pca_signals(asset);
CREATE INDEX idx_pca_signals_resolved ON pca_signals(resolved);
CREATE INDEX idx_pca_signals_asset_ts ON pca_signals(asset, timestamp DESC);

-- Residual time series (for analysis)
CREATE TABLE IF NOT EXISTS pca_residuals (
  id SERIAL PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  asset VARCHAR(10) NOT NULL,
  actual_return DECIMAL(12,8),
  expected_return DECIMAL(12,8),
  residual DECIMAL(12,8),
  z_score DECIMAL(6,3),
  pc1_return DECIMAL(12,8),
  pc2_return DECIMAL(12,8),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pca_residuals_ts ON pca_residuals(timestamp);
CREATE INDEX idx_pca_residuals_asset_ts ON pca_residuals(asset, timestamp DESC);

-- Analysis view: Signal performance by asset
CREATE OR REPLACE VIEW v_pca_signal_performance AS
SELECT
  asset,
  direction,
  COUNT(*) as total_signals,
  COUNT(*) FILTER (WHERE resolved) as resolved_signals,
  AVG(hold_time_ms) / 60000 as avg_hold_min,
  AVG(ABS(z_score)) as avg_entry_zscore,
  AVG(ABS(exit_z_score)) FILTER (WHERE resolved) as avg_exit_zscore,
  COUNT(*) FILTER (WHERE resolved AND ABS(exit_z_score) < ABS(z_score)) as correct_direction,
  ROUND(100.0 * COUNT(*) FILTER (WHERE resolved AND ABS(exit_z_score) < ABS(z_score))
    / NULLIF(COUNT(*) FILTER (WHERE resolved), 0), 1) as accuracy_pct
FROM pca_signals
WHERE timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000
GROUP BY asset, direction;

-- Analysis view: Recent residual stats
CREATE OR REPLACE VIEW v_pca_residual_stats AS
SELECT
  asset,
  COUNT(*) as observations,
  AVG(residual) as avg_residual,
  STDDEV(residual) as std_residual,
  MIN(z_score) as min_zscore,
  MAX(z_score) as max_zscore,
  AVG(ABS(z_score)) as avg_abs_zscore
FROM pca_residuals
WHERE timestamp > EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000
GROUP BY asset;

-- Analysis view: Factor model history
CREATE OR REPLACE VIEW v_pca_factor_history AS
SELECT
  id,
  to_timestamp(timestamp / 1000) as model_time,
  num_factors,
  variance_explained[1] as pc1_variance,
  variance_explained[2] as pc2_variance,
  pc1_loadings
FROM pca_factor_models
ORDER BY timestamp DESC
LIMIT 50;
