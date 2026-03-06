-- Add market context columns to pca_signals for multi-signal research
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS market_context JSONB;

-- Separate table for continuous market context snapshots (independent of signals)
CREATE TABLE IF NOT EXISTS market_context_snapshots (
    id BIGSERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    asset VARCHAR(10) NOT NULL,
    funding_rate NUMERIC(18,12),
    open_interest NUMERIC(24,4),
    day_ntl_vlm NUMERIC(24,4),
    premium NUMERIC(18,12),
    oracle_px NUMERIC(18,8),
    mark_px NUMERIC(18,8),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_market_ctx_asset_ts ON market_context_snapshots (asset, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_market_ctx_ts ON market_context_snapshots (timestamp DESC);
