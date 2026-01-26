# Grafana Dashboard Filter Fix

## Issue Report
The "Spreads - Live" dashboard was showing "No Data" when filters were selected.

## Root Cause Analysis

### Investigation Steps
1. Checked dashboard JSON at `/Users/will/dev/blockhelix/grafana/dashboards/spreads.json`
2. Examined template variables (pair and strategy filters)
3. Tested queries against live database
4. Analyzed data distribution by strategy and time

### Findings

#### Data Distribution
```sql
-- Opportunities by strategy (24h)
dislocation: 867 total, last opportunity 32 minutes ago
rank_space:  2159 total, last opportunity 11 minutes ago
```

#### The Problem
1. **Default time range was too short**: `now-15m` (15 minutes)
2. **Dislocation opportunities are less frequent**: Last one was 32 minutes ago
3. **When filtering by "dislocation" strategy**: No data in the 15-minute window
4. **Result**: Dashboard showed "No Data" even though data existed

#### Query Logic (Working Correctly)
The template variable filters were functioning correctly:
```sql
-- Pair filter
WHERE (COALESCE(NULLIF('${pair}', ''), '0') = '0' OR pair_id::text = '${pair}')
-- When All selected: pair = '0', condition = true (shows all)
-- When specific pair: pair = '1', condition matches pair_id

-- Strategy filter  
AND ('${strategy}' = 'all' OR strategy = '${strategy}')
-- When All selected: strategy = 'all', condition = true (shows all)
-- When specific strategy: filters to that strategy only
```

## Changes Made

### 1. Extended Default Time Range
**File**: `/Users/will/dev/blockhelix/grafana/dashboards/spreads.json`

```json
// Before
"time": {
  "from": "now-15m",
  "to": "now"
}

// After
"time": {
  "from": "now-1h",
  "to": "now"
}
```

**Rationale**: 1-hour window captures opportunities from both strategies:
- Rank Space: generates frequently (every few seconds)
- Dislocation: generates less frequently (minutes to hours apart)

### 2. Added "All Pairs" Option
```json
// Before
"includeAll": false

// After
"includeAll": true,
"allValue": "0"
```

**Rationale**: Makes it easier for users to see all data without manually selecting each pair.

### 3. Improved Panel Description
```json
"description": "Spread values from detected opportunities - the source of truth for actual trading spreads. If no data appears, try selecting 'All' for both Pair and Strategy, or expand the time range."
```

**Rationale**: Provides user guidance when filters result in no data.

## Testing

### Before Fix
```bash
# Query with pair=1, strategy=dislocation, 15m window
SELECT COUNT(*) FROM opportunities 
WHERE pair_id = 1 
  AND strategy = 'dislocation' 
  AND detected_at > now() - interval '15 minutes';
# Result: 0 rows
```

### After Fix
```bash
# Query with pair=1, strategy=dislocation, 1h window
SELECT COUNT(*) FROM opportunities 
WHERE pair_id = 1 
  AND strategy = 'dislocation' 
  AND detected_at > now() - interval '1 hour';
# Result: 2 rows
```

## Verification Commands

Test the dashboard queries directly:

```bash
# Connect to database
docker exec -i dislocation-postgres psql -U trader -d dislocation_trader

# Check data availability
SELECT 
  pair_id,
  strategy,
  COUNT(*) as count,
  MAX(detected_at) as latest,
  EXTRACT(EPOCH FROM (now() - MAX(detected_at)))/60 as minutes_ago
FROM opportunities 
GROUP BY pair_id, strategy;

# Test filtered query (15m - OLD)
SELECT COUNT(*) FROM opportunities 
WHERE pair_id = 1 
  AND strategy = 'dislocation' 
  AND detected_at > now() - interval '15 minutes';

# Test filtered query (1h - NEW)
SELECT COUNT(*) FROM opportunities 
WHERE pair_id = 1 
  AND strategy = 'dislocation' 
  AND detected_at > now() - interval '1 hour';
```

## Impact

- Dashboard now shows data for both strategies
- Users can select "All" to see everything
- Better default experience (1h window shows recent activity)
- Helpful descriptions guide users when filters produce no results

## Recommendations

1. Consider adding a "Last Opportunity" timestamp panel to show data freshness
2. Add alert thresholds for when no opportunities are detected within expected timeframes
3. Consider making time range more prominent in dashboard UI
4. Document expected opportunity frequency for each strategy

