# Overview Dashboard - Live Monitoring

## Summary

The Overview dashboard provides real-time monitoring of the dislocation trader system with a focus on live quote collection, spread analysis, and opportunity detection.

## Dashboard Configuration

- **Auto-refresh**: 5 seconds
- **Time range**: Last 15 minutes
- **UID**: `overview`
- **Datasource**: PostgreSQL (uid: `postgresql`)

## Panels

### 1. Live Quote Prices - WETH/USDC (All Venues)
**Type**: Time Series
**Purpose**: Display live price quotes from all venues (CEX and DEX) for WETH/USDC pair

**Query**:
```sql
SELECT ts as time, v.name as metric, mid as value
FROM quotes_raw qr
JOIN venues v ON v.id = qr.venue_id
JOIN pairs p ON p.id = qr.pair_id
WHERE qr.ts BETWEEN $__timeFrom() AND $__timeTo()
  AND p.canonical = 'WETH/USDC'
  AND qr.mid IS NOT NULL
ORDER BY time
```

**Visual Features**:
- Binance: Blue line
- Coinbase: Green line
- Bybit: Purple line
- Uniswap V3: Red line (thicker - 3px width)
- Legend shows: Last value, Mean price

### 2. Real-Time Spread (Binance vs Uniswap) - bps
**Type**: Time Series
**Purpose**: Show the price spread between Binance (CEX anchor) and Uniswap V3 (DEX) in basis points

**Query**:
```sql
WITH binance_quotes AS (
  SELECT ts, pair_id, mid
  FROM quotes_raw qr
  JOIN venues v ON v.id = qr.venue_id
  WHERE v.name = 'binance'
    AND qr.ts BETWEEN $__timeFrom() AND $__timeTo()
    AND qr.mid IS NOT NULL
),
uniswap_quotes AS (
  SELECT ts, pair_id, mid
  FROM quotes_raw qr
  JOIN venues v ON v.id = qr.venue_id
  WHERE v.name = 'uniswap_v3'
    AND qr.ts BETWEEN $__timeFrom() AND $__timeTo()
    AND qr.mid IS NOT NULL
)
SELECT
  GREATEST(b.ts, u.ts) as time,
  10000.0 * (u.mid - b.mid) / b.mid as spread_bps
FROM binance_quotes b
JOIN uniswap_quotes u ON b.pair_id = u.pair_id
WHERE ABS(EXTRACT(EPOCH FROM (b.ts - u.ts))) < 5
ORDER BY time
```

**Thresholds**:
- Red: < -50 bps or > 50 bps (extreme)
- Orange: -50 to -15 bps or 15 to 50 bps (significant)
- Yellow: -15 to -10 bps (moderate)
- Green: -10 to 10 bps (normal)

**Legend shows**: Last value, Mean, Max, Min

### 3. Opportunities (15m)
**Type**: Stat
**Purpose**: Count of opportunities detected in the last 15 minutes

**Query**:
```sql
SELECT COUNT(*) as value
FROM opportunities
WHERE detected_at > now() - interval '15 minutes'
```

**Thresholds**:
- Text color: 0 opportunities
- Green: 1+ opportunities

### 4. Avg Spread (15m)
**Type**: Stat
**Purpose**: Average spread of detected opportunities in the last 15 minutes

**Query**:
```sql
SELECT COALESCE(AVG(spread_bps), 0) as value
FROM opportunities
WHERE detected_at > now() - interval '15 minutes'
```

**Thresholds**:
- Blue: 0-10 bps
- Yellow: 10-20 bps
- Green: 20-50 bps
- Orange: 50+ bps

### 5. Quote Counts by Venue (15m)
**Type**: Bar Gauge (horizontal)
**Purpose**: Visual comparison of quote collection rates across all venues

**Query**:
```sql
SELECT v.name as metric, COUNT(*) as value
FROM quotes_raw qr
JOIN venues v ON v.id = qr.venue_id
WHERE qr.ts > now() - interval '15 minutes'
GROUP BY v.name
ORDER BY value DESC
```

**Thresholds**:
- Red: 0-10 quotes (poor)
- Yellow: 10-100 quotes (low)
- Green: 100+ quotes (healthy)

### 6. Connector Health Status
**Type**: Table
**Purpose**: Real-time status of all data connectors

**Query**:
```sql
SELECT
  v.name as venue,
  ch.chain,
  ch.ws_connected as connected,
  ch.last_quote_at,
  EXTRACT(EPOCH FROM (now() - ch.last_quote_at)) as seconds_ago,
  ch.reconnect_count as reconnects,
  ch.error_count as errors
FROM connector_health ch
JOIN venues v ON v.id = ch.venue_id
ORDER BY ch.ws_connected DESC, ch.last_quote_at DESC NULLS LAST
```

**Column Highlights**:
- **connected**: Green (Online) / Red (Offline)
- **seconds_ago**: Green (0-10s), Yellow (10-30s), Orange (30-60s), Red (60+s)
- **errors**: Green (0), Yellow (1-4), Orange (5-9), Red (10+)

### 7. Recent Opportunities
**Type**: Table
**Purpose**: Detailed view of the most recent 50 opportunities detected

**Query**:
```sql
SELECT
  o.detected_at,
  p.canonical as pair,
  o.chain,
  o.spread_bps,
  o.direction,
  o.status,
  o.anchor_mid as cex_price,
  o.dex_mid as dex_price,
  o.skip_reason
FROM opportunities o
JOIN pairs p ON p.id = o.pair_id
WHERE o.detected_at > now() - interval '15 minutes'
ORDER BY o.detected_at DESC
LIMIT 50
```

**Column Highlights**:
- **spread_bps**: Blue (0-10), Yellow (10-20), Green (20-50), Orange (50+)
- **status**: Color-coded by status (Detected, Evaluating, Skipped, Submitted, Filled, Reverted, Expired)
- **cex_price/dex_price**: Formatted as USD currency with 2 decimals

## Template Variables

### $pair
- **Type**: Query-based
- **Query**: `SELECT id as __value, canonical as __text FROM pairs WHERE is_enabled = true ORDER BY canonical`
- **Purpose**: Filter dashboards by trading pair (not actively used in this dashboard version but available for extension)
- **Multi-select**: No
- **Include All**: No

## Usage Notes

### Starting the System
```bash
cd /Users/will/dev/blockhelix
docker-compose up -d
```

### Accessing the Dashboard
1. Open browser to `http://localhost:3000`
2. Login with credentials:
   - Username: `admin`
   - Password: `admin` (or value from `GRAFANA_PASSWORD` env var)
3. Navigate to: Dashboards > Dislocation Trader > Overview - Live Monitoring

### What to Look For

**Normal Operation**:
- All CEX venues show continuous price updates
- Uniswap V3 updates every 2 seconds (Base block time)
- Spreads oscillate around 0 bps with brief excursions
- Connector health shows "Online" with recent quote timestamps

**Issues to Watch**:
- Flat lines in price chart = stale quotes or disconnected venue
- Large sustained spreads = potential opportunity or data quality issue
- High error counts in connector health = network or API issues
- Negative seconds_ago values or NULL = connector hasn't reported yet

**Opportunity Detection**:
- Watch for spikes in the spread chart exceeding threshold lines
- Check "Opportunities (15m)" stat for detection count
- Review "Recent Opportunities" table for details on detected signals
- Look at skip_reason to understand why opportunities weren't executed

## Troubleshooting

### No data showing
1. Verify system is running: `docker-compose ps`
2. Check if quotes are being collected: `docker-compose logs dislocation-trader`
3. Verify database connection: `docker-compose logs postgres`
4. Check Grafana datasource: Settings > Data Sources > PostgreSQL

### Queries timing out
1. Check if quotes_raw table is too large
2. Consider implementing partitioning (see spec-additions.md)
3. Verify indexes exist on quotes_raw(ts, venue_id, pair_id)

### Dashboard not updating
1. Verify auto-refresh is enabled (check top-right of dashboard)
2. Check browser console for errors
3. Verify Grafana can connect to Postgres: `docker-compose logs grafana`

## Performance Considerations

- The spread calculation query joins two CTEs and may be expensive with large quote volumes
- Consider using quote_rollups table for longer time ranges instead of quotes_raw
- Panel queries target <2s load time; if exceeded, adjust time range or add sampling

## Future Enhancements

1. Add pair selector to filter all panels by specific trading pair
2. Create alert rules for connector disconnections
3. Add panels for cbETH/WETH pair
4. Show quote latency distribution
5. Add block lag indicator for DEX quotes
