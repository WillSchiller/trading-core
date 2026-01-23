# P&L Analysis Dashboard Guide

## Overview

The P&L Analysis dashboard provides comprehensive profit/loss tracking and performance analytics for the Dislocation Trader system. This dashboard focuses specifically on financial performance, trade quality metrics, and cost analysis.

## Dashboard Location

- **File**: `/grafana/dashboards/pnl-analysis.json`
- **Grafana Path**: Dashboards → Dislocation Trader → P&L Analysis
- **URL**: `http://localhost:3000/d/pnl-analysis/pnl-analysis`

## Key Features

### 1. P&L Overview (Top Row)
Four critical stats that summarize overall performance:

- **Total Realized P&L**: Cumulative profit/loss across all trades
  - Green: profitable (>$100)
  - Yellow: break-even (-$0 to $100)
  - Red: losing (<$0)

- **Win Rate**: Percentage of profitable trades
  - Green: >60%
  - Yellow: 50-60%
  - Red: <50%

- **Avg Trade Size**: Average USD value per trade
  - Helps identify if you're trading within risk limits

- **Total Executions**: Total number of trades executed

### 2. Cumulative P&L Chart
Shows profit/loss progression over time with:
- Smooth line interpolation
- Color gradient based on performance
- Threshold lines at -$1000, $0, and $100
- Min/max/last value in legend

**Use Case**: Identify if strategy is consistently profitable or if there are periods of drawdown.

### 3. Daily P&L (Bar Chart)
Daily profit/loss aggregation showing:
- Green bars: profitable days
- Red bars: losing days
- Yellow: break-even days

**Use Case**: Identify patterns - are losses concentrated on certain days? Are there specific market conditions correlating with performance?

### 4. Trades Per Day (Bar Chart)
Volume of trades executed each day.

**Use Case**: Correlate trade frequency with P&L. High trade count but low P&L might indicate insufficient spread thresholds.

### 5. Trade Performance Stats
Four metrics analyzing win/loss characteristics:
- **Avg Win**: Average profit per winning trade
- **Avg Loss**: Average loss per losing trade
- **Largest Win**: Best single trade
- **Largest Loss**: Worst single trade

**Use Case**: Calculate risk/reward ratio. Ideally, avg win should be larger than avg loss.

### 6. Cost Analysis

#### Gas Costs Over Time
Scatter plot showing gas cost per trade.
- Threshold warnings at $5 (yellow) and $10 (red)

**Use Case**: Identify if gas spikes are eating into profits.

#### Gas Cost as % of Gross Profit
Critical efficiency metric.
- Green: <30% (sustainable)
- Yellow: 30-60% (concerning)
- Orange: 60-90% (inefficient)
- Red: >90% (critical)

**Use Case**: If this metric is high, consider:
  - Increasing min spread threshold
  - Reducing trade frequency
  - Waiting for lower gas periods

### 7. By-Pair Breakdown

#### P&L by Trading Pair
Horizontal bar chart showing cumulative P&L per pair.
- Identifies which pairs are most/least profitable

#### Win Rate by Pair
Shows win rate percentage for each pair (minimum 5 trades required).
- Identifies pairs with better signal quality

#### Volume by Pair
Total USD volume traded per pair.
- Shows which pairs get the most action

**Use Case**: Focus on pairs with high win rate and positive P&L. Consider disabling pairs with consistently negative P&L.

### 8. Slippage Distribution
Histogram of realized slippage in basis points.

**Use Case**:
- Most trades should cluster near low slippage (<20 bps)
- Long tail indicates pools with low liquidity
- If p95 slippage is high, consider adjusting min liquidity thresholds

### 9. Execution Quality

#### Avg Latency (Detection → Execution)
Time from opportunity detection to trade execution.
- Green: <500ms (excellent)
- Yellow: 500-1000ms (acceptable)
- Red: >1000ms (slow)

**Use Case**: High latency increases risk of stale prices and failed trades.

#### Fill Rate
Percentage of submitted opportunities that resulted in confirmed trades.
- Green: >95% (excellent)
- Yellow: 80-95% (acceptable)
- Red: <80% (poor)

**Use Case**: Low fill rate indicates:
  - Opportunities disappearing before execution
  - Price moving against you
  - Gas price too low (transactions not being mined)

### 10. Paper vs Live Comparison

#### Paper vs Live Trades (Pie Chart)
Shows distribution of paper vs live trades.

**Use Case**: During testing phase, all trades should be paper. After validation, gradually shift to live.

#### Paper vs Live P&L Comparison (Dual Time Series)
Overlays cumulative P&L for paper and live trades.

**Use Case**:
- Verify paper trades are profitable before going live
- Live P&L should track paper P&L (accounting for gas costs)
- Large divergence indicates execution issues

### 11. Top/Bottom Performing Trades
Two tables showing:
- 50 best trades (highest P&L)
- 50 worst trades (lowest P&L)

**Use Case**: Investigate outliers. What conditions led to best/worst trades?

## Template Variables

### Pair Filter
- **Default**: All
- **Options**: WETH/USDC, cbETH/WETH, etc.
- **Use Case**: Focus analysis on specific trading pair

### Chain Filter
- **Default**: All
- **Options**: base, mainnet
- **Use Case**: Compare performance across chains (Base typically has lower gas)

### Trade Type Filter
- **Default**: All
- **Options**: Paper, Live
- **Use Case**:
  - Set to "Paper" during testing
  - Set to "Live" for production monitoring
  - Set to "All" to compare both

## Time Range

**Default**: Last 7 days

**Recommended Time Ranges by Use Case:**
- **Intraday monitoring**: Last 6-24 hours
- **Performance review**: Last 7 days
- **Strategy validation**: Last 30 days
- **Historical analysis**: Last 90 days

## Refresh Rate

**Default**: 30 seconds (slower than operational dashboards)

**Why 30s?** P&L analysis is strategic, not operational. Faster refresh isn't necessary and reduces database load.

## Key Metrics Interpretation

### Healthy Trading System
- Win rate: 55-70%
- Fill rate: >90%
- Gas cost: <30% of gross profit
- Avg latency: <500ms
- Cumulative P&L: upward trending
- Slippage p95: <50 bps

### Warning Signs
- Win rate: <50% → Strategy not working
- Fill rate: <80% → Execution problems
- Gas cost: >60% of profit → Not sustainable
- Avg latency: >1000ms → Opportunities going stale
- Daily P&L: inconsistent/volatile → High-risk trading
- Slippage p95: >100 bps → Insufficient liquidity

## Workflow Recommendations

### Daily Review (5 minutes)
1. Check Total Realized P&L stat
2. Review Daily P&L bar chart
3. Check Gas Cost % stat
4. Scan Recent Trades table for any anomalies

### Weekly Review (15 minutes)
1. Analyze Cumulative P&L trend
2. Review Win Rate by Pair
3. Identify best/worst performing pairs
4. Check Fill Rate and Latency metrics
5. Review Top/Bottom Performing Trades tables

### Monthly Review (30 minutes)
1. Calculate Sharpe ratio manually (if desired)
2. Compare Paper vs Live P&L
3. Analyze Slippage Distribution
4. Review all pairs for profitability
5. Adjust strategy thresholds based on findings

## Database Tables Used

All queries in this dashboard use:
- `executions` table (primary)
- `opportunities` table (for latency calculation)
- `pairs` table (for canonical pair names)

## Query Performance

- All queries include time-based filtering
- Most queries use indexed columns (created_at, pair_id, chain)
- Table queries limited to 50 rows
- Target panel load time: <2 seconds

If queries are slow:
1. Ensure database has proper indexes
2. Consider partitioning `executions` table by date
3. Reduce time range for large datasets

## Common Issues

### "No Data" Displayed
**Cause**: No executions in selected time range
**Solution**:
- Expand time range
- Check if system is running
- Verify executions are being logged to database

### Queries Timing Out
**Cause**: Large dataset or missing indexes
**Solution**:
- Reduce time range
- Verify indexes exist on executions(created_at, pair_id, chain)
- Check database CPU/memory

### P&L Doesn't Match Expectations
**Cause**: Gas costs not being accounted for, or slippage higher than expected
**Solution**:
- Check "Gas Cost as % of Gross Profit" metric
- Review Slippage Distribution
- Verify `realized_pnl_usd` calculation includes all costs

### Fill Rate Very Low
**Cause**: Opportunities expiring before execution
**Solution**:
- Check Avg Latency metric
- Review Health dashboard for connector issues
- Consider increasing execution speed or reducing opportunity staleness threshold

## Integration with Other Dashboards

**Workflow Tip**: Use multiple dashboards together for root cause analysis.

- **Spreads Dashboard** → Identify when spreads occurred
- **Opportunities Dashboard** → See why opportunities were skipped
- **P&L Analysis Dashboard** → Measure actual profitability
- **Executions Dashboard** → Drill into specific trade details
- **Health Dashboard** → Verify system is healthy

## Alerting Recommendations

Consider setting up alerts for:
1. **Cumulative P&L drops >10%**: Critical loss threshold
2. **Win rate <45% for >1 hour**: Strategy not working
3. **Gas cost >75% of profit**: Unsustainable
4. **Fill rate <70% for >1 hour**: Execution issues
5. **Daily P&L negative for 3 consecutive days**: Trend issue

## Example Analysis Scenarios

### Scenario 1: Negative P&L Despite High Win Rate
**Observation**: Win rate is 65% but total P&L is negative
**Investigation**:
1. Check Avg Win vs Avg Loss → Losses might be much larger
2. Check Gas Cost % → Gas might be eating all profits
3. Review Worst Performing Trades → Are there a few huge losses?

**Action**: Tighten risk limits, add stop-loss logic, or increase min spread threshold.

### Scenario 2: Low Fill Rate
**Observation**: Fill rate is 60%
**Investigation**:
1. Check Avg Latency → High latency = stale opportunities
2. Check Health Dashboard → Connector disconnections?
3. Check Opportunities Dashboard → Are opportunities being skipped?

**Action**: Optimize execution path, improve connector stability, or adjust staleness threshold.

### Scenario 3: Gas Cost Exceeding Profit
**Observation**: Gas Cost as % of Gross Profit is 80%
**Investigation**:
1. Check Gas Costs Over Time → When are spikes occurring?
2. Check P&L by Pair → Are small pairs eating gas for minimal profit?
3. Check Trades Per Day → Too many small trades?

**Action**: Increase min spread threshold, reduce trade frequency, or focus on higher-value pairs only.

## Advanced Usage

### Calculating Risk-Adjusted Returns
Use the table data to export and calculate:
- Sharpe Ratio: (Avg Daily Return) / (Std Dev Daily Returns)
- Sortino Ratio: (Avg Daily Return) / (Downside Deviation)
- Max Drawdown: Largest peak-to-trough decline in cumulative P&L

### Backtesting Threshold Changes
Use historical data to:
1. Filter by specific pairs
2. Analyze P&L characteristics
3. Model what would happen with different thresholds
4. Validate in paper mode before going live

### Pair Selection
Use Win Rate by Pair and P&L by Pair to:
1. Identify consistently profitable pairs
2. Disable unprofitable pairs
3. Allocate more capital to high-performance pairs

## Maintenance

This dashboard requires no maintenance unless:
- Database schema changes
- New metrics need to be added
- Query performance degrades

## Support

For questions or issues:
1. Check TESTING.md for validation steps
2. Review query logs in Grafana Query Inspector
3. Verify database connectivity and data availability
4. Check Grafana logs: `docker logs grafana`
