-- Store price history for PCA bootstrap on restart
CREATE TABLE IF NOT EXISTS pca_price_history (
  id SERIAL PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  asset VARCHAR(10) NOT NULL,
  price DECIMAL(18,8) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pca_price_history_asset_ts ON pca_price_history(asset, timestamp DESC);

-- Keep only last 2 hours of data per asset (cleanup old data)
CREATE OR REPLACE FUNCTION cleanup_pca_price_history() RETURNS trigger AS $$
BEGIN
  DELETE FROM pca_price_history
  WHERE timestamp < (EXTRACT(EPOCH FROM NOW()) * 1000 - 7200000);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Run cleanup every 100 inserts
DROP TRIGGER IF EXISTS trigger_cleanup_pca_price_history ON pca_price_history;
CREATE TRIGGER trigger_cleanup_pca_price_history
  AFTER INSERT ON pca_price_history
  FOR EACH STATEMENT
  WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION cleanup_pca_price_history();
