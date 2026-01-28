-- Store latest prices for PCA assets
CREATE TABLE IF NOT EXISTS pca_prices (
  asset VARCHAR(10) PRIMARY KEY,
  price DECIMAL(18,8) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_pca_prices_updated ON pca_prices(updated_at);
