# Dashboard Testing Quick Reference

## Run Tests

```bash
npm run test:dashboards              # All dashboard tests
npm test tests/unit/dashboards       # Alternative syntax
./scripts/validate-dashboards.sh     # Validation script
```

## Common Errors and Fixes

### Error: "pair_id is quoted but should be numeric"

**Bad:**
```sql
WHERE pair_id = '${pair}'
```

**Good:**
```sql
WHERE pair_id = ${pair}
```

**Rule:** Numeric IDs (pair_id, venue_id, id) should NOT be quoted.

---

### Error: "strategy should be quoted in string comparison"

**Bad:**
```sql
WHERE strategy = ${strategy}
```

**Good:**
```sql
WHERE strategy = '${strategy}'
```

**Rule:** String values (strategy, direction, status) MUST be quoted.

---

### Error: "uses bare variables: $pair"

**Bad:**
```sql
WHERE pair_id = $pair
```

**Good:**
```sql
WHERE pair_id = ${pair}
```

**Rule:** Always use `${var}` syntax, never `$var`.

---

### Error: "variable ${pair} used without includeAll conditional logic"

**Bad:**
```sql
WHERE pair_id = ${pair}
```

**Good:**
```sql
WHERE (${pair} = 0 OR pair_id = ${pair})
```

**Rule:** Variables with `includeAll: true` need conditional OR logic.

---

### Error: "uses ts but missing time macros"

**Bad:**
```sql
SELECT ts as time, mid FROM quotes_raw WHERE pair_id = 1
```

**Good:**
```sql
SELECT ts as time, mid FROM quotes_raw
WHERE ts BETWEEN $__timeFrom() AND $__timeTo()
  AND pair_id = 1
```

**Rule:** Always filter time columns with Grafana time macros.

---

### Error: "queries quotes_raw without time filter"

**Bad:**
```sql
SELECT * FROM quotes_raw WHERE pair_id = 1
```

**Good:**
```sql
SELECT ts, mid FROM quotes_raw
WHERE ts BETWEEN $__timeFrom() AND $__timeTo()
  AND pair_id = 1
ORDER BY ts
LIMIT 1000
```

**Rule:** Never scan quotes_raw without time filter (performance).

---

### Error: "aggregates quotes_raw (should use quote_rollups)"

**Bad:**
```sql
SELECT DATE_TRUNC('minute', ts) as time, AVG(mid)
FROM quotes_raw
GROUP BY time
```

**Good:**
```sql
SELECT interval_start as time, close_mid as value
FROM quote_rollups
WHERE interval_type = '1m'
  AND interval_start BETWEEN $__timeFrom() AND $__timeTo()
```

**Rule:** Use quote_rollups for aggregated time series.

---

### Error: "uses AVG without NULL handling"

**Bad:**
```sql
SELECT AVG(spread_bps) FROM opportunities
```

**Good:**
```sql
SELECT AVG(spread_bps) FROM opportunities
WHERE spread_bps IS NOT NULL
```

**Rule:** Always handle NULLs explicitly in aggregates.

---

### Error: "selects detected_at but doesn't alias as 'time'"

**Bad:**
```sql
SELECT detected_at, spread_bps FROM opportunities
```

**Good:**
```sql
SELECT detected_at as time, spread_bps as value
FROM opportunities
ORDER BY time
```

**Rule:** Grafana requires time column aliased as `time`.

---

### Error: "time_series format but no 'metric' alias"

**Bad:**
```sql
SELECT ts as time, mid as value
FROM quotes_raw
JOIN venues v ON v.id = venue_id
```

**Good:**
```sql
SELECT ts as time, mid as value, v.name as metric
FROM quotes_raw
JOIN venues v ON v.id = venue_id
```

**Rule:** Multiple series need `metric` alias for series name.

---

### Error: "has JOINs but no table aliases"

**Bad:**
```sql
SELECT quotes_raw.ts, venues.name
FROM quotes_raw
JOIN venues ON venues.id = quotes_raw.venue_id
```

**Good:**
```sql
SELECT q.ts as time, v.name as metric
FROM quotes_raw q
JOIN venues v ON v.id = q.venue_id
```

**Rule:** Use short table aliases (q, v, p) in JOINs.

---

### Error: "has ORDER BY but no LIMIT"

**Bad:**
```sql
SELECT * FROM executions ORDER BY created_at DESC
```

**Good:**
```sql
SELECT created_at, status, tx_hash
FROM executions
ORDER BY created_at DESC
LIMIT 100
```

**Rule:** Always LIMIT ordered queries (prevent huge results).

---

## Template Variable Cheat Sheet

### Query Variable (from database)

```json
{
  "name": "pair",
  "type": "query",
  "label": "Pair",
  "datasource": {"type": "postgres", "uid": "postgresql"},
  "definition": "SELECT id as __value, canonical as __text FROM pairs WHERE is_enabled = true ORDER BY canonical",
  "refresh": 1,
  "multi": false,
  "includeAll": true,
  "allValue": "0",
  "current": {},
  "options": []
}
```

**Usage in SQL:**
```sql
WHERE (${pair} = 0 OR pair_id = ${pair})
```

### Custom Variable (static list)

```json
{
  "name": "strategy",
  "type": "custom",
  "label": "Strategy",
  "query": "all : All,dislocation : Dislocation,rank_space : Rank Space",
  "options": [
    {"text": "All", "value": "all", "selected": true},
    {"text": "Dislocation", "value": "dislocation"},
    {"text": "Rank Space", "value": "rank_space"}
  ],
  "current": {"text": "All", "value": "all"},
  "multi": false
}
```

**Usage in SQL:**
```sql
WHERE ('${strategy}' = 'all' OR strategy = '${strategy}')
```

## SQL Query Checklist

Before committing a dashboard, verify:

- [ ] Time columns use `$__timeFrom()` and `$__timeTo()`
- [ ] Numeric variables NOT quoted: `${pair}`
- [ ] String variables ARE quoted: `'${strategy}'`
- [ ] includeAll variables use OR logic: `(${pair} = 0 OR pair_id = ${pair})`
- [ ] Time column aliased: `ts as time`
- [ ] Value column aliased: `mid as value`
- [ ] Series name aliased: `v.name as metric` (if multiple series)
- [ ] JOINs use table aliases: `FROM quotes_raw q JOIN venues v`
- [ ] Aggregations use quote_rollups not quotes_raw
- [ ] NULL handling in aggregates: `WHERE x IS NOT NULL` or `COALESCE(x, 0)`
- [ ] Large queries have LIMIT
- [ ] quotes_raw queries have time filter
- [ ] Format is `time_series` for time series panels

## Grafana Time Macros

| Macro | Description |
|-------|-------------|
| `$__timeFrom()` | Start of dashboard time range |
| `$__timeTo()` | End of dashboard time range |
| `$__timeFilter(column)` | Full WHERE clause for time filtering |

**Best practice:**
```sql
WHERE ts BETWEEN $__timeFrom() AND $__timeTo()
```

## Valid Table Names

- `venues` - CEX/DEX venue definitions
- `pairs` - Trading pair definitions
- `pair_venue_config` - Per-pair-per-venue config
- `quotes_raw` - High-frequency quote samples
- `quote_rollups` - Aggregated OHLC data
- `opportunities` - Detected dislocations
- `executions` - Trade attempts and outcomes
- `connector_health` - WS/RPC connection status
- `risk_state` - Per-chain exposure and limits
- `inventory_log` - Position tracking
- `price_predictions` - ML predictions
- `prediction_outcomes` - Prediction accuracy

## Indexed Columns (Use in WHERE)

- `id`, `venue_id`, `pair_id`
- `ts`, `detected_at`, `created_at`, `confirmed_at`
- `status`, `opportunity_id`
- `interval_start`

## Common Aggregates Pattern

```sql
SELECT
  detected_at as time,
  ROUND(AVG(COALESCE(spread_bps, 0)), 2) as value
FROM opportunities
WHERE detected_at BETWEEN $__timeFrom() AND $__timeTo()
  AND spread_bps IS NOT NULL
  AND (${pair} = 0 OR pair_id = ${pair})
GROUP BY time
ORDER BY time
```

## Time Series Pattern

```sql
SELECT
  q.ts as time,
  q.mid as value,
  v.name as metric
FROM quotes_raw q
JOIN venues v ON v.id = q.venue_id
WHERE q.ts BETWEEN $__timeFrom() AND $__timeTo()
  AND (${pair} = 0 OR q.pair_id = ${pair})
ORDER BY q.ts
```

## Stat Panel Pattern

```sql
SELECT
  ROUND(AVG(spread_bps), 2) as value
FROM opportunities
WHERE detected_at > now() - interval '24 hours'
  AND (${pair} = 0 OR pair_id = ${pair})
  AND spread_bps IS NOT NULL
```

## Table Panel Pattern

```sql
SELECT
  detected_at,
  pair_id,
  spread_bps,
  direction,
  status
FROM opportunities
WHERE detected_at BETWEEN $__timeFrom() AND $__timeTo()
  AND (${pair} = 0 OR pair_id = ${pair})
ORDER BY detected_at DESC
LIMIT 100
```

## Enable Database Validation

```bash
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_DB=dislocation_trader
export POSTGRES_USER=trader
export POSTGRES_PASSWORD=your_password

npm run test:dashboards
```

This validates SQL syntax against actual database schema.

## Get Help

- Test output shows specific errors with file and panel names
- Check `/tests/unit/dashboards/README.md` for detailed examples
- See `/docs/dashboard-testing.md` for comprehensive guide
- Review this file for quick fixes
