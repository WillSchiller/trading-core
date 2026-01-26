-- Migration: Add composite index for quote rollup queries
-- This index optimizes queries that aggregate quotes by time, venue, pair, and chain

CREATE INDEX IF NOT EXISTS idx_quotes_raw_rollup
ON quotes_raw (ts, venue_id, pair_id, chain);
