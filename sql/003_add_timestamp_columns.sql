-- Add timestamp and latency tracking columns to support clock policy

-- Add exchange timestamp columns to quotes_raw
ALTER TABLE quotes_raw
  ADD COLUMN IF NOT EXISTS exchange_ts_ms BIGINT,
  ADD COLUMN IF NOT EXISTS received_ts_ms BIGINT,
  ADD COLUMN IF NOT EXISTS block_ts_ms BIGINT;

CREATE INDEX IF NOT EXISTS idx_quotes_raw_exchange_ts ON quotes_raw (exchange_ts_ms DESC) WHERE exchange_ts_ms IS NOT NULL;

-- Add latency and timestamp tracking columns to connector_health
ALTER TABLE connector_health
  ADD COLUMN IF NOT EXISTS last_latency_ms INT,
  ADD COLUMN IF NOT EXISTS p95_latency_ms INT,
  ADD COLUMN IF NOT EXISTS invalid_ts_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS future_ts_count INT DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_connector_health_latency ON connector_health (venue_id, p95_latency_ms) WHERE p95_latency_ms IS NOT NULL;

-- Update existing rows to set default values
UPDATE connector_health
SET
  invalid_ts_count = COALESCE(invalid_ts_count, 0),
  future_ts_count = COALESCE(future_ts_count, 0)
WHERE invalid_ts_count IS NULL OR future_ts_count IS NULL;
