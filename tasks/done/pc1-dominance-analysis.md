# Analyze PC1 vs residual PnL contribution

## Priority: High
## Labels: research, data-analysis

## Completed: 2026-03-08

## Result
PC1 (market factor) dominates PnL across all exit types:
- Trailing stop: +32.6 bps from PC1, +8.3 from residual (60% PC1)
- Bounce fail: -18.2 bps from PC1, -13.4 from residual (52% PC1)

Strategy is partly a disguised momentum trade when entering with-trend.
Counter-trend entries have positive residual (+2.2 bps), confirming genuine mean-reversion exists but only in that subset.
