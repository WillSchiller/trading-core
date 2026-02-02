# Weekend Effect Analysis — PCA Stat-Arb

**Date**: 2026-02-02
**Data**: Jan 28 (Wed) – Feb 1 (Sun), 568 resolved signals

## Key Finding

PnL drops sharply on weekends despite rising win rate. Root cause is signal drought + stop-loss asymmetry.

## Daily Breakdown

| Day | DoW | Signals/hr | Trades | Win% | PnL | Avg Win (bps) | Avg Loss (bps) |
|-----|-----|-----------|--------|------|-----|---------------|-----------------|
| Jan 28 | Wed | 5.0 | 70 | 42.9% | -$4.98 | +21.4 | -22.3 |
| Jan 29 | Thu | 10.9 | 284 | 55.6% | +$55.65 | +43.8 | -32.8 |
| Jan 30 | Fri | 4.5 | 106 | 64.2% | +$32.60 | +51.5 | -49.3 |
| Jan 31 | Sat | 3.2 | 78 | 66.7% | +$14.16 | +47.6 | -68.0 |
| Feb 1 | Sun | 1.3 | 30 | 73.3% | +$5.28 | +24.6 | -34.6 |

## Two Compounding Factors

### 1. Signal Frequency Drops 88%
- Thu: 10.9 signals/hr → Sun: 1.3 signals/hr
- Less volume, fewer genuine dislocations on weekends
- Fewer trades = less PnL even at same edge

### 2. Stop Losses Are Large and All Shorts
- 27 stop losses Fri–Sun, every single one a short
- Many hit within 1–7 minutes (false dislocation → momentum run)
- Avg stop loss: ~90 bps vs avg win: ~35 bps (2.5:1 loss/win ratio)

| Day | Stop Losses | Stop Loss PnL | Trailing Stop PnL |
|-----|------------|---------------|-------------------|
| Fri | 6 | -$13.47 | +$48.38 |
| Sat | 18 | -$33.30 | +$47.46 |
| Sun | 3 | -$4.72 | +$10.40 |

### Mechanism
Weekend crypto has lower liquidity, so:
- Price moves look like dislocations but are one-sided momentum
- Momentum persists longer before mean-reversion
- Shorts get stopped before the reversion trade pays off

## Options to Explore (not yet implemented)
1. Higher z-score threshold on weekends (e.g., 3.5 vs 2.5)
2. Reduced position size on Sat/Sun
3. Wider stop-loss on weekends (accept longer holds)
4. Skip weekends entirely if edge doesn't justify risk
5. Time-of-day filter: best hours are 14 UTC (+$17.24) and 19 UTC (+$32.23); worst are 16 UTC (-$6.83) and 20 UTC (-$9.52)

## Conclusion
Strategy is profitable every day except the ramp-up day (Wed). Weekend underperformance is real but not a show-stopper — the algo just makes less. Worth monitoring as dataset grows.
