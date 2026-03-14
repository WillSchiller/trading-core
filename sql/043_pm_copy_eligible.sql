ALTER TABLE pm_tracked_traders ADD COLUMN IF NOT EXISTS copy_eligible BOOLEAN DEFAULT false;
