# Implement counter-trend entry gate for shorts

## Priority: High
## Labels: strategy, signal-quality

## Description
Add a `pc1_return > 0` gate to `shouldEnterShort()` in `src/research/pca-stat-arb.ts`. Only enter short positions when the market factor (PC1) is positive — i.e. true counter-trend mean reversion.

## Evidence
Across 785 signals with bounce_fail active:
- Counter-trend (pc1_return > 0): residual PnL **+2.2 bps**, trailing stop rate 55.2%
- With-trend (pc1_return <= 0): residual PnL **-7.8 bps**, trailing stop rate 47.3%

Counter-trend residual is positive in both sample periods (Feb 9-14: +0.9, post-Mar5: +6.3). With-trend residual consistently negative.

## Implementation
- Add configurable threshold to `ShortConfig`: `minPC1Return?: number`
- In `shouldEnterShort()`, check current PC1 return against threshold
- Default to 0 (disabled) so existing behavior unchanged
- Log filtered-out signals for validation

## Blocked by
- Need ~3 weeks of post-Mar5 data to confirm pattern (~Mar 25)

## Files
- `src/research/pca-stat-arb.ts` (lines 1347-1374)
- `src/config/schema.ts` (shortConfigSchema)
- `src/config/types.ts` (ShortConfig)
