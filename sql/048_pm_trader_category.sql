ALTER TABLE pm_tracked_traders ADD COLUMN IF NOT EXISTS category VARCHAR(20) DEFAULT 'SPORTS';
UPDATE pm_tracked_traders SET category = 'SPORTS' WHERE category IS NULL;
CREATE INDEX IF NOT EXISTS idx_pm_trader_category ON pm_tracked_traders (category);
