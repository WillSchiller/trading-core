# Quick Reference: Dashboard Pair Filtering

## Current Trading Pairs (6 total)

| Pair | ID | Description |
|------|----|--------------| 
| **WETH/USDC** | 1 | Primary pair, all venues |
| **cbETH/WETH** | 2 | Coinbase ETH liquid staking |
| **weETH/WETH** | 5 | EtherFi wrapped ETH |
| **wstETH/WETH** | 6 | Lido wrapped staked ETH |
| **rETH/WETH** | 7 | Rocket Pool ETH |
| **USDC/USDbC** | 8 | Bridged USDC pair |

## Using Pair Filters in Dashboards

### Select Single Pair
1. Open dashboard (spreads, opportunities, executions, pnl-analysis, overview)
2. Click "Pair" dropdown at top
3. Choose pair (e.g., "cbETH/WETH")
4. All panels update automatically

### View All Pairs
1. Open dashboard
2. Select "All" from Pair dropdown
3. See aggregated data across all pairs

## SQL Query Pattern

```sql
-- Single pair or all pairs
WHERE (${pair} = 0 OR pair_id = ${pair})

-- Time-based filtering
AND ts BETWEEN $__timeFrom() AND $__timeTo()
```

## Add New Pair (Quick)

```sql
-- 1. Add to database
INSERT INTO pairs (base_asset, quote_asset, is_enabled)
VALUES ('TOKEN', 'USDC', true);

-- 2. Add venue config (example)
INSERT INTO pair_venue_config (pair_id, venue_id, chain, pool_address, is_enabled)
VALUES (
  (SELECT id FROM pairs WHERE canonical = 'TOKEN/USDC'),
  (SELECT id FROM venues WHERE name = 'uniswap_v3'),
  'base',
  '0x1234...', 
  true
);

-- 3. Restart app
-- Pair appears in dropdowns automatically!
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No pairs in dropdown | Run `npm run db:seed` |
| Pair shows no data | Check data collectors running |
| Query errors | Check browser console (F12) |
| Duplicate data with "All" | Add `GROUP BY pair_id` to query |

## Files

- Dashboards: `/Users/will/dev/blockhelix/grafana/dashboards/*.json`
- Config: `/Users/will/dev/blockhelix/config/pairs.json`
- Schema: `/Users/will/dev/blockhelix/sql/001_initial_schema.sql`
- Full docs: `/Users/will/dev/blockhelix/PAIR_FILTER_UPDATE.md`

---
Updated: 2026-01-20
