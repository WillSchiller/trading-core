# Improve PC1 PnL decomposition for random_short

## Priority: Medium
## Labels: observability, data-quality

## Description
Random_short benchmark positions don't have pc1_pnl_bps/residual_pnl_bps populated (only 16/280 have data). This makes it impossible to decompose random performance into market factor vs residual.

## Implementation
- In `checkBenchmarkExits()`, compute and store pc1_pnl_bps and residual_pnl_bps
- Need the asset's PC1 loading at entry time to compute decomposition
- Store in `benchmark_exit` event payload, persist to pca_signals

## Files
- `src/research/pca-stat-arb.ts` (createBenchmarkEntry ~line 583, checkBenchmarkExits ~line 619)
- `src/research/pca-persistence.ts`
