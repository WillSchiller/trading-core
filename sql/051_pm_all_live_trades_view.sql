-- Archive table exists in prod from the Apr 2026 live-table reset; create for fresh databases
CREATE TABLE IF NOT EXISTS pm_live_trades_archive (LIKE pm_live_trades INCLUDING ALL);

-- Union view over current and archived PM live trades, used by the polymarket-copy dashboard
CREATE OR REPLACE VIEW pm_all_live_trades AS
SELECT * FROM pm_live_trades
UNION ALL
SELECT * FROM pm_live_trades_archive;
