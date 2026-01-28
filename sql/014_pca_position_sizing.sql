-- Add position sizing to PCA signals
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS position_size_usd DECIMAL(12,2);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS pnl_usd DECIMAL(12,4);

-- View for capital deployed
CREATE OR REPLACE VIEW v_pca_capital_deployed AS
SELECT
  COUNT(*) as open_positions,
  COALESCE(SUM(position_size_usd), 0) as total_deployed_usd,
  COALESCE(SUM(CASE direction WHEN 'long' THEN position_size_usd ELSE 0 END), 0) as long_exposure_usd,
  COALESCE(SUM(CASE direction WHEN 'short' THEN position_size_usd ELSE 0 END), 0) as short_exposure_usd,
  COALESCE(SUM(CASE
    WHEN entry_price > 0 AND current_price > 0 THEN
      position_size_usd * (CASE direction
        WHEN 'long' THEN (current_price - entry_price) / entry_price
        WHEN 'short' THEN (entry_price - current_price) / entry_price
      END)
    ELSE 0
  END), 0) as unrealized_pnl_usd
FROM pca_signals
WHERE resolved = false;
