-- Funding rate arbitrage tables

CREATE TABLE IF NOT EXISTS funding_arb_positions (
  id VARCHAR(64) PRIMARY KEY,
  asset VARCHAR(20) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'open',
  perp_short_qty NUMERIC(24,12) NOT NULL,
  perp_entry_price NUMERIC(24,12) NOT NULL,
  spot_long_qty NUMERIC(24,12) NOT NULL,
  spot_entry_price NUMERIC(24,12) NOT NULL,
  notional_usd NUMERIC(12,2) NOT NULL,
  leverage NUMERIC(4,1) NOT NULL DEFAULT 1,
  entry_funding_rate NUMERIC(12,8) NOT NULL,
  accumulated_funding NUMERIC(12,6) NOT NULL DEFAULT 0,
  entry_fees_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  exit_fees_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  realized_pnl NUMERIC(12,6) NOT NULL DEFAULT 0,
  spot_pnl NUMERIC(12,6) NOT NULL DEFAULT 0,
  perp_pnl NUMERIC(12,6) NOT NULL DEFAULT 0,
  hours_held NUMERIC(10,2) NOT NULL DEFAULT 0,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_farb_pos_status ON funding_arb_positions(status);
CREATE INDEX IF NOT EXISTS idx_farb_pos_asset ON funding_arb_positions(asset);

CREATE TABLE IF NOT EXISTS funding_arb_scans (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  asset VARCHAR(20) NOT NULL,
  current_funding_rate NUMERIC(12,8) NOT NULL,
  predicted_funding_rate NUMERIC(12,8) NOT NULL,
  annualized_pct NUMERIC(10,2) NOT NULL,
  break_even_hours NUMERIC(8,2) NOT NULL,
  spot_mid_price NUMERIC(24,12) NOT NULL,
  perp_mid_price NUMERIC(24,12) NOT NULL,
  basis_bps NUMERIC(8,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_farb_scans_ts ON funding_arb_scans(timestamp);
CREATE INDEX IF NOT EXISTS idx_farb_scans_asset ON funding_arb_scans(asset, timestamp);
