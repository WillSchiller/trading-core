CREATE TABLE IF NOT EXISTS regime_metrics (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ewma_vol_bps NUMERIC(10,2),
  pc1_bps NUMERIC(10,2),
  pc1_momentum NUMERIC(10,4),
  pc1_displacement_bps NUMERIC(10,2),
  dispersion_bps NUMERIC(10,2),
  regime_state VARCHAR(20),
  heat_factor NUMERIC(6,4),
  ewma_mean_bps NUMERIC(10,2)
);

CREATE INDEX IF NOT EXISTS idx_regime_metrics_created ON regime_metrics(created_at DESC);
