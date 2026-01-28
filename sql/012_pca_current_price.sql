-- Add current_price column for unrealized P&L tracking
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS current_price DECIMAL(18,8);

-- View for open signals with unrealized P&L
CREATE OR REPLACE VIEW v_pca_open_signals AS
SELECT
  id,
  to_timestamp(timestamp / 1000) as opened_at,
  asset,
  direction,
  z_score as entry_z,
  residual * 10000 as residual_bps,
  entry_price,
  current_price,
  CASE
    WHEN entry_price > 0 AND current_price > 0 THEN
      CASE direction
        WHEN 'long' THEN ((current_price - entry_price) / entry_price) * 10000
        WHEN 'short' THEN ((entry_price - current_price) / entry_price) * 10000
      END
    ELSE NULL
  END as unrealized_pnl_bps,
  EXTRACT(EPOCH FROM (NOW() - to_timestamp(timestamp / 1000))) / 60 as hold_time_min
FROM pca_signals
WHERE resolved = false
ORDER BY timestamp DESC;
