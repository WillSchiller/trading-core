-- ============================================
-- OPPORTUNITY LIFECYCLE TRACKING
-- ============================================
-- Adds columns to track opportunity open/close lifecycle
-- to enable accurate duration measurements

ALTER TABLE opportunities
  ADD COLUMN opened_at TIMESTAMPTZ,
  ADD COLUMN closed_at TIMESTAMPTZ,
  ADD COLUMN last_seen_at TIMESTAMPTZ,
  ADD COLUMN close_reason TEXT,
  ADD COLUMN opp_key TEXT,
  ADD COLUMN max_spread_bps NUMERIC(8,4);

CREATE INDEX idx_opportunities_open ON opportunities (status, opened_at DESC) WHERE status = 'detected';
CREATE INDEX idx_opportunities_key ON opportunities (opp_key) WHERE opp_key IS NOT NULL;

COMMENT ON COLUMN opportunities.opened_at IS 'When the opportunity first met all filters (2 consecutive ticks above threshold)';
COMMENT ON COLUMN opportunities.closed_at IS 'When the opportunity closed (spread below threshold - hysteresis for 2 ticks)';
COMMENT ON COLUMN opportunities.last_seen_at IS 'Last time this opportunity was seen above threshold (throttled updates)';
COMMENT ON COLUMN opportunities.close_reason IS 'Why the opportunity closed: spread_below_threshold, quote_stale, manual';
COMMENT ON COLUMN opportunities.opp_key IS 'Unique key: chain:pairId:anchorVenueId:dexVenueId:direction:poolAddress';
COMMENT ON COLUMN opportunities.max_spread_bps IS 'Maximum spread observed during opportunity lifetime';
