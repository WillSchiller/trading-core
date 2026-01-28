# Mainnet Uniswap v3 DEX Connector - Setup Guide

## Overview

The dislocation trader system **already has full mainnet Uniswap v3 support** built in. The UniswapV3Connector is chain-agnostic and works identically on Base and Mainnet. This document explains how to enable mainnet data collection.

## Current Status

- ✅ Chain-agnostic connector implementation
- ✅ Mainnet contract addresses configured
- ✅ Mainnet pair configuration (WETH/USDC)
- ✅ Mainnet token addresses defined
- ✅ Multi-chain orchestration support
- ✅ Chain-specific thresholds and risk limits
- ⏸️ Mainnet disabled by default (for safety)

## Configuration Files

### 1. Contract Addresses (`config/default.json`)

Mainnet Uniswap v3 contracts are already configured:

```json
"mainnet": {
  "enabled": false,
  "chainId": 1,
  "blockTimeMs": 12000,
  "contracts": {
    "uniswapV3Factory": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    "uniswapV3Quoter": "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    "uniswapV3QuoterV2": "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    "uniswapV3Router": "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    "uniswapUniversalRouter": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD"
  }
}
```

**Important**: The system uses `uniswapV3QuoterV2` for execution quotes and `uniswapUniversalRouter` for swaps (more flexible than SwapRouter02).

### 2. Venue Configuration (`config/default.json`)

Uniswap v3 is configured to support both chains:

```json
"dex": {
  "uniswap_v3": { "enabled": true, "chains": ["base", "mainnet"] }
}
```

### 3. Pairs Configuration (`config/pairs.json`)

The mainnet WETH/USDC pair is already defined with two pools:

```json
{
  "base": "WETH",
  "quote": "USDC",
  "chain": "mainnet",
  "tier": 1,
  "venues": {
    "uniswap_v3": {
      "mainnet": [
        { "pool": "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", "feeTier": 500, "primary": true },
        { "pool": "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8", "feeTier": 3000 }
      ]
    }
  },
  "thresholds": {
    "minSpreadBps": 45,
    "minDurationMs": 2500,
    "minLiquidityUsd": 50000,
    "maxTradeSizeUsd": 500
  }
}
```

**Note**: Mainnet has higher thresholds (45 bps vs 20 bps on Base) to account for higher gas costs.

### 4. Risk Limits (`config/default.json`)

Chain-specific risk overrides are already configured:

```json
"risk": {
  "maxTradeSizeUsd": 50,
  "maxOpenExposureUsd": 200,
  "maxTradesPerHour": 20,
  "chainOverrides": {
    "mainnet": {
      "maxTradeSizeUsd": 25,
      "maxOpenExposureUsd": 100,
      "maxTradesPerHour": 10
    }
  }
}
```

Mainnet trades are limited to $25 (vs $50 on Base) due to gas costs.

## How to Enable Mainnet

### Step 1: Configure RPC Endpoints

Add mainnet RPC endpoints to your `.env` file:

```bash
# Mainnet HTTPS (required)
RPC_MAINNET_ALCHEMY_HTTP=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_MAINNET_DRPC_HTTP=https://lb.drpc.org/ogrpc?network=ethereum&dkey=YOUR_KEY

# Mainnet WebSocket (optional, for event-driven mode)
RPC_MAINNET_ALCHEMY_WS=wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_MAINNET_DRPC_WS=wss://lb.drpc.org/ogws?network=ethereum&dkey=YOUR_KEY
```

**Provider Recommendations**:
- **Alchemy**: Good for mainnet, reliable WebSocket support
- **QuickNode**: Alternative with competitive pricing
- **DRPC**: Load-balanced endpoints across multiple providers

### Step 2: Enable Mainnet Chain

**Option 1**: Environment variable (recommended)
```bash
export ENABLE_MAINNET=true
npm run dev
```

**Option 2**: Edit `config/default.json`
```json
"mainnet": {
  "enabled": true,
  ...
}
```

### Step 3: Verify Data Collection

Start the application and check logs:

```bash
npm run dev
```

Expected log output:
```
[INFO] RPC endpoints configured { chain: "mainnet", endpointCount: 2 }
[INFO] Chain provider and block watcher started { chain: "mainnet" }
[INFO] Pool initialized { chain: "mainnet", pool: "0x88e6...", canonical: "WETH/USDC" }
[INFO] Uniswap V3 connector started { chain: "mainnet", pools: 2 }
[INFO] Processing block (polling) { blockNumber: "...", pollInterval: 10 }
[INFO] Emitting Uniswap quote { pair: "WETH/USDC", mid: 3500.123, venue: "uniswap_v3", chain: "mainnet" }
```

### Step 4: Monitor Quote Cache

The quote cache tracks staleness per chain. Mainnet quotes are marked stale if:
- Block lag > 2 blocks (24 seconds behind head)
- Time skew > 3000ms (vs 1500ms on Base)

Check the Grafana "Quote Freshness" panel to monitor staleness rates.

## Architecture Details

### Chain-Agnostic Design

The same `UniswapV3Connector` code works on any chain:

```typescript
// src/collectors/dex/uniswap-v3.ts
export class UniswapV3Connector extends EventEmitter {
  constructor(
    config: UniswapV3ConnectorConfig,  // includes chain: Chain
    provider: ChainProvider,           // chain-specific RPC client
    blockWatcher: BlockWatcher         // chain-specific block listener
  ) { ... }
}
```

### Multi-Chain Orchestration

The `CollectorOrchestrator` manages connectors per chain:

```typescript
// src/collectors/orchestrator.ts
private async startDexConnectors(): Promise<void> {
  if (this.config.dex.uniswap_v3?.enabled) {
    for (const [chain, rawPools] of Object.entries(this.config.dex.uniswap_v3.chains)) {
      const provider = this.chainProviders.get(chain as Chain);
      const blockWatcher = this.blockWatchers.get(chain as Chain);

      const connector = new UniswapV3Connector(
        { chain: chain as Chain, pools: initializedPools },
        provider,
        blockWatcher
      );

      await connector.start();
      this.dexConnectors.set(`uniswap_v3:${chain}`, connector);
    }
  }
}
```

Each chain gets:
- Dedicated `ChainProvider` (RPC client pool)
- Dedicated `BlockWatcher` (block stream listener)
- Dedicated `UniswapV3Connector` (pool state tracker)

### Quote Flow

1. **BlockWatcher** emits new blocks for mainnet (~12s intervals)
2. **UniswapV3Connector** polls slot0() for each configured pool
3. Quote normalized to `{ ts, venue, pair, chain, mid, blockNumber, ... }`
4. **QuoteCache** stores latest quote per (venue, pair, chain) tuple
5. **OpportunityDetector** compares CEX quotes to DEX quotes per chain
6. **ExecutionManager** (if enabled) evaluates profitability with chain-specific gas costs

### Database Schema

Quotes are persisted to `quotes_raw` with chain context:

```sql
CREATE TABLE quotes_raw (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  pair_id INTEGER NOT NULL REFERENCES pairs(id),
  chain VARCHAR(20),
  bid NUMERIC(24,12),
  ask NUMERIC(24,12),
  mid NUMERIC(24,12),
  block_number BIGINT,
  ...
);
```

Opportunities track the chain where arbitrage would occur:

```sql
CREATE TABLE opportunities (
  id BIGSERIAL PRIMARY KEY,
  pair_id INTEGER NOT NULL REFERENCES pairs(id),
  chain VARCHAR(20) NOT NULL,
  spread_bps NUMERIC(10,2),
  anchor_venue_id INTEGER NOT NULL,
  anchor_mid NUMERIC(24,12),
  dex_mid NUMERIC(24,12),
  ...
);
```

## Adding More Mainnet Pairs

To add additional pairs (e.g., wstETH/WETH, rETH/WETH):

### 1. Add pair to `config/pairs.json`

```json
{
  "base": "wstETH",
  "quote": "WETH",
  "chain": "mainnet",
  "tier": 2,
  "venues": {
    "uniswap_v3": {
      "mainnet": [
        { "pool": "0x109830a1AAaD605BbF02a9dFA7B0B92EC2FB7dAa", "feeTier": 100, "primary": true }
      ]
    }
  },
  "thresholds": {
    "minSpreadBps": 50,
    "minDurationMs": 3000,
    "minLiquidityUsd": 25000,
    "maxTradeSizeUsd": 250
  }
}
```

### 2. Add token to `src/index.ts` (if not present)

```typescript
const MAINNET_TOKENS: Record<string, TokenConfig> = {
  WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, symbol: 'WETH' },
  USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, symbol: 'USDC' },
  wstETH: { address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', decimals: 18, symbol: 'wstETH' },
  // Add more as needed
};
```

### 3. Seed database

```bash
npm run db:seed
```

The orchestrator will automatically initialize the new pool on next startup.

## Gas Considerations

### Block Time Differences

| Chain | Block Time | Quotes/Hour |
|-------|-----------|-------------|
| Base | ~2s | ~1,800 |
| Mainnet | ~12s | ~300 |

Mainnet generates 6x fewer quotes, reducing opportunity frequency.

### Gas Costs

Mainnet gas is typically 10-100x more expensive than Base:

| Operation | Base (1 gwei) | Mainnet (50 gwei) |
|-----------|---------------|-------------------|
| slot0 read | $0.0001 | $0.005 |
| Swap | $0.02 | $2-5 |

The system accounts for this via:
- Higher spread thresholds (45 bps vs 20 bps)
- Lower trade sizes ($25 vs $50)
- Lower trade frequency (10/hr vs 20/hr)

### Adaptive Polling

The connector uses adaptive polling to reduce RPC calls:

```typescript
// Far from threshold: poll every 10 blocks (~120s)
// Close to threshold: poll every block (~12s)
if (spreadProximity < 0.3) {
  this.currentPollInterval = 10; // Every 10 blocks
} else if (spreadProximity > 0.9) {
  this.currentPollInterval = 1;  // Every block
}
```

This reduces RPC costs when opportunities are unlikely.

## Troubleshooting

### No mainnet quotes appearing

1. Check RPC endpoints are configured:
   ```bash
   echo $RPC_MAINNET_ALCHEMY_HTTP
   ```

2. Check mainnet is enabled:
   ```bash
   grep -A5 '"mainnet"' config/default.json | grep enabled
   ```

3. Check for RPC errors in logs:
   ```bash
   npm run dev | grep -i "mainnet.*error"
   ```

### Quotes marked as stale

Mainnet quotes tolerate higher staleness:
- Block lag threshold: 2 blocks (24s)
- Time skew threshold: 3000ms

If quotes are still stale, check:
- RPC provider latency (try different provider)
- Network connectivity
- Block watcher is receiving blocks

### High RPC costs

If Alchemy compute units are depleting too fast:

1. Reduce polling frequency:
   ```json
   "adaptivePolling": true,
   "baseThresholdBps": 45  // Higher = less frequent polling
   ```

2. Use event-driven mode (requires WebSocket):
   ```json
   "useEventDriven": true
   ```

3. Disable mainnet temporarily:
   ```bash
   export ENABLE_MAINNET=false
   ```

## Performance Metrics

Expected metrics when running Base + Mainnet:

| Metric | Value |
|--------|-------|
| Chains active | 2 |
| Connectors | ~5 (3 CEX + 2 DEX) |
| Quotes/sec | ~5-10 |
| RPC calls/min | ~10-15 (mainnet), ~30-40 (base) |
| DB inserts/min | ~50-100 (if sampling) |
| Memory usage | ~200-300 MB |

## Summary

- ✅ Mainnet support is **fully implemented** and chain-agnostic
- ✅ Contract addresses are **correct** (QuoterV2, Factory, Universal Router)
- ✅ Mainnet pair (WETH/USDC) is **configured** with two pools
- ✅ Risk limits are **chain-specific** (lower on mainnet)
- ✅ Thresholds are **adjusted** for higher gas costs
- ⚙️ Enable via `ENABLE_MAINNET=true` + RPC endpoints

No code changes required. The system is ready to collect mainnet data.
