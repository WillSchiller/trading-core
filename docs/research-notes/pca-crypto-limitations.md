# PCA in Crypto: Limitations & Correct Mental Model

**Key insight**: PCA is a coordinate transform, not a strategy. The edge comes from what you do AFTER the rotation.

## What Transfers from Equities

- PCA recovers true factors under approximate factor structure
- Eigenvalue growth test is correct way to count factors
- With enough breadth, PCA eigenvectors converge to real loadings

## What Breaks in Crypto

### No Clean Approximate Factor Structure

| Equities | Crypto |
|----------|--------|
| Stable ownership | Reflexive, narrative-driven |
| Slow structural change | Correlation structure changes faster than PCA window |
| Persistent factors | "Factors" appear/disappear (L2 season, AI coins, memes) |

**Result**: K is not constant, eigenvectors drift over short horizons

**Implication**: PCA factors in crypto are **locally real, not globally stable**

### Weaker Eigenvalue Separation

- PC1 ≈ "risk on/off" (BTC + ETH)
- PC2+ often rotate or collapse
- Residual eigenvalues not cleanly bounded

**Test**: Run PCA on top 20 vs top 100 coins, watch eigenvalue behavior as N grows

## Critical Misunderstanding

**PCA identifies covariance structure, NOT tradable alpha**

PCA tells you:
- "These assets move together"
- "This direction explains variance"

PCA does NOT tell you:
- Directional edge
- Mean reversion
- Momentum
- Risk premia

> "PCA stat arb makes money" really means "A specific trading rule on PCA residuals worked historically" — which can break.

## What NOT to Believe

❌ **"PCA guarantees residual mean reversion"**
- Residuals can trend
- Residuals can be regime-dependent
- Residuals can be structural (perpetual underperformance)

❌ **"More math = more edge"**
- PCA is already optimal for factor extraction
- Edge comes from: regime logic, asymmetric exits, position sizing, execution

## Correct Mental Model

```
PCA = coordinate transform into:
  - 1-2 systematic axes (PC1, PC2)
  - Many idiosyncratic axes (residuals)

Strategy = what you do after rotation:
  - PC1 → regime detector
  - Positive residual + bearish regime → momentum short
  - Negative residual + bullish regime → conditional long
  - Tight risk on longs, loose on shorts
```

This is far more realistic than textbook stat arb.

## What to Test

1. **Eigenvalue stability over time**
   - Does λ₁/λ₂ stay large?
   - Does K drift?

2. **Residual half-life by regime**
   - Bullish vs bearish
   - Expect asymmetry

3. **P&L attribution**
   - % from PC1 exposure
   - % from residual moves

4. **Cross-asset crowding**
   - Repeatedly trading same names = warning
   - DOT appearing twice already flagged

## Summary

| Aspect | Reality |
|--------|---------|
| PCA theory | Sound |
| Alpha guarantee | None |
| Our usage | Correct (not naive) |
| Regime fixes | What real quant teams do |
| Next step | P&L attribution + eigenvalue stability tests |
