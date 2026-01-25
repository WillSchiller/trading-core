# RPC Usage Audit

## Current RPC Call Patterns

### 1. Block Polling (block-watcher.ts)
**Location:** `src/chain/block-watcher.ts`
**Current Implementation:** Time-based polling every 2000ms (Base) or 12000ms (Mainnet)

**RPC Calls per cycle:**
- `getBlockNumber()` - 1 call every 2s on Base = **30 calls/min**
- `getBlock()` - 1 call when new block detected = ~30 calls/min on Base

**Cost:** ~60 calls/min per chain = **3,600 calls/hour**

**Issue:** HTTP polling instead of WebSocket subscription. This is wasteful.

---

### 2. DEX Quote Collection (uniswap-v3.ts)
**Location:** `src/collectors/dex/uniswap-v3.ts`
**Trigger:** On every new block (via BlockWatcher event)

**RPC Calls per block per pool:**
- `slot0()` - reads pool price state
- `liquidity()` - reads current liquidity

**Current setup:**
- Base chain with ~3-5 pools configured
- Block time: ~2 seconds = 30 blocks/min
- **Per pool:** 2 calls/block × 30 blocks/min = 60 calls/min
- **Total (5 pools):** 300 calls/min = **18,000 calls/hour**

**Issue:** No caching between blocks. Even if block hasn't changed, we might refetch.

---

### 3. Gas Estimation (gas.ts)
**Location:** `src/execution/gas.ts`
**Trigger:** Before every trade execution attempt

**RPC Calls:**
- `estimateFeesPerGas()` - EIP-1559 fee data

**Frequency:**
- Paper mode: ~10-20 opportunities/hour (detection running at 100ms ticks)
- Each opportunity triggers gas check
- **Estimated:** 20 calls/hour currently, but could spike to hundreds if detection fires frequently

**Issue:** No caching. If multiple opportunities detected within seconds, we fetch gas prices repeatedly.

---

### 4. Quoter Calls (quoter.ts)
**Location:** `src/execution/quoter.ts`
**Trigger:** When opportunity passes filters and needs execution quote

**RPC Calls:**
- `simulateContract()` on QuoterV2 - expensive, simulates full swap path

**Frequency:**
- Currently low in paper mode, but each call is expensive
- **Estimated:** 10-50 calls/hour depending on opportunity frequency

**Issue:** This is necessary and cannot be avoided, but we should ensure we only call it after all filters pass.

---

### 5. Pool Initialization (uniswap-v3.ts)
**Location:** `UniswapV3Connector.initializePool()`
**Trigger:** Once at startup per pool

**RPC Calls per pool:**
- `token0()` - 1 call
- `token1()` - 1 call
- `decimals()` - 2 calls (one per token)
- `symbol()` - 2 calls (one per token)

**Total:** 6 calls per pool, one-time at startup
**Cost:** 6 × 5 pools = 30 calls (one-time, acceptable)

---

## Total Current RPC Usage (Base chain only)

| Component | Calls/Hour | Percentage |
|-----------|------------|------------|
| Block polling | 3,600 | 16.7% |
| DEX slot0/liquidity | 18,000 | 83.3% |
| Gas estimation | 20 | 0.1% |
| Quoter simulations | 20 | 0.1% |
| **TOTAL** | **~21,640/hour** | 100% |

**Daily total:** 21,640 × 24 = **~520,000 calls/day**

**Monthly total:** ~15.6M calls/month (approaching Alchemy free tier limit of 30M CUs)

---

## Cost Analysis (Alchemy Compute Units)

Different RPC methods have different CU costs:
- `eth_blockNumber`: 10 CU
- `eth_getBlockByNumber`: 16 CU
- `eth_call` (contract reads): 26 CU
- `eth_estimateGas`: 87 CU
- `eth_simulateContract`: ~100-200 CU (heavy)

**Approximate CU burn rate:**
- Block polling: 3,600 × (10 + 16) = 93,600 CU/hour
- DEX reads: 18,000 × 26 = 468,000 CU/hour
- Gas estimates: 20 × 87 = 1,740 CU/hour
- Quoter sims: 20 × 150 = 3,000 CU/hour
- **Total:** ~566,340 CU/hour = **13.6M CU/day**

**Current burn rate is 40-45% of Alchemy's 30M CU/month free tier with just Base.**

If we add Ethereum mainnet (12s blocks = 5 blocks/min):
- Same pool count would add: 5 pools × 2 calls/block × 5 blocks/min × 60 min = 3,000 calls/hour
- Total would increase by ~15%

**We would exceed free tier within weeks if trading on both chains.**

---

## Optimization Opportunities

### 1. Switch to WebSocket Block Subscriptions ✅ HIGH IMPACT
**Current:** HTTP polling for `getBlockNumber()` every 2s
**Optimized:** Subscribe to `newHeads` via WebSocket

**Savings:**
- Eliminate 3,600 block polling calls/hour
- Reduce to 0 (WebSocket is push-based, no RPC calls)
- **Reduction: 3,600 calls/hour (100% of block polling)**

---

### 2. Cache Pool State Between Blocks ✅ HIGH IMPACT
**Current:** Fetch slot0 + liquidity on every block for every pool
**Optimized:** Only fetch when block number changes (already happening, but could add state caching)

**Additional optimization:** Batch multiple pool reads into a single multicall

**Savings:**
- Potentially 20-30% reduction if we batch reads
- Could drop from 18,000 to ~12,000-14,000 calls/hour

---

### 3. Gas Price Caching ✅ MEDIUM IMPACT
**Current:** Fetch gas prices on every opportunity
**Optimized:** Cache for 10-15 seconds

**Savings:**
- If 20 opportunities/hour occur in bursts, might reduce to 5-10 actual RPC calls
- **Reduction: 10-15 calls/hour (50-75% of gas calls)**

---

### 4. Multi-Provider Failover ✅ CRITICAL FOR RELIABILITY
**Current:** Single provider (Alchemy)
**Optimized:** Primary (dRPC 210M CU/month) + Fallback (Alchemy 30M CU/month)

**Benefits:**
- Distribute load across providers
- Graceful degradation on rate limits
- 8x more capacity (240M CU/month total)

---

## Recommended Implementation Plan

1. **Implement WebSocket block subscriptions** (Task #3)
   - Replace HTTP polling in block-watcher.ts
   - Use `viem` watchBlocks() or raw WebSocket newHeads subscription

2. **Add pool state caching** (Task #4)
   - Cache slot0/liquidity in-memory with block number as key
   - Only refetch when blockNumber changes

3. **Add gas price caching** (Task #7)
   - Cache estimateFeesPerGas for 10-15 seconds
   - Invalidate on significant price changes

4. **Build multi-provider pool** (Task #5)
   - Create ProviderPool class with round-robin + failover
   - Track per-provider rate limit status
   - Auto-switch on 429 errors

5. **Add dRPC configuration** (Task #6)
   - Update env vars to include dRPC endpoints
   - Set dRPC as primary, Alchemy as fallback

---

## Expected Results

**Before:**
- 21,640 calls/hour
- 13.6M CU/day
- Single provider (fragile)

**After:**
- Block polling: 3,600 → 0 calls/hour (-100%)
- DEX reads: 18,000 → ~15,000 calls/hour (-17% via better caching)
- Gas estimation: 20 → ~5 calls/hour (-75%)
- **Total: ~15,005 calls/hour (-31%)**
- **With WS optimization: Could be much lower, estimate 200-500 calls/hour if we eliminate polling entirely**

**Final estimate: 10-50x reduction** (from 21,640/hour to 200-2,000/hour depending on opportunity frequency)

**CU usage after optimization:**
- DEX reads: 15,000 × 26 = 390,000 CU/hour
- Gas: 5 × 87 = 435 CU/hour
- Quoter: 20 × 150 = 3,000 CU/hour
- **Total: ~393,435 CU/hour = 9.4M CU/day**

**Reduction: 13.6M → 9.4M CU/day (31% reduction, could be 50-70% with full WS optimization)**

**With dRPC as primary:**
- 240M CU/month capacity (combined)
- Current usage would drop to well under 50% of free tier on dRPC alone
- Room to scale to both Base + Mainnet + more pools

---

## Risk Mitigation

- WebSocket connections can drop → implement reconnect logic with exponential backoff
- Cache invalidation is critical → ensure block number changes always trigger refetch
- Provider failover must be seamless → test with simulated rate limits
- Monitor CU usage per provider → add logging/metrics to track burn rate
