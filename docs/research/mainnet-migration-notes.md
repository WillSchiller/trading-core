# Mainnet Migration Notes: CEX-DEX Arbitrage Under Reduced Slot Times

**Source**: "Second Thoughts: How 1-second subslots transform CEX-DEX Arbitrage on Ethereum"
**Date**: 2026-01-28
**Status**: Research Notes - Not Yet Implemented

---

## Key Insights

### 1. Execution Risk is Non-Negotiable

The research models CEX-DEX arbitrage as a two-stage game where the agent faces probability `alpha` of successfully landing the DEX leg. On failure, three options exist:

1. **Close immediately on CEX** - take the loss, manage delta
2. **Retry DEX** - pay gas again, hope for better luck
3. **Wait** - hold delta exposure, hope price moves favorably

Our current system (Base L2) benefits from fast block times (~2s) and relatively low gas. On mainnet (12s blocks, higher gas), the failure penalty is significantly worse.

**Implication**: Our execution module must model expected loss from failed DEX legs explicitly before entry.

### 2. Speed Helps, But Not How You Think

The research shows 1-second slots would increase:
- Transaction counts: +535%
- Trading volume: +203%

The volume increase decomposes into:
- **Composability gains**: 371% (more transactions fit per unit time)
- **De-risking gains**: 164% (faster slots = less delta exposure time)

**Implication**: On current 12s mainnet, we face the WORST conditions. We cannot compete on speed. We must compete on patience and selectivity.

### 3. The Risk-Averse Entry Condition

```
E[profit] - lambda * sqrt(Var[profit]) >= theta
```

Where:
- `lambda = 0.01` (risk aversion coefficient)
- `theta = 0` (entry threshold)
- `alpha = 0.35` (winning probability in competitive environment)

**Implication**: Our spread thresholds must incorporate variance, not just expected value. A 40bps spread with high variance may be worse than a 30bps spread with low variance.

### 4. Three Arbitrage Regimes

| Regime | Mempool Required | Competition | Our Fit |
|--------|------------------|-------------|---------|
| Latency arb (sub-second) | Yes | Extreme | No |
| In-block MEV | Yes | Extreme | No |
| Persistent dislocation | No | Moderate | Yes |

We are explicitly positioned in the **persistent dislocation** regime. This means:
- We do NOT need mempool access
- We do NOT compete with searchers/builders
- We DO need spreads to persist across multiple quote refreshes
- We DO need protected submission (not public mempool)

---

## Risk Model Parameters

### From Research

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `alpha` | 0.35 | Probability of winning DEX leg in competitive env |
| `lambda` | 0.01 | Risk aversion coefficient |
| `theta` | 0 | Minimum risk-adjusted return to enter |
| `max_retries` | 3 | Forced closure after N failed attempts |

### Translation to Our System

| Research Param | Our Implementation | Location |
|----------------|-------------------|----------|
| alpha | Not modeled | Need to add execution success rate tracking |
| lambda | Partially via volatility filter | `src/detection/filters.ts:volatilityFilter` |
| theta | `minSpreadBps` | `src/config/types.ts:PairThresholds` |
| max_retries | `haltOnConsecutiveReverts` | `src/config/types.ts:RiskConfig` |

---

## Mainnet Threshold Requirements

### Minimum Spread Thresholds

| Chain | Current minSpreadBps | Recommended minSpreadBps | Rationale |
|-------|---------------------|-------------------------|-----------|
| Base | 15-20 bps | 15-20 bps (unchanged) | Fast blocks, low gas |
| Mainnet | N/A | **40-60 bps** | 12s blocks, high gas, more competition |

### Persistence Requirements

| Chain | Current minDurationMs | Recommended minDurationMs | Rationale |
|-------|----------------------|--------------------------|-----------|
| Base | 500-1000ms | 500-1000ms (unchanged) | 2s blocks allow quick confirmation |
| Mainnet | N/A | **2000-3000ms** | Must survive 2-3 quote refreshes minimum |

### Gas Considerations

Current `maxGasGwei` in risk config: 100 gwei

For mainnet, need dynamic adjustment:
- Base gas: OK to trade at moderate spreads
- High gas (>50 gwei): Require proportionally higher spreads
- Very high gas (>100 gwei): Likely skip most opportunities

**Missing**: Gas-adjusted spread threshold calculation.

---

## Implementation Checklist

### Phase 1: Detection Logic Changes (Required Before Mainnet)

- [ ] **Add chain-specific threshold support**
  - Current: `PairThresholds` applies uniformly
  - Needed: Per-chain threshold overrides in config
  - File: `/Users/will/dev/blockhelix/src/config/types.ts`

- [ ] **Increase minDurationMs for mainnet**
  - Current: Uses `pairConfig.thresholds.minDurationMs` uniformly
  - Needed: Chain-aware duration filter
  - File: `/Users/will/dev/blockhelix/src/detection/filters.ts:durationFilter`

- [ ] **Add quote refresh count requirement**
  - Current: Duration-based only
  - Needed: Spread must persist across N quote refreshes (not just time)
  - Files: `/Users/will/dev/blockhelix/src/detection/index.ts`, `/Users/will/dev/blockhelix/src/detection/filters.ts`

- [ ] **Implement gas-adjusted spread threshold**
  - Current: Fixed `minSpreadBps` ignores gas cost
  - Needed: `effectiveThreshold = minSpreadBps + (gasGwei * gasBpsMultiplier)`
  - New filter required in `/Users/will/dev/blockhelix/src/detection/filters.ts`

### Phase 2: Execution Changes (Required Before Live Mainnet)

- [ ] **Add Flashbots Protect integration**
  - Current: Direct RPC submission (public mempool)
  - Needed: Private submission via Flashbots or similar
  - Files: `/Users/will/dev/blockhelix/src/execution/`

- [ ] **Track execution success rate (alpha)**
  - Current: No success rate modeling
  - Needed: Rolling window of execution attempts vs successes per pair/chain
  - Use for dynamic threshold adjustment

- [ ] **Model forced closure cost**
  - Current: No explicit delta exposure tracking
  - Needed: If DEX leg fails, estimate cost to close on CEX
  - Factor into entry decision

### Phase 3: Risk Management Changes

- [ ] **Chain-specific risk limits**
  - Current: Single `maxTradeSizeUsd`, `maxOpenExposureUsd`
  - Needed: Per-chain limits (mainnet should be lower initially)
  - File: `/Users/will/dev/blockhelix/src/config/types.ts:RiskConfig`

- [ ] **Retry budget per opportunity**
  - Research suggests max 3 retries before forced closure
  - Current: `haltOnConsecutiveReverts` is global, not per-opportunity
  - Needed: Per-opportunity retry counter

---

## Specific Code Changes Required

### 1. filters.ts - Add Gas-Adjusted Threshold Filter

```typescript
// NEW FILTER NEEDED
export interface GasAdjustedFilterInput {
  spreadBps: number;
  minSpreadBps: number;
  currentGasGwei: number;
  gasBpsPerGwei: number; // e.g., 0.5 means 50 gwei adds 25bps to threshold
  chain: Chain;
}

export function gasAdjustedThresholdFilter(input: GasAdjustedFilterInput): FilterResult {
  const { spreadBps, minSpreadBps, currentGasGwei, gasBpsPerGwei, chain } = input;

  // Mainnet only - Base gas is negligible
  if (chain !== 'mainnet') {
    return { passed: true, reason: 'gas_adjustment_not_applicable' };
  }

  const gasAdjustment = currentGasGwei * gasBpsPerGwei;
  const effectiveThreshold = minSpreadBps + gasAdjustment;
  const absSpread = Math.abs(spreadBps);

  if (absSpread >= effectiveThreshold) {
    return { passed: true, reason: `gas_adjusted_threshold_met: ${absSpread.toFixed(1)} >= ${effectiveThreshold.toFixed(1)}` };
  }

  return { passed: false, reason: `gas_adjusted_threshold_not_met: ${absSpread.toFixed(1)} < ${effectiveThreshold.toFixed(1)}` };
}
```

### 2. filters.ts - Add Quote Refresh Counter

```typescript
// NEW FILTER NEEDED
export interface QuoteRefreshFilterInput {
  pairChainKey: string;
  currentSpreadBps: number;
  minSpreadBps: number;
  minRefreshCount: number; // e.g., 2 for mainnet
  quoteRefreshMap: Map<string, { count: number; lastQuoteHash: string }>;
  currentQuoteHash: string; // Hash of anchor+dex quotes to detect refresh
}

export function quoteRefreshFilter(input: QuoteRefreshFilterInput): FilterResult {
  // Spread must persist across N distinct quote updates, not just time
  // This catches cases where spread appears stable but quotes aren't updating
  // ...
}
```

### 3. index.ts - Chain-Aware Detection Parameters

Current code at line 265:
```typescript
const timeAlignmentResult = timeAlignmentFilter({
  anchorQuote: anchorQuote.quote,
  dexQuote: dexQuote.quote,
  maxTimeSkewMs: getMaxTimeSkewMs(chain),
});
```

This pattern is correct - extend to other thresholds:
```typescript
// Need similar chain-aware functions for:
// - getMinSpreadBps(chain, baseThreshold)
// - getMinDurationMs(chain, baseThreshold)
// - getGasBpsMultiplier(chain)
```

---

## Current Detection Flow Audit

Reviewing `/Users/will/dev/blockhelix/src/detection/index.ts`:

### What Works for Mainnet

1. **Time alignment filter** (line 262-273): Already chain-aware via `getMaxTimeSkewMs(chain)`
2. **Duration filter** (line 339-362): Structure is correct, just needs higher thresholds
3. **Hysteresis logic** (line 597-689): Prevents oscillation, good for mainnet stability
4. **Circuit breaker** (line 155-167): Essential for mainnet error handling

### What Needs Adjustment

1. **Threshold filter** (line 289-309): Uses `pairConfig.thresholds.minSpreadBps` directly
   - Need: Chain-specific override or multiplier

2. **No gas cost consideration**: Filter chain doesn't check current gas price
   - Need: Gas-adjusted threshold filter before final decision

3. **Duration uses wall-clock time only** (line 339-345):
   - `minDurationMs` checks time elapsed
   - Does NOT check if quotes actually refreshed
   - Risk: Stale quotes could pass duration filter
   - Need: Quote refresh count filter

4. **No execution probability modeling**:
   - Entry decision ignores historical success rate
   - Need: If alpha < 0.3 for this pair/chain, require higher spread

---

## Risk Warnings

### DO NOT deploy to mainnet without:

1. **Protected submission path** - Public mempool = guaranteed frontrunning
2. **Gas-adjusted thresholds** - Fixed thresholds will bleed money during gas spikes
3. **Higher base thresholds** - 15bps on mainnet is suicide
4. **Quote refresh validation** - Duration alone is insufficient

### Suggested Mainnet Config (Initial)

```yaml
# pairs.yaml - Mainnet WETH/USDC example
- base: WETH
  quote: USDC
  chain: mainnet
  tier: 1
  thresholds:
    minSpreadBps: 45        # 3x Base threshold
    minDurationMs: 2500     # Must persist 2+ seconds
    minLiquidityUsd: 50000  # Higher liquidity requirement
    maxTradeSizeUsd: 500    # Start conservative
    minQuoteRefreshes: 2    # NEW: Must see 2 quote updates
```

---

## References

- Research paper: "Second Thoughts: How 1-second subslots transform CEX-DEX Arbitrage on Ethereum"
- Current detection code: `/Users/will/dev/blockhelix/src/detection/`
- Config types: `/Users/will/dev/blockhelix/src/config/types.ts`
- MEV protection notes: `/Users/will/dev/blockhelix/docs/mev-protection.md`
