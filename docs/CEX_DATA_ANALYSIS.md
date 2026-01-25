# CEX Data Coverage Analysis

**Date**: 2026-01-23
**Issue**: Missing CEX data for most pairs in Grafana spreads dashboard

## Executive Summary

Investigation revealed that 5 out of 6 configured trading pairs lack consistent CEX price feeds. This is expected for liquid staking derivative (LSD) pairs, which trade primarily on DEX venues. The system is working as designed, but dashboards should better indicate CEX coverage limitations.

## Current CEX Coverage

| Pair | CEX Config | Status | Quote Count (24h est) | Last Update |
|------|-----------|--------|---------------------|-------------|
| WETH/USDC | Binance, Coinbase, Bybit | ✅ EXCELLENT | ~1.76M quotes | Live (sub-second) |
| cbETH/WETH | Coinbase | ⚠️ SPARSE | ~277 quotes | 16 min stale |
| weETH/WETH | None | ❌ NO CEX | 0 | N/A |
| wstETH/WETH | None | ❌ NO CEX | 0 | N/A |
| rETH/WETH | None | ❌ NO CEX | 0 | N/A |
| USDC/USDbC | None | ❌ NO CEX | 0 | N/A |

## Root Cause Analysis

### 1. WETH/USDC - Working as Expected ✅

**Config**:
```json
"venues": {
  "binance": { "symbol": "ETHUSDC" },
  "coinbase": { "symbol": "ETH-USD" },
  "bybit": { "symbol": "ETHUSDC" }
}
```

**Database stats**:
- Binance: 1,366,488 quotes
- Coinbase: 106,486 quotes
- Bybit: 288,178 quotes
- All updating in real-time (sub-second latency)

**Conclusion**: This is the anchor pair and works perfectly.

---

### 2. cbETH/WETH - Partially Working ⚠️

**Config**:
```json
"venues": {
  "coinbase": { "symbol": "CBETH-ETH" }
}
```

**Database stats**:
- Coinbase: 277 quotes
- Last update: 07:54:33 (16 minutes stale as of 08:10:37)

**CEX availability** ([source](https://www.coinbase.com/converter/cbeth/eth)):
- Coinbase: Yes (CBETH/ETH pair, $327K 24h volume)
- Binance: Indirect (CBETH/USD available)
- Bybit: Indirect (price tracking only)

**Root cause**: Low trading volume. Coinbase ticker feed only pushes updates when trades occur. During quiet periods, quotes can be stale for 10-20+ minutes.

**Impact**: Detection system marks quotes older than 3000ms as stale, so this pair effectively has no CEX anchor during quiet periods.

---

### 3. weETH/WETH - DEX-Only Pair ❌

**Config**: No CEX venues configured

**CEX availability** ([source](https://www.coingecko.com/en/coins/wrapped-steth)):
- Binance: No direct pair
- Coinbase: No direct pair
- Bybit: No direct pair
- Main venue: Curve (DEX) - $15.8M 24h volume

**Token info**: Wrapped eETH (ether.fi liquid staking token)

**Conclusion**: This is fundamentally a DEX-native asset. CEX listing unlikely due to regulatory/operational complexity.

---

### 4. wstETH/WETH - DEX-Only Pair ❌

**Config**: No CEX venues configured

**CEX availability** ([source](https://www.coingecko.com/en/coins/wrapped-steth)):
- Binance: No direct pair
- Coinbase: No direct pair
- Bybit: No direct pair
- Main venue: Uniswap V3 - $6M+ 24h volume

**Token info**: Wrapped Staked ETH (Lido liquid staking token)

**Conclusion**: Despite being the largest LSD by TVL, wstETH trades primarily on DEX. CEX listing unlikely.

---

### 5. rETH/WETH - DEX-Only Pair ❌

**Config**: No CEX venues configured

**CEX availability** ([sources](https://www.coinbase.com/converter/reth/eth)):
- Binance: Price tracking only, no trading pair
- Coinbase: Converter/swap only (not orderbook trading)
- Bybit: No direct pair
- Main venue: DEX aggregators

**Token info**: Rocket Pool ETH (decentralized liquid staking)

**Conclusion**: Like other LSDs, this is DEX-native. Coinbase offers swaps but not continuous price feeds.

---

### 6. USDC/USDbC - Stablecoin Peg Pair ❌

**Config**: No CEX venues configured

**CEX availability**: N/A (both are stablecoins)

**Token info**:
- USDC: Native USDC on Base (bridged from Ethereum)
- USDbC: Original Base bridged USDC

**Conclusion**: This pair should track 1:1 peg. No CEX lists this pair because it's Base chain-specific and has no price discovery function (always ~1.0).

---

## Recommendations

### Priority 1: Dashboard Improvements (IMMEDIATE)

1. **Add CEX coverage indicator** to spreads dashboard:
   ```
   CEX Coverage: [●●●] Full | [●●○] Partial | [●○○] Synthetic | [○○○] None
   ```

2. **Update panel titles** to reflect data sources:
   - WETH/USDC: "CEX vs DEX Spread (Live)"
   - cbETH/WETH: "CEX vs DEX Spread (Sparse CEX)"
   - weETH/WETH: "DEX Only - No CEX Reference"
   - etc.

3. **Add staleness warnings** for low-volume pairs:
   - Show "CEX quote stale (16m)" when quote age > 5 minutes
   - Gray out CEX data when stale

### Priority 2: Synthetic CEX Pricing (HIGH VALUE)

For liquid staking derivative pairs without direct CEX quotes, implement **synthetic pricing** using cross-rates:

#### Implementation Strategy

**For cbETH/WETH** (when Coinbase is stale):
```
cbETH/WETH_synthetic = (cbETH/USD from Coinbase) / (ETH/USD from Binance)
```

**For wstETH/WETH**:
```
wstETH/WETH_synthetic = (wstETH/USD from aggregator) / (ETH/USD from Binance)
```

**For rETH/WETH**:
```
rETH/WETH_synthetic = (rETH/USD from aggregator) / (ETH/USD from Binance)
```

**For weETH/WETH**:
```
weETH/WETH_synthetic = (weETH/USD from aggregator) / (ETH/USD from Binance)
```

#### Required Changes

1. **New connector**: `SyntheticPriceConnector` in `src/collectors/cex/synthetic.ts`
   - Subscribe to constituent pairs (e.g., CBETH/USD + ETH/USD)
   - Calculate cross-rate when both quotes available
   - Emit synthetic quote with `venue: "synthetic_cex"`
   - Mark as stale if either constituent is stale

2. **Config additions** to `config/pairs.json`:
   ```json
   {
     "base": "cbETH",
     "quote": "WETH",
     "venues": {
       "coinbase": { "symbol": "CBETH-ETH" },
       "synthetic_cex": {
         "numerator": { "venue": "coinbase", "pair": "cbETH/USD" },
         "denominator": { "venue": "binance", "pair": "WETH/USDC" }
       }
     }
   }
   ```

3. **Fallback logic** in `SpreadCalculator`:
   - Use direct CEX quote if available and fresh
   - Fall back to synthetic quote if direct is stale
   - Mark spread with `is_synthetic: true` flag

#### Benefits
- Provides CEX reference for all LSD pairs
- Enables spread detection even during low CEX volume periods
- More actionable opportunities (currently 4/6 pairs have no CEX anchor)

#### Risks
- Synthetic quotes have compounded staleness (max of both constituents)
- Cross-rate may have slight deviation from direct pair
- Need to handle quote misalignment (e.g., ETH/USD quote 500ms older than cbETH/USD)

### Priority 3: cbETH/WETH Quote Freshness (MEDIUM)

**Option A**: Accept staleness (recommended for MVP)
- Current 3s staleness threshold is too strict for low-volume pairs
- Increase threshold to 5 minutes for tier-1 thin-market pairs
- Already configured in pairs.json: `"maxQuoteAgeMs": 300000`

**Option B**: Add Binance cbETH/USDT pair
- Binance has CBETH/USDT pair (not CBETH/ETH)
- Would need synthetic calculation anyway
- Not worth complexity vs. Option A

### Priority 4: USDC/USDbC Special Handling (LOW)

This pair is fundamentally different - it's a peg tracker, not a price discovery pair.

**Options**:
1. Remove from opportunity detection (treat as infrastructure pair)
2. Add synthetic 1.0 reference price (always emits "1.0" as CEX mid)
3. Track peg deviation separately in dedicated dashboard

**Recommendation**: Option 2 - emit synthetic 1.0 quote so spread calculations work, but flag as "peg pair" in detection.

---

## Implementation Plan

### Phase 1: Dashboard Fixes (1 day)
- [x] Investigate and document CEX coverage ← **DONE**
- [ ] Update spreads.json to add CEX coverage indicators
- [ ] Add staleness warnings to panels
- [ ] Add "Data Source" column to pair selector

### Phase 2: Synthetic Pricing (3-5 days)
- [ ] Implement `SyntheticPriceConnector` base class
- [ ] Add synthetic configs to pairs.json
- [ ] Update orchestrator to start synthetic connectors
- [ ] Add synthetic fallback logic to detection
- [ ] Test with live data

### Phase 3: Special Pair Handling (2 days)
- [ ] Implement 1.0 synthetic quote for USDC/USDbC
- [ ] Adjust staleness thresholds for thin-market pairs
- [ ] Create dedicated peg-tracking dashboard

---

## Database Query Results

Validation query showing actual quote data:

```sql
SELECT
  v.name as venue,
  p.canonical as pair,
  COUNT(*) as quote_count,
  MAX(qr.ts) as latest_quote
FROM quotes_raw qr
JOIN venues v ON qr.venue_id = v.id
JOIN pairs p ON qr.pair_id = p.id
WHERE v.name IN ('coinbase', 'binance', 'bybit')
GROUP BY v.name, p.canonical
ORDER BY v.name, p.canonical;
```

**Results** (as of 2026-01-23 08:10:37 UTC):
```
  venue   |    pair    | quote_count |        latest_quote
----------+------------+-------------+----------------------------
 binance  | WETH/USDC  |     1366488 | 2026-01-23 08:10:36.971+00
 bybit    | WETH/USDC  |      288178 | 2026-01-23 08:10:37.331+00
 coinbase | WETH/USDC  |      106486 | 2026-01-23 08:10:37.178+00
 coinbase | cbETH/WETH |         277 | 2026-01-23 07:54:33.946+00
```

---

## References

### CEX Exchange Research

- **Coinbase cbETH/ETH**: [Coinbase Converter](https://www.coinbase.com/converter/cbeth/eth)
- **wstETH availability**: [CoinGecko - Wrapped stETH](https://www.coingecko.com/en/coins/wrapped-steth)
- **rETH availability**: [Coinbase rETH Converter](https://www.coinbase.com/converter/reth/eth)

### Configuration Files

- `/config/pairs.json` - Pair definitions and venue mappings
- `/src/index.ts` lines 143-178 - CEX config extraction logic
- `/src/collectors/orchestrator.ts` lines 164-182 - Connector startup

### Related Issues

- Quote staleness threshold: 3000ms (config: `quoteStaleThresholdMs`)
- Thin market mode: Enabled for cbETH/WETH with 300s max age
- Block lag threshold: 2 blocks for DEX staleness

---

## Conclusion

The missing CEX data is **expected behavior** for liquid staking derivative pairs, which trade primarily on DEX venues. The system is correctly configured, but the dashboard presentation should be improved to set proper expectations.

**Immediate action**: Update Grafana dashboards to indicate CEX coverage status per pair.

**High-value enhancement**: Implement synthetic CEX pricing using cross-rates to enable spread detection for LSD pairs.

**No action needed**: System is working correctly for its primary pair (WETH/USDC) and properly handles DEX-only pairs.
