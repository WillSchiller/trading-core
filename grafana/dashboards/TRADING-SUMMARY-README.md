# Trading Summary Dashboard

## Overview

This dashboard provides a clear, user-friendly view of the paper trading system's performance with an emphasis on explaining what each metric means.

## Dashboard URL

After starting Grafana (`docker-compose up -d`), access it at:
- http://localhost:3000/d/trading-summary

Default credentials: `admin` / `admin` (or your configured password)

## What This Dashboard Shows

The dashboard follows a logical flow that answers the key questions:

### 1. Opportunities Detected
**What it means**: Total number of price dislocation opportunities the system has found.

This is the starting point - how many potential trading opportunities were identified by scanning CEX vs DEX prices.

### 2. Opportunities Executed
**What it means**: Number of opportunities that resulted in simulated trades.

These are opportunities that passed all risk filters and would have been executed if the system was in live mode.

### 3. Opportunities Skipped
**What it means**: Number of opportunities detected but NOT executed.

These were filtered out by risk management rules (spread too small, gas too high, liquidity too low, etc.)

### 4. Simulated P&L (Paper Trading)
**What it means**: Total profit/loss from paper trading.

**IMPORTANT**: This is NOT real money. These are simulated trades showing what would have happened if trades were executed.

- Negative numbers (e.g., -$557) mean the simulated trades would have lost money
- This helps validate if the trading strategy is profitable before going live

## Key Visualizations

### Executed vs Skipped Breakdown (Pie Chart)
Shows the ratio of executed vs skipped opportunities. A high skip rate is normal and expected - it means risk filters are working.

### Why Opportunities Were Skipped (Donut Chart)
Breaks down the specific reasons trades were not executed:
- `spread_too_small` - Profit opportunity wasn't large enough
- `gas_too_high` - Gas costs would eat the profit
- `insufficient_liquidity` - DEX pool doesn't have enough liquidity
- `risk_limit_exceeded` - Would exceed position/exposure limits
- etc.

### Cumulative Simulated P&L Over Time
Shows how paper trading P&L accumulates. If trending down (like -$557), it means:
1. The strategy parameters may need tuning
2. Market conditions aren't favorable
3. Slippage/gas costs are too high

### Opportunities Detected vs Executed (Hourly)
Compare detection rate vs execution rate over time. Helps identify:
- Times when many opportunities appear but few execute (filtering is aggressive)
- Times when detection and execution are aligned

## Key Metrics Explained

### Execution Rate
What percentage of detected opportunities actually resulted in trades.
- Low execution rate (5-15%): Normal, means filters are conservative
- High execution rate (>50%): May indicate filters are too loose

### Win Rate (Paper Trading)
Percentage of simulated trades that made profit.
- <50%: Strategy is losing on average
- >50%: Strategy is winning more than losing
- >60%: Good performance (if sample size is sufficient)

### Average Trade P&L
Average profit/loss per trade. Even with high win rate, if average P&L is negative, it means losses are bigger than wins.

### Skip Rate
What percentage of opportunities were filtered out. High skip rate (80-95%) is normal and healthy.

## Understanding Negative P&L

If you see "Simulated P&L: -$557", this means:

1. **It's NOT real money lost** - these are paper trades
2. **695 simulated trades were executed** with a cumulative loss
3. **Possible reasons**:
   - Slippage is higher than expected
   - Gas costs eat into profits
   - Timing delays cause prices to move
   - Spread threshold is too aggressive
   - Market conditions changed (arbitrage opportunities closed)

## Next Steps

If paper trading shows negative P&L:

1. **Review Skip Reasons** - Are you filtering out good opportunities?
2. **Check Win Rate** - Is it above 50%? If not, strategy needs adjustment
3. **Analyze Slippage** - Is realized slippage much worse than quoted?
4. **Review Gas Costs** - Are gas costs eating all profits?
5. **Adjust Thresholds** - Consider raising minimum spread requirements
6. **Check Market Conditions** - Are there fewer arbitrage opportunities?

## Dashboard Refresh

- Auto-refreshes every 30 seconds
- Default time range: Last 24 hours
- Can be changed to 1h, 6h, 7d, 30d via time picker

## Related Dashboards

- **Overview** - Live system monitoring (quotes, spreads, connector health)
- **P&L Analysis** - Deep-dive into performance metrics
- **Opportunities** - Detailed opportunity analysis
- **Executions** - Individual trade details
- **Spreads** - CEX vs DEX price analysis
- **Health** - System health and connectivity

## Data Sources

All data comes from the PostgreSQL database:
- `opportunities` table - Detected price dislocations
- `executions` table - Trade attempts and results
- Filtered to `is_paper_trade = true` for safety

## Questions This Dashboard Answers

1. **How many opportunities are we finding?** → Opportunities Detected
2. **How many are we actually trading?** → Executed vs Skipped breakdown
3. **Why aren't we trading more?** → Skip Reasons breakdown
4. **Is the strategy profitable?** → Simulated P&L (Paper Trading)
5. **What's our win rate?** → Win Rate metric
6. **Are we being too conservative?** → Skip Rate + Execution Rate
