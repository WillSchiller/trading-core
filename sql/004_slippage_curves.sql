-- Slippage calibration curves for dynamic threshold calculation

CREATE TABLE IF NOT EXISTS slippage_curves (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pool_address TEXT NOT NULL,
  chain chain NOT NULL,
  fee_tier_bps INT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
  notional_usd NUMERIC(12,2) NOT NULL,
  slippage_bps NUMERIC(8,4) NOT NULL,
  break_even_bps NUMERIC(8,4) NOT NULL,
  gas_bps NUMERIC(8,4) NOT NULL,
  recommended_min_spread_bps NUMERIC(8,4) NOT NULL,
  quote_amount_in NUMERIC(38,0),
  quote_amount_out NUMERIC(38,0),
  mid_price NUMERIC(24,12)
);

CREATE INDEX idx_slippage_curves_pool ON slippage_curves (pool_address, direction, ts DESC);
CREATE INDEX idx_slippage_curves_ts ON slippage_curves (ts DESC);

-- View for latest calibration per pool/direction/size
CREATE OR REPLACE VIEW latest_slippage_curves AS
SELECT DISTINCT ON (pool_address, direction, notional_usd)
  pool_address,
  chain,
  fee_tier_bps,
  direction,
  notional_usd,
  slippage_bps,
  break_even_bps,
  recommended_min_spread_bps,
  ts
FROM slippage_curves
ORDER BY pool_address, direction, notional_usd, ts DESC;
