# Testing the Overview Dashboard

## Quick Test Steps

### 1. Verify Infrastructure is Running
```bash
cd /Users/will/dev/blockhelix
docker-compose ps
```

Expected output:
- postgres: healthy
- grafana: running
- (trader service if implemented)

### 2. Access Grafana
```bash
open http://localhost:3000
```

Login:
- Username: `admin`
- Password: `admin` (or from env var)

### 3. Verify Datasource
1. Navigate to: Configuration > Data Sources
2. Click "PostgreSQL"
3. Scroll down and click "Save & Test"
4. Should see: "Database Connection OK"

### 4. Load the Dashboard
1. Navigate to: Dashboards > Browse
2. Look for folder "Dislocation Trader"
3. Click "Overview - Live Monitoring"

### 5. Check Panel Loading

#### With No Data (Expected Initially)
All panels should load without errors and show:
- "No data" message in time series panels
- "0" or "N/A" in stat panels
- Empty tables

#### With Test Data
If database has been seeded with test data:
- Time series should show lines
- Stats should show numbers > 0
- Tables should populate with rows

## Manual Data Insertion for Testing

### Insert Test Venues
```sql
INSERT INTO venues (name, venue_type, chain, is_anchor, is_enabled)
VALUES
  ('binance', 'cex', NULL, true, true),
  ('coinbase', 'cex', NULL, false, true),
  ('bybit', 'cex', NULL, false, true),
  ('uniswap_v3', 'dex', 'base', false, true)
ON CONFLICT (name) DO NOTHING;
```

### Insert Test Pair
```sql
INSERT INTO pairs (base_asset, quote_asset, is_enabled)
VALUES ('WETH', 'USDC', true)
ON CONFLICT (base_asset, quote_asset) DO NOTHING;
```

### Insert Test Quotes
```sql
-- Get venue and pair IDs
DO $$
DECLARE
  binance_id INT;
  coinbase_id INT;
  bybit_id INT;
  uniswap_id INT;
  weth_usdc_id INT;
BEGIN
  SELECT id INTO binance_id FROM venues WHERE name = 'binance';
  SELECT id INTO coinbase_id FROM venues WHERE name = 'coinbase';
  SELECT id INTO bybit_id FROM venues WHERE name = 'bybit';
  SELECT id INTO uniswap_id FROM venues WHERE name = 'uniswap_v3';
  SELECT id INTO weth_usdc_id FROM pairs WHERE canonical = 'WETH/USDC';

  -- Insert sample quotes over 15 minute range
  INSERT INTO quotes_raw (ts, received_at, venue_id, pair_id, chain, bid, ask, mid, is_stale)
  SELECT
    now() - (interval '1 second' * generate_series(0, 900, 10)) as ts,
    now() as received_at,
    binance_id,
    weth_usdc_id,
    NULL,
    3250.00 + (random() * 10 - 5) as bid,
    3250.50 + (random() * 10 - 5) as ask,
    3250.25 + (random() * 10 - 5) as mid,
    false;

  INSERT INTO quotes_raw (ts, received_at, venue_id, pair_id, chain, bid, ask, mid, is_stale)
  SELECT
    now() - (interval '1 second' * generate_series(0, 900, 10)) as ts,
    now() as received_at,
    uniswap_id,
    weth_usdc_id,
    'base',
    3250.00 + (random() * 15 - 7.5) as bid,
    3250.50 + (random() * 15 - 7.5) as ask,
    3250.25 + (random() * 15 - 7.5) as mid,
    false;
END $$;
```

### Insert Test Connector Health
```sql
INSERT INTO connector_health (venue_id, chain, last_quote_at, ws_connected, reconnect_count, error_count, updated_at)
SELECT
  v.id,
  CASE WHEN v.venue_type = 'dex' THEN 'base' ELSE NULL END,
  now() - interval '5 seconds',
  true,
  0,
  0,
  now()
FROM venues v
ON CONFLICT (venue_id, chain) DO UPDATE
SET
  last_quote_at = EXCLUDED.last_quote_at,
  ws_connected = EXCLUDED.ws_connected,
  updated_at = EXCLUDED.updated_at;
```

### Insert Test Opportunities
```sql
INSERT INTO opportunities (
  detected_at, pair_id, chain,
  anchor_venue_id, anchor_mid,
  dex_venue_id, dex_mid,
  spread_bps, direction, status
)
SELECT
  now() - (interval '1 minute' * generate_series(1, 5)),
  (SELECT id FROM pairs WHERE canonical = 'WETH/USDC'),
  'base',
  (SELECT id FROM venues WHERE name = 'binance'),
  3250.00 + (random() * 10 - 5),
  (SELECT id FROM venues WHERE name = 'uniswap_v3'),
  3250.00 + (random() * 20 - 10),
  10 + (random() * 40),
  CASE WHEN random() > 0.5 THEN 'buy_dex' ELSE 'sell_dex' END,
  CASE
    WHEN random() > 0.7 THEN 'detected'
    WHEN random() > 0.4 THEN 'skipped'
    ELSE 'evaluating'
  END;
```

## Connect to Database

### Via Docker
```bash
docker-compose exec postgres psql -U trader -d dislocation_trader
```

### Via psql (if installed locally)
```bash
psql -h localhost -p 5432 -U trader -d dislocation_trader
```

Password: `devpassword` (or from your .env)

## Verification Checklist

### Panel 1: Live Quote Prices
- [ ] Multiple colored lines visible
- [ ] Lines move/update as data changes
- [ ] Legend shows venue names
- [ ] Prices are in reasonable range (e.g., $2000-$4000 for WETH/USDC)
- [ ] No error messages

### Panel 2: Real-Time Spread
- [ ] Spread line visible
- [ ] Values oscillate around 0 bps
- [ ] Color changes based on threshold (green near 0, red at extremes)
- [ ] Legend shows statistics (last, mean, max, min)
- [ ] No "No data" or errors

### Panel 3: Opportunities (15m)
- [ ] Shows a number >= 0
- [ ] Number matches test data if inserted
- [ ] Color changes (green if > 0)

### Panel 4: Avg Spread (15m)
- [ ] Shows a number
- [ ] Background color reflects value
- [ ] Reasonable value (e.g., 10-30 bps if opportunities exist)

### Panel 5: Quote Counts by Venue
- [ ] Horizontal bars for each venue
- [ ] Bar lengths proportional to quote counts
- [ ] Colors indicate health (green = many quotes)
- [ ] All expected venues present

### Panel 6: Connector Health Status
- [ ] Table shows all venues
- [ ] Connected column shows "Online"/"Offline"
- [ ] seconds_ago shows small values (< 10s ideally)
- [ ] Colors indicate status (green = healthy)
- [ ] Reconnect and error counts visible

### Panel 7: Recent Opportunities
- [ ] Table populated with opportunities if any exist
- [ ] Columns: detected_at, pair, chain, spread_bps, direction, status, etc.
- [ ] Spread values color-coded
- [ ] Status values color-coded
- [ ] Sorted by detected_at descending (newest first)

## Dashboard Settings to Verify

### Top-Right Controls
- [ ] Time range shows "Last 15 minutes"
- [ ] Refresh dropdown shows "5s"
- [ ] Auto-refresh is active (icon spinning every 5s)

### Dashboard Behavior
- [ ] Panels refresh automatically every 5 seconds
- [ ] Time range can be changed (test: "Last 5 minutes", "Last 1 hour")
- [ ] Zoom in/out works on time series panels
- [ ] Tooltips show on hover
- [ ] Tables are sortable by clicking column headers

## Troubleshooting

### "Database Connection Failed"
```bash
docker-compose logs postgres
docker-compose logs grafana
```

Check if Postgres is accepting connections:
```bash
docker-compose exec postgres pg_isready -U trader
```

### "No data" in all panels
1. Check if database has data:
```sql
SELECT COUNT(*) FROM quotes_raw;
SELECT COUNT(*) FROM venues;
SELECT COUNT(*) FROM pairs;
```

2. Check timestamp filters:
```sql
SELECT MIN(ts), MAX(ts) FROM quotes_raw;
```

3. Verify current time is correct:
```sql
SELECT now();
```

### Queries returning errors
1. Check Grafana logs:
```bash
docker-compose logs grafana | grep -i error
```

2. Test query directly in PostgreSQL:
```bash
docker-compose exec postgres psql -U trader -d dislocation_trader
```

Then paste problematic query and see actual error.

### Panels loading slowly (> 2 seconds)
1. Check query performance:
```sql
EXPLAIN ANALYZE [your query here];
```

2. Verify indexes exist:
```sql
\d quotes_raw
```

Should show indexes on: ts, venue_id, pair_id

3. Check table size:
```sql
SELECT pg_size_pretty(pg_relation_size('quotes_raw'));
SELECT COUNT(*) FROM quotes_raw;
```

## Performance Benchmarks

Target panel load times:
- Stats (panels 3, 4): < 200ms
- Tables (panels 6, 7): < 500ms
- Time series (panels 1, 2): < 2s
- Bar gauge (panel 5): < 300ms

If exceeding these, consider:
1. Reducing time range
2. Adding sampling to queries
3. Using quote_rollups instead of quotes_raw
4. Adding database indexes

## Next Steps After Verification

1. If dashboard loads correctly: Start collecting real data
2. If queries work but slow: Optimize with indexes and sampling
3. If all panels working: Configure alerts (future enhancement)
4. Document any issues found for future reference
