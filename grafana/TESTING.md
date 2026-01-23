# Grafana Dashboard Testing Guide

This guide helps verify that all dashboards are working correctly.

## Pre-requisites

1. Docker and docker-compose installed
2. PostgreSQL container running with schema initialized
3. Grafana container running

## Quick Start

```bash
# Start the infrastructure
docker-compose up -d

# Wait for services to be healthy
docker-compose ps

# Access Grafana
open http://localhost:3000
# Login: admin / admin (or your GRAFANA_PASSWORD)
```

## Testing Steps

### 1. Verify Datasource

1. Navigate to **Configuration → Data Sources**
2. Verify "PostgreSQL" datasource exists and shows green checkmark
3. Click "Test" button - should see "Database Connection OK"

If datasource test fails:
- Check postgres container is running: `docker-compose ps postgres`
- Check postgres is healthy: `docker-compose logs postgres`
- Verify connection string in `grafana/provisioning/datasources/postgres.yml`

### 2. Verify Dashboard Loading

1. Navigate to **Dashboards → Browse**
2. Look for folder "Dislocation Trader"
3. Should see 5 dashboards:
   - Overview
   - Spreads
   - Opportunities
   - Executions
   - System Health

If dashboards don't appear:
- Check Grafana logs: `docker-compose logs grafana`
- Verify provisioning config: `cat grafana/provisioning/dashboards/default.yml`
- Verify dashboard JSON files exist in `grafana/dashboards/`
- Restart Grafana: `docker-compose restart grafana`

### 3. Test Each Dashboard

#### Overview Dashboard

**Expected behavior with empty data:**
- All stats show 0 or N/A
- Tables show "No data" or empty rows
- Time series graphs show empty axes

**Expected behavior with data:**
- System Status shows count of connected venues (green if ≥3)
- Quotes/sec shows positive number
- Connector Health table shows venue status
- Risk State table shows chain limits

**Test checklist:**
- [ ] Dashboard loads without errors
- [ ] All panels render (no red error boxes)
- [ ] Template variables load (pair, chain dropdowns)
- [ ] Time picker works
- [ ] Auto-refresh works (check top-right)

#### Spreads Dashboard

**Key queries to test:**
```sql
-- Should return CEX price data
SELECT COUNT(*) FROM quote_rollups WHERE venue_id IN (SELECT id FROM venues WHERE venue_type = 'cex');

-- Should return DEX price data
SELECT COUNT(*) FROM quote_rollups WHERE venue_id IN (SELECT id FROM venues WHERE venue_type = 'dex');

-- Should return spread events
SELECT COUNT(*) FROM opportunities;
```

**Test checklist:**
- [ ] CEX vs DEX overlay renders (even if empty)
- [ ] Spread scatter plot shows points (if opportunities exist)
- [ ] Spread histogram works
- [ ] Spread heatmap renders
- [ ] Template variables filter correctly ($pair, $chain)

#### Opportunities Dashboard

**Expected panels:**
- Opportunities per Hour (bar chart)
- By Status (pie chart)
- Skip Reasons (donut chart)
- Recent Opportunities table

**Test checklist:**
- [ ] All visualizations load
- [ ] Status pie chart shows breakdown (or "No data")
- [ ] Skip reasons are aggregated correctly
- [ ] Recent opportunities table has proper color coding
- [ ] Template variable filtering works

#### Executions Dashboard

**Expected panels:**
- Cumulative PnL (line chart)
- PnL per Trade (scatter)
- Win Rate, Avg Win/Loss stats
- Slippage distribution
- Recent Executions table with tx_hash links

**Test checklist:**
- [ ] PnL chart renders with threshold line at 0
- [ ] Stats show percentages correctly
- [ ] Table shows tx_hash as clickable link (if data exists)
- [ ] Status column has color coding
- [ ] Slippage histogram works

#### Health Dashboard

**Expected panels:**
- Connector Status Timeline (state chart)
- Quote Freshness gauges
- RPC Latency time series
- Connector Health Details table
- Risk State table

**Test checklist:**
- [ ] State timeline shows connection status over time
- [ ] Gauges show seconds since last quote with color thresholds
- [ ] Health table has conditional formatting (green/yellow/red)
- [ ] Risk state table shows per-chain limits
- [ ] Template variable ($venue) filters correctly

### 4. Test Query Performance

Run this in PostgreSQL to check dashboard query performance:

```sql
-- Enable query timing
\timing on

-- Test a typical dashboard query
EXPLAIN ANALYZE
SELECT COUNT(*) FROM connector_health WHERE ws_connected = true;

-- Test rollup query
EXPLAIN ANALYZE
SELECT interval_start, close_mid
FROM quote_rollups
WHERE interval_start > now() - interval '1 hour'
  AND interval_type = '1s'
ORDER BY interval_start;
```

**Target:** All queries should complete in <2 seconds.

If queries are slow:
- Check indexes exist: `\di` in psql
- Check table sizes: `SELECT pg_size_pretty(pg_total_relation_size('table_name'));`
- Consider adding indexes on frequently filtered columns

### 5. Test Template Variables

For each dashboard with template variables:

1. **Change pair filter:**
   - Select specific pair from dropdown
   - Verify panels update with filtered data
   - Check query inspector (⋮ menu → Inspect → Query) shows correct WHERE clause

2. **Change chain filter:**
   - Toggle between "All", "base", "mainnet"
   - Verify panels filter correctly

3. **Test "All" option:**
   - Should show data from all pairs/chains/venues
   - Aggregations should sum across all items

### 6. Test Time Range Selection

1. Use time picker to set:
   - Last 5 minutes
   - Last 1 hour
   - Last 6 hours
   - Last 24 hours
   - Custom range

2. Verify:
   - Panels update with new data
   - No query errors
   - Load time remains <2s per panel

### 7. Test Auto-Refresh

1. Set refresh interval to 10s (default)
2. Watch panels update automatically
3. Try other intervals: 5s, 30s, 1m
4. Verify pause button works

## Common Issues

### Issue: Dashboard shows "no data" but database has rows

**Diagnosis:**
```sql
-- Check if data exists in time range
SELECT MIN(ts), MAX(ts) FROM quotes_raw;
SELECT MIN(detected_at), MAX(detected_at) FROM opportunities;
SELECT MIN(created_at), MAX(created_at) FROM executions;
```

**Solution:** Adjust Grafana time range to match data timestamps.

### Issue: Template variable shows no options

**Diagnosis:**
- Check query in template variable definition
- Test query directly in PostgreSQL:
  ```sql
  SELECT id as __value, canonical as __text FROM pairs WHERE is_enabled = true;
  ```

**Solution:**
- Verify table has data
- Check datasource is correct
- Restart Grafana: `docker-compose restart grafana`

### Issue: Panels show query errors

**Diagnosis:**
- Check Grafana logs: `docker-compose logs -f grafana`
- Use panel menu → Inspect → Query to see SQL
- Test SQL directly in PostgreSQL

**Common errors:**
- Column doesn't exist → Check schema version
- Syntax error → Check template variable syntax `${var:csv}`
- Permission denied → Check postgres user grants

**Solution:**
- Fix query syntax in dashboard JSON
- Update database schema if needed
- Grant necessary permissions

### Issue: Performance is slow (>2s per panel)

**Diagnosis:**
```sql
-- Check table sizes
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
  n_live_tup as rows
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Check for missing indexes
SELECT
  schemaname,
  tablename,
  attname,
  n_distinct,
  correlation
FROM pg_stats
WHERE schemaname = 'public'
  AND tablename IN ('quotes_raw', 'opportunities', 'executions')
ORDER BY tablename, attname;
```

**Solution:**
- Add indexes on filtered columns (ts, pair_id, venue_id, chain)
- Use `quote_rollups` instead of `quotes_raw` for time series
- Add LIMIT clauses to table queries
- Consider partitioning `quotes_raw` by time

## Testing with Sample Data

If database is empty, you can insert sample data for testing:

```sql
-- Insert sample venue
INSERT INTO venues (name, venue_type, is_anchor, is_enabled)
VALUES ('test_binance', 'cex', true, true);

-- Insert sample pair
INSERT INTO pairs (base_asset, quote_asset, is_enabled)
VALUES ('WETH', 'USDC', true);

-- Insert sample opportunity
INSERT INTO opportunities (
  pair_id, chain, anchor_venue_id, anchor_mid,
  dex_venue_id, dex_mid, spread_bps, direction, status
) VALUES (
  1, 'base', 1, 1850.50,
  2, 1853.00, 25.5, 'buy_dex', 'detected'
);

-- Insert sample execution
INSERT INTO executions (
  opportunity_id, pair_id, chain, direction,
  pool_address, input_token, input_amount,
  is_paper_trade, status, realized_pnl_usd
) VALUES (
  1, 1, 'base', 'buy_dex',
  '0x1234...', 'USDC', 1000000000,
  true, 'confirmed', 5.50
);
```

## Acceptance Criteria

All dashboards pass testing when:

- [ ] All 5 dashboards load without errors
- [ ] No red error boxes in any panel
- [ ] Template variables populate and filter correctly
- [ ] Time range selection works for all panels
- [ ] Auto-refresh updates panels every 10s
- [ ] Queries complete in <2s (check browser Network tab)
- [ ] Color thresholds work (green/yellow/red backgrounds)
- [ ] Tables have proper formatting and sorting
- [ ] Links work (e.g., tx_hash → Basescan)
- [ ] Grafana logs show no errors
- [ ] PostgreSQL logs show no query errors

## Next Steps

After dashboards are verified:

1. **Add alerting rules** (see grafana/README.md for examples)
2. **Set up Telegram notifications** for critical alerts
3. **Create dashboard snapshots** for documentation
4. **Set up dashboard versioning** in git
5. **Document dashboard changes** in commit messages
6. **Test with production data** volumes
7. **Optimize slow queries** based on actual usage patterns

## Resources

- [Grafana PostgreSQL Datasource Docs](https://grafana.com/docs/grafana/latest/datasources/postgres/)
- [Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/)
- [Grafana Provisioning Docs](https://grafana.com/docs/grafana/latest/administration/provisioning/)
- Project spec: `/docs/spec-additions.md` Section 7 (Phase 4 tasks)
