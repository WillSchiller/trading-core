-- Add context columns to mm_paper_fills for adaptive filter analysis
ALTER TABLE mm_paper_fills ADD COLUMN IF NOT EXISTS ofi NUMERIC(6,4);
ALTER TABLE mm_paper_fills ADD COLUMN IF NOT EXISTS vpin NUMERIC(6,4);
ALTER TABLE mm_paper_fills ADD COLUMN IF NOT EXISTS ewma_vol NUMERIC(10,4);
ALTER TABLE mm_paper_fills ADD COLUMN IF NOT EXISTS book_imbalance NUMERIC(6,4);
ALTER TABLE mm_paper_fills ADD COLUMN IF NOT EXISTS skipped BOOLEAN DEFAULT false;
ALTER TABLE mm_paper_fills ADD COLUMN IF NOT EXISTS skip_reason VARCHAR(20);

-- Unique index to prevent duplicate persistence
CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_fills_dedup
  ON mm_paper_fills(timestamp, asset, side, price);
