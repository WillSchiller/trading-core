# Grafana Dashboards

This directory contains Grafana dashboard definitions and provisioning configuration for the Dislocation Trader system.

## Directory Structure

```
grafana/
├── provisioning/
│   ├── datasources/
│   │   └── postgres.yml          # PostgreSQL datasource configuration
│   └── dashboards/
│       └── default.yml            # Dashboard provisioning config
└── dashboards/
    ├── overview.json              # System health overview
    ├── spreads.json               # Price spreads analysis
    ├── opportunities.json         # Opportunity detection metrics
    ├── executions.json            # Execution tracking and PnL
    ├── pnl-analysis.json          # Comprehensive P&L and performance analysis
    └── health.json                # Connector and system health
```

## Dashboards

### 1. Overview Dashboard (`overview.json`)
Top-level system health at a glance.

**Key Metrics:**
- System Status (connected venues)
- Quotes/sec rate
- Active trading pairs
- Opportunities (24h)
- Executions (24h)
- Paper PnL (24h)
- Win Rate (24h)
- Total Gas (24h)

**Tables:**
- Connector Health (connection status, quote freshness)
- Risk State (exposure, trades, halt status)

**Time Series:**
- Opportunities Over Time
- Cumulative PnL

**Refresh:** 10 seconds
**Default Time Range:** Last 1 hour

### 2. Spreads Dashboard (`spreads.json`)
Core hypothesis validation - CEX vs DEX price analysis.

**Key Visualizations:**
- CEX vs DEX Price Overlay (time series)
- Spread (bps) Over Time (scatter plot with threshold lines)
- Spread Distribution (histogram)
- Spread by Pair (bar chart)
- Spread Heatmap (hour of day vs magnitude)

**Stats:**
- Current Spread
- Avg Spread (1h)
- Max Spread (1h)
- Spread Volatility (1h)

**Template Variables:**
- `$pair` - Trading pair selector
- `$chain` - Chain selector (base/mainnet)

**Refresh:** 10 seconds
**Default Time Range:** Last 1 hour

### 3. Opportunities Dashboard (`opportunities.json`)
Signal quality and opportunity analysis.

**Key Metrics:**
- Total Opportunities
- Avg Spread (absolute)
- Avg Estimated Profit
- Skip Rate

**Visualizations:**
- Opportunities per Hour (bar chart)
- Opportunities by Status (pie chart)
- Skip Reasons (donut chart)
- Opportunities by Pair (horizontal bar chart)
- Opportunities by Chain (bar chart)
- Detection Latency (histogram)

**Tables:**
- Reason Codes Summary
- Recent Opportunities (last 500, with color-coded status and spread)

**Template Variables:**
- `$pair` - Trading pair selector (All available)
- `$chain` - Chain selector (All/base/mainnet)

**Refresh:** 10 seconds
**Default Time Range:** Last 6 hours

### 4. Executions Dashboard (`executions.json`)
Execution quality and PnL tracking.

**Key Metrics:**
- Win Rate
- Avg Win
- Avg Loss
- Total Gas Spent
- Fill Rate
- Total Executions
- Avg Slippage
- Revert Rate

**Visualizations:**
- Cumulative PnL (time series with threshold line)
- PnL per Trade (scatter plot)
- Slippage Distribution (histogram)
- Expected vs Actual Output (scatter plot)
- Executions by Status (pie chart)
- Gas Cost Over Time (time series)
- Executions by Pair (bar chart with count + PnL)

**Tables:**
- Revert Reasons (aggregated)
- Recent Executions (last 500, with tx hash links to Basescan)

**Template Variables:**
- `$pair` - Trading pair selector (All available)
- `$chain` - Chain selector (All/base/mainnet)

**Refresh:** 10 seconds
**Default Time Range:** Last 6 hours

### 5. P&L Analysis Dashboard (`pnl-analysis.json`)
Comprehensive profit/loss analysis and system performance metrics.

**Key Metrics:**
- Total Realized P&L
- Win Rate
- Avg Trade Size
- Total Executions
- Avg Win / Avg Loss
- Largest Win / Largest Loss
- Gas Cost as % of Gross Profit
- Avg Latency (Detection → Execution)
- Fill Rate

**Visualizations:**
- Cumulative P&L Over Time (time series)
- Daily P&L (bar chart)
- Trades Per Day (bar chart)
- Gas Costs Over Time (time series)
- P&L by Trading Pair (horizontal bar chart)
- Win Rate by Pair (horizontal bar chart)
- Volume by Pair (horizontal bar chart)
- Slippage Distribution (histogram)
- Paper vs Live Trades (pie chart)
- Paper vs Live P&L Comparison (dual time series)

**Tables:**
- Top Performing Trades (50 best trades)
- Worst Performing Trades (50 worst trades)

**Template Variables:**
- `$pair` - Trading pair selector (All available)
- `$chain` - Chain selector (All/base/mainnet)
- `$paper_mode` - Trade type filter (All/Paper/Live)

**Refresh:** 30 seconds
**Default Time Range:** Last 7 days

### 6. Health Dashboard (`health.json`)
Operational monitoring - connectors, RPC, risk state.

**Key Metrics:**
- Total Reconnects
- Total Errors
- DEX Block Lag
- Connected Venues

**Visualizations:**
- Connector Status Timeline (state timeline showing connection status)
- Quote Freshness (gauge panels per venue)
- RPC Latency (time series by venue)
- Quote Rate (quotes/sec by venue)
- Reconnect Events (time series)
- Error Count Over Time (time series)

**Tables:**
- Connector Health Details (full status with color coding)
- Risk State by Chain (exposure, trade limits, halt status)

**Template Variables:**
- `$venue` - Venue selector (All available)

**Refresh:** 10 seconds
**Default Time Range:** Last 1 hour

## Provisioning

Dashboards are automatically provisioned when Grafana starts via the configuration in `provisioning/`.

### Datasource
The PostgreSQL datasource is configured in `provisioning/datasources/postgres.yml` and connects to:
- Host: `postgres` (docker service name)
- Port: `5432`
- Database: `dislocation_trader`
- User: `trader`
- Password: from `POSTGRES_PASSWORD` environment variable

### Dashboard Loading
Dashboards are loaded from `provisioning/dashboards/default.yml` which points to the JSON files in the `dashboards/` directory. They are organized in a folder called "Dislocation Trader" in Grafana.

## Usage

### Accessing Grafana
1. Start the system: `docker-compose up -d`
2. Access Grafana at: `http://localhost:3000`
3. Default credentials: `admin` / `admin` (or `GRAFANA_PASSWORD` env var)
4. Navigate to "Dashboards" → "Dislocation Trader" folder

### Template Variables
Most dashboards include template variables at the top:
- **Pair**: Filter by trading pair (e.g., WETH/USDC)
- **Chain**: Filter by blockchain (base, mainnet)
- **Venue**: Filter by data source (Binance, Uniswap v3, etc.)

### Time Range
Use the time picker in the top-right to adjust the time range for all panels.

### Refresh Rate
Dashboards auto-refresh every 10 seconds. You can adjust or pause this in the refresh dropdown.

## Query Best Practices

All dashboard queries follow these conventions:

1. **Time-based filtering**: Use Grafana's `$__timeFrom()` and `$__timeTo()` macros
2. **Efficient aggregation**: Use `quote_rollups` for time series instead of `quotes_raw`
3. **Result limits**: Table queries are limited to 100-500 rows
4. **Template variable filtering**: Use `${pair:csv}` and `${chain:csv}` for SQL WHERE clauses
5. **Performance**: Target <2s panel load times

## Query Examples

### Time Series with Rollups
```sql
SELECT
  interval_start as time,
  close_mid as value
FROM quote_rollups
WHERE interval_start BETWEEN $__timeFrom() AND $__timeTo()
  AND pair_id = $pair
  AND interval_type = '1s'
ORDER BY time;
```

### Histogram Buckets
```sql
SELECT
  width_bucket(spread_bps, -100, 100, 40) as bucket,
  COUNT(*) as count
FROM opportunities
WHERE detected_at > now() - interval '24 hours'
GROUP BY bucket
ORDER BY bucket;
```

### Cumulative Sum
```sql
SELECT
  created_at as time,
  SUM(realized_pnl_usd) OVER (ORDER BY created_at) as cumulative_pnl
FROM executions
WHERE status = 'confirmed'
ORDER BY time;
```

## Panel Types

The dashboards use these Grafana panel types:
- **Stat**: Single value with threshold coloring
- **Time series**: Line charts, scatter plots, bar charts over time
- **Table**: Tabular data with conditional formatting
- **Pie chart / Donut chart**: Categorical distributions
- **Bar chart**: Horizontal/vertical bar comparisons
- **Histogram**: Distribution visualization
- **Gauge**: Single value with min/max range
- **State timeline**: Status changes over time
- **Heatmap**: 2D distribution visualization

## Alerting (Future)

Potential alerting rules to add:
- **Connector Down**: No quotes in 60s → Critical
- **High Revert Rate**: >20% reverts/hour → Warning
- **Negative PnL Streak**: 5+ consecutive losses → Warning
- **Risk Halt**: `is_halted = true` → Critical
- **Quote Staleness**: Any venue stale >30s → Warning

Route alerts to Telegram contact point.

## Development

### Editing Dashboards
1. Modify dashboards in Grafana UI
2. Export as JSON (Dashboard Settings → JSON Model)
3. Save to `dashboards/` directory
4. Restart Grafana to test: `docker-compose restart grafana`

### Testing with Empty Data
Dashboards are designed to handle empty tables gracefully:
- Queries return "No data" messages
- Stats show zero values
- Time series show empty graphs

As data flows in, visualizations will populate automatically.

## Files Reference

| File | Purpose | Queries |
|------|---------|---------|
| `overview.json` | High-level health | 12 panels, 12 queries |
| `spreads.json` | Price analysis | 9 panels, 9 queries |
| `opportunities.json` | Signal quality | 12 panels, 12 queries |
| `executions.json` | Execution metrics | 17 panels, 17 queries |
| `pnl-analysis.json` | P&L and performance | 23 panels, 23 queries |
| `health.json` | System monitoring | 12 panels, 12 queries |

**Total**: 85 panels, 85 queries across 6 dashboards
