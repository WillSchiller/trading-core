# Grafana Dashboard Pair Filtering - Update Complete

## Overview
All Grafana dashboards now support dynamic pair filtering, allowing you to view data for any trading pair configured in the database.

## What Was Updated

### 1. Dashboard Template Variables
Updated 5 dashboards with standardized pair filtering:
- `/Users/will/dev/blockhelix/grafana/dashboards/executions.json` ✓
- `/Users/will/dev/blockhelix/grafana/dashboards/opportunities.json` ✓
- `/Users/will/dev/blockhelix/grafana/dashboards/overview.json` ✓
- `/Users/will/dev/blockhelix/grafana/dashboards/pnl-analysis.json` ✓
- `/Users/will/dev/blockhelix/grafana/dashboards/spreads.json` ✓

### 2. Template Variable Configuration
All dashboards now use this standardized configuration:

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

**Key Features:**
- Queries `pairs` table dynamically (no hardcoded pairs)
- Only shows enabled pairs (`is_enabled = true`)
- Sorted alphabetically by pair name
- Includes "All" option to view all pairs simultaneously
- Auto-refreshes on dashboard load

### 3. Query Updates
All panel queries in `spreads.json` updated to handle both:
- **Single pair selection**: `WHERE pair_id = ${pair}`
- **"All" selection**: `WHERE (${pair} = 0 OR pair_id = ${pair})`

Example before:
```sql
WHERE q.pair_id = $pair
```

Example after:
```sql
WHERE (${pair} = 0 OR q.pair_id = ${pair})
```

## Available Trading Pairs

The database currently has **6 enabled trading pairs**:

| Pair | ID | Venues |
|------|----|---------| 
| WETH/USDC | 1 | Binance, Coinbase, Bybit, Uniswap v3, Aerodrome |
| cbETH/WETH | 2 | Coinbase, Uniswap v3 |
| weETH/WETH | 5 | Uniswap v3 |
| wstETH/WETH | 6 | Uniswap v3 |
| rETH/WETH | 7 | Uniswap v3 |
| USDC/USDbC | 8 | Uniswap v3 |

All pairs are automatically available in dashboard dropdowns.

## How to Use

### Viewing a Specific Pair
1. Open any dashboard (spreads, opportunities, executions, pnl-analysis, overview)
2. Find the "Pair" dropdown at the top of the dashboard
3. Select a specific pair (e.g., "cbETH/WETH")
4. All panels automatically filter to show only that pair's data

### Viewing All Pairs
1. Open any dashboard
2. Select "All" from the "Pair" dropdown
3. Panels will show aggregated data across all pairs
4. Tables will show data from all pairs with pair name in a column

### Example Screenshots
```
[Pair Dropdown]  [Chain Dropdown]
   WETH/USDC         base
   cbETH/WETH        all
   weETH/WETH
   wstETH/WETH
   rETH/WETH
   USDC/USDbC
   All             ← Shows all pairs
```

## Adding New Pairs

To add a new trading pair to the system:

### 1. Insert into Database
```sql
INSERT INTO pairs (base_asset, quote_asset, is_enabled)
VALUES ('TOKEN', 'USDC', true);
```

The `canonical` column is auto-generated as `BASE/QUOTE` (e.g., `TOKEN/USDC`).

### 2. Add Venue Configuration
```sql
INSERT INTO pair_venue_config (pair_id, venue_id, chain, pool_address, ...)
VALUES (
  (SELECT id FROM pairs WHERE canonical = 'TOKEN/USDC'),
  (SELECT id FROM venues WHERE name = 'uniswap_v3'),
  'base',
  '0x...',  -- pool address
  ...
);
```

### 3. Update Config File
Add the pair to `/Users/will/dev/blockhelix/config/pairs.json`:

```json
{
  "pairs": [
    ...existing pairs...,
    {
      "base": "TOKEN",
      "quote": "USDC",
      "chain": "base",
      "tier": 1,
      "venues": {
        "uniswap_v3": {
          "base": [
            { "pool": "0x...", "feeTier": 500, "primary": true }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 30,
        "minDurationMs": 2000,
        "minLiquidityUsd": 100000,
        "maxTradeSizeUsd": 500
      }
    }
  ]
}
```

### 4. Restart Services
```bash
npm run dev  # or restart the app
```

The new pair will **automatically appear** in all dashboard dropdowns - no dashboard changes needed!

## Technical Details

### Variable Interpolation
Grafana supports two syntaxes for template variables:
- `$pair` - Simple interpolation
- `${pair}` - Advanced interpolation (used in this implementation)

The `${pair}` syntax is required for expressions like `(${pair} = 0 OR pair_id = ${pair})`.

### "All" Option Handling
When "All" is selected:
- `${pair}` resolves to `"0"` (the `allValue` setting)
- Queries use `(${pair} = 0 OR pair_id = ${pair})` to match all pairs
- Since no pair has `id = 0`, this effectively removes the filter

### Query Performance
- All queries use proper indexes (`idx_quotes_raw_venue_pair`, etc.)
- Time-based filtering uses Grafana's `$__timeFrom()` and `$__timeTo()` macros
- "All" queries may be slower with many pairs - consider limiting time ranges

## Dashboards Without Pair Filtering

These dashboards intentionally don't have pair filtering:
- **health.json**: Shows system-wide health metrics (connectors, RPC status)
- **slippage-curves.json**: Analysis dashboard, not pair-specific
- **trading-summary.json**: High-level summary metrics

## Testing the Changes

### 1. Load a Dashboard
```bash
# Open Grafana (default: http://localhost:3000)
# Navigate to: Dashboards > Spreads - Live
```

### 2. Test Pair Selection
- Select "WETH/USDC" - should show WETH/USDC data
- Select "cbETH/WETH" - should show cbETH/WETH data
- Select "All" - should show data from all pairs

### 3. Verify Data Display
- Check time series charts update correctly
- Check tables show pair column when "All" is selected
- Verify no "No data" errors (unless tables are empty)

### 4. Check Query Errors
- Open browser dev tools (F12)
- Check Console for SQL errors
- All queries should return successfully (or return empty results)

## Common Issues

### Issue: Dropdown Shows No Options
**Cause**: Database not seeded with pairs  
**Solution**:
```bash
npm run db:seed
```

### Issue: Selected Pair Shows No Data
**Cause**: No quotes collected for that pair yet  
**Solution**: 
- Check data collectors are running
- Verify pair is configured in `config/pairs.json`
- Check `connector_health` table for connection status

### Issue: "All" Option Shows Duplicate Data
**Cause**: Panel query doesn't group by pair  
**Solution**: Add `GROUP BY pair_id` or join `pairs` table to show pair name

### Issue: Query Returns "column ambiguous" Error
**Cause**: Multiple tables have same column (e.g., `pair_id`)  
**Solution**: Qualify column with table alias: `q.pair_id` instead of `pair_id`

## Files Modified

```
/Users/will/dev/blockhelix/grafana/dashboards/spreads.json
/Users/will/dev/blockhelix/grafana/dashboards/overview.json
```

All other dashboards already had the correct configuration.

## Rollback Instructions

If you need to rollback these changes:

```bash
cd /Users/will/dev/blockhelix
git diff grafana/dashboards/spreads.json
git checkout grafana/dashboards/spreads.json
git checkout grafana/dashboards/overview.json
```

Then restart Grafana to load the old dashboards.

## Next Steps

1. **Test the dashboards** with different pair selections
2. **Add more pairs** as needed using the instructions above
3. **Create pair-specific alerts** using the pair variable
4. **Consider adding multi-select** by changing `"multi": false` to `"multi": true`

## Questions?

Refer to:
- Database schema: `/Users/will/dev/blockhelix/sql/001_initial_schema.sql`
- Pair config: `/Users/will/dev/blockhelix/config/pairs.json`
- Grafana docs: https://grafana.com/docs/grafana/latest/dashboards/variables/

---

**Last Updated**: 2026-01-20
**Dashboard Version**: 3
**Schema Version**: 001
