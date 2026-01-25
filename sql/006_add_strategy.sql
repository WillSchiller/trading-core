-- Add strategy column to track which detection algorithm found the opportunity
-- Supports running multiple strategies in parallel with separate P&L tracking

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS strategy VARCHAR(32) DEFAULT 'dislocation';
ALTER TABLE executions ADD COLUMN IF NOT EXISTS strategy VARCHAR(32) DEFAULT 'dislocation';

CREATE INDEX IF NOT EXISTS idx_opportunities_strategy ON opportunities (strategy);
CREATE INDEX IF NOT EXISTS idx_executions_strategy ON executions (strategy);

-- DOWN (for rollback reference)
-- ALTER TABLE opportunities DROP COLUMN strategy;
-- ALTER TABLE executions DROP COLUMN strategy;
-- DROP INDEX idx_opportunities_strategy;
-- DROP INDEX idx_executions_strategy;
