# Dashboard Updates: Detection vs Execution Time Clarity

## Problem Summary

The original dashboards had a confusing asymmetry:
- **`spread_bps`** in opportunities table = calculated at **detection time** (when spread first exceeded threshold)
- **`estimated_profit_usd`** in opportunities table = calculated at **execution time** (from quoter with fresher prices)

This made it unclear what metrics represented what point in time, and made it impossible to assess prediction accuracy.

## Timeline of Events

```
T0: DETECTION TIME
    - Spread calculator sees CEX-DEX delta > threshold
    - Records: detected_at, spread_bps, anchor_mid, dex_mid
    - These are "stale" by definition (detected in the past)

T1: EXECUTION DECISION TIME (typically +100-2000ms)
    - Risk manager decides to trade
    - Calls quoter with FRESH prices
    - Records: estimated_profit_usd, estimated_slippage_bps, estimated_gas_usd
    - These overwrite detection-time estimates

T2: TRANSACTION SUBMITTED
    - executions.created_at

T3: TRANSACTION CONFIRMED
    - Records: realized_pnl_usd, realized_slippage_bps, gas_cost_usd
    - These are ACTUALS
```

## Changes Made

### 1. New Dashboard: `prediction-accuracy.json`

**Purpose**: Dedicated dashboard showing detection-time predictions vs execution-time actuals

**Key Panels**:
- Explanatory text panel describing the timeline
- Side-by-side comparison: Detection-time spread vs Execution-time estimated profit
- Overlay chart: Estimated profit vs Realized P&L
- Prediction error analysis (mean, median, stddev, overestimation rate)
- Time lag analysis (detection to execution latency)
- Detailed comparison table with all metrics

**Use Case**: Answer "How well do our detection-time signals hold up at execution time?"

### 2. Updated Dashboard: `opportunities.json`

**Changes**:
- Added explanatory text panel at top
- Renamed panels to clearly label timing:
  - "DETECTION TIME: Spread Distribution (bps)"
  - "DETECT TIME: Avg Spread (abs)"
  - "EXEC TIME: Avg Estimated Profit"
- Updated table column names:
  - `spread_bps` → `Spread@Detect (bps)`
  - `estimated_profit_usd` → `Est Profit@Exec (USD)`
  - `estimated_gas_usd` → `Est Gas@Exec (USD)`

**Use Case**: Understand opportunity quality at both detection and execution decision points

### 3. Updated Dashboard: `executions.json`

**Changes**:
- Added explanatory text panel emphasizing these are ACTUALS
- Renamed panels to clarify these are realized values:
  - "Cumulative PnL (Realized)"
  - "PnL per Trade (Realized)"
  - "Avg Slippage (Realized)"
  - "Slippage Distribution (Realized)"
  - "Gas Cost Over Time (Realized)"

**Use Case**: Track actual execution performance

## Key Metrics Glossary

### Detection-Time Metrics (opportunities table)
| Field | When Calculated | Source | Purpose |
|-------|----------------|--------|---------|
| `detected_at` | T0 | System clock | When spread first exceeded threshold |
| `spread_bps` | T0 | CEX mid - DEX mid | Raw price difference at detection |
| `anchor_mid`, `dex_mid` | T0 | Latest quotes | Prices used for spread calc |

### Execution-Time Estimates (opportunities table)
| Field | When Calculated | Source | Purpose |
|-------|----------------|--------|---------|
| `estimated_profit_usd` | T1 | Quoter contract | Expected profit with fresh prices |
| `estimated_slippage_bps` | T1 | Quoter contract | Expected price impact |
| `estimated_gas_usd` | T1 | Gas estimator | Expected transaction cost |

### Execution Actuals (executions table)
| Field | When Calculated | Source | Purpose |
|-------|----------------|--------|---------|
| `created_at` | T2 | System clock | When trade was submitted |
| `realized_pnl_usd` | T3 | On-chain result | Actual P&L after costs |
| `realized_slippage_bps` | T3 | On-chain result | Actual price impact |
| `gas_cost_usd` | T3 | On-chain result | Actual gas paid |

## Prediction Accuracy Metrics

The new dashboard calculates:

1. **Prediction Error**: `realized_pnl_usd - estimated_profit_usd`
   - Negative = we overestimated profit
   - Positive = we underestimated profit

2. **Overestimation Rate**: `% of trades where realized < estimated`
   - Should be close to 50% for unbiased estimates

3. **Detection-to-Execution Lag**: `created_at - detected_at`
   - Typical range: 100-2000ms
   - Higher lag = more price decay

## Usage Recommendations

### For Strategy Validation
Use **`prediction-accuracy.json`**:
- Check if detection-time spreads translate to execution profits
- Monitor prediction error trends (are we getting better/worse?)
- Identify if certain pairs/conditions have worse decay

### For Live Monitoring
Use **`opportunities.json`** + **`executions.json`**:
- Opportunities: Track signal quality at both detection and execution
- Executions: Track actual performance and costs

### For Performance Tuning
Use **`prediction-accuracy.json`**:
- If prediction error is systematically negative → increase spread threshold
- If lag is high → optimize execution path
- If overestimation rate > 70% → quotes are going stale too fast

## Files Modified

1. `/Users/will/dev/blockhelix/grafana/dashboards/prediction-accuracy.json` (NEW)
2. `/Users/will/dev/blockhelix/grafana/dashboards/opportunities.json` (UPDATED)
3. `/Users/will/dev/blockhelix/grafana/dashboards/executions.json` (UPDATED)

## Testing Checklist

- [ ] Load prediction-accuracy dashboard in Grafana
- [ ] Verify all panels render without query errors
- [ ] Confirm template variables work
- [ ] Check that prediction error calculations are correct
- [ ] Verify time lag histogram shows realistic values
- [ ] Review updated opportunities dashboard labels
- [ ] Review updated executions dashboard labels
- [ ] Confirm table column renaming is clear

## Next Steps

Consider adding:
1. Alert on prediction error exceeding threshold (e.g., overestimation rate > 80%)
2. Panel showing "spread decay rate" (how fast spreads close after detection)
3. Breakdown of prediction error by pair/chain/time-of-day
4. Detection-time estimated profit (using detection-time prices) for apples-to-apples comparison
