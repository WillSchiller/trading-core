# Phase 1 Implementation: Data Collection

This document describes the implementation of Phase 1 (Tasks T1.1-T1.9) for the CEX/DEX price dislocation trading system.

## Overview

Phase 1 implements the complete data collection layer, including:
- CEX WebSocket connectors (Binance, Coinbase, Bybit)
- DEX on-chain readers (Uniswap V3)
- In-memory quote caching with staleness detection
- PostgreSQL persistence (raw quotes + rollups)
- Connector health tracking

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    CollectorOrchestrator                        │
│  Coordinates all connectors, manages lifecycle, routes quotes   │
└──────────────┬────────────────────────────┬─────────────────────┘
               │                            │
       ┌───────▼──────────┐         ┌──────▼──────────┐
       │  CEX Connectors  │         │ DEX Connectors  │
       │  - Binance       │         │  - UniswapV3    │
       │  - Coinbase      │         │                 │
       │  - Bybit         │         └────────┬────────┘
       └───────┬──────────┘                  │
               │                             │
               │     ┌───────────────────────▼──────┐
               │     │      ChainProvider           │
               │     │  - viem wrapper              │
               │     │  - HTTP + WS RPC             │
               │     └───────────┬──────────────────┘
               │                 │
               │     ┌───────────▼──────────────────┐
               │     │      BlockWatcher            │
               │     │  - Polls new blocks          │
               │     │  - Emits block events        │
               └─────┴───────────┬──────────────────┘
                                 │
                     ┌───────────▼──────────────────┐
                     │        QuoteCache            │
                     │  - In-memory storage         │
                     │  - Staleness detection       │
                     └───────────┬──────────────────┘
                                 │
               ┌─────────────────┴─────────────────┐
               │                                   │
     ┌─────────▼─────────┐             ┌─────────▼─────────┐
     │ QuotePersistence  │             │ HealthPersistence │
     │ - Raw sampling    │             │ - Connection state│
     │ - Rollups (OHLC)  │             │ - Error counts    │
     └───────────────────┘             └───────────────────┘
               │                                   │
               └──────────────┬────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   PostgreSQL      │
                    │  - quotes_raw     │
                    │  - quote_rollups  │
                    │  - connector_health│
                    └───────────────────┘
```

## Components

### 1. CEX Connectors (`src/collectors/cex/`)

#### CexConnector (base.ts)
Abstract base class providing:
- WebSocket lifecycle management (connect, disconnect, reconnect)
- Exponential backoff: 1s → 2s → 4s → ... → 60s max
- Heartbeat/ping-pong with configurable intervals (default 30s)
- Timeout detection (default 10s without pong = force reconnect)
- Event emitters: `quote`, `connected`, `disconnected`, `error`
- Never gives up on reconnection (infinite retries)

#### BinanceConnector (binance.ts)
- Endpoint: `wss://stream.binance.com:9443/ws/{symbols}@bookTicker`
- Streams: Multiple symbols in single connection (`/ethusdc@bookTicker/cbetheth@bookTicker`)
- Data: Best bid/ask from order book
- Heartbeat: WebSocket ping/pong
- Normalization: `ETHUSDC` → `WETH/USDC`

#### CoinbaseConnector (coinbase.ts)
- Endpoint: `wss://ws-feed.exchange.coinbase.com`
- Channels: `ticker` (level1 data)
- Subscription model: Send subscribe message after connection
- Heartbeat: Coinbase sends heartbeat messages
- Normalization: `ETH-USDC` → `WETH/USDC`

#### BybitConnector (bybit.ts)
- Endpoint: `wss://stream.bybit.com/v5/public/spot`
- Topics: `tickers.SYMBOL`
- Heartbeat: JSON-based ping/pong (`{"op": "ping"}` → `{"op": "pong"}`)
- Filters: Ignores quotes with bid=0 or ask=0
- Normalization: `ETHUSDC` → `WETH/USDC`

**Common Quote Format:**
```typescript
{
  ts: Date,              // Exchange timestamp
  venue: string,         // 'binance', 'coinbase', 'bybit'
  pair: string,          // Canonical: 'WETH/USDC'
  bid: number,           // Best bid price
  ask: number,           // Best ask price
  mid: number,           // (bid + ask) / 2
  latencyMs: number      // Receive time - exchange time
}
```

### 2. Chain Infrastructure (`src/chain/`)

#### ChainProvider (provider.ts)
viem wrapper providing:
- HTTP public client (read-only RPC calls)
- WebSocket public client (real-time subscriptions)
- Optional wallet client (for signing transactions)
- Retry logic built-in (3 retries with 1s delay)
- Helper methods: `getCurrentBlock()`, `getBalance()`, `estimateGas()`

#### BlockWatcher (block-watcher.ts)
- Polls block number at configurable interval (default 2s for Base)
- Emits `block` event on new blocks
- Used by DEX connectors to trigger slot0 reads
- Tracks last seen block to avoid duplicate events

### 3. DEX Connectors (`src/collectors/dex/`)

#### UniswapV3Connector (uniswap-v3.ts)
- Listens to BlockWatcher `block` events
- Fetches `slot0()` and `liquidity()` for all configured pools
- Converts sqrtPriceX96 to human-readable price:
  ```typescript
  price = (sqrtPriceX96 / 2^96)^2 * 10^(token0Decimals - token1Decimals)
  ```
- Handles token ordering (token0 < token1 by address)
- Static `initializePool()` helper to fetch token metadata from chain

**Output Format:**
```typescript
{
  ts: Date,
  venue: 'uniswap_v3',
  pair: string,          // 'WETH/USDC'
  chain: 'base',
  mid: number,           // Computed price
  blockNumber: bigint,
  sqrtPriceX96: bigint,  // Raw Uniswap price
  liquidity: bigint,     // Pool liquidity
  latencyMs: number      // RPC call latency
}
```

### 4. State Management (`src/state/`)

#### QuoteCache (quote-cache.ts)
In-memory cache with:
- Key: `venue:pair[:chain]` (chain optional for CEX)
- Stores latest quote + received timestamp per key
- Tracks current block per chain (updated by BlockWatcher)

**Staleness Detection:**
- CEX: Stale if age > 3000ms (configurable)
- DEX: Stale if `currentBlock - quoteBlock > 2` (configurable)

**Query Methods:**
- `getLatestQuotes()` - All quotes with staleness flags
- `getFreshQuotes()` - Only non-stale quotes
- `getLatestQuotesByPair(pair)` - Filter by pair
- `getLatestQuotesByVenue(venue)` - Filter by venue
- `getStats()` - Cache statistics (total, fresh, stale by venue)

### 5. Persistence (`src/persistence/`)

#### QuotePersistence (quotes.ts)
**Raw Quote Sampling:**
- Samples every Nth quote (default: 1/10)
- Inserts to `quotes_raw` table
- Stores: ts, venue_id, pair_id, chain, bid, ask, mid, block_number, sqrt_price_x96, liquidity, latency_ms

**Rollups:**
- Intervals: 1s, 10s, 1m (configurable)
- Aggregates: open, high, low, close (OHLC)
- Inserts to `quote_rollups` with ON CONFLICT UPDATE
- Runs on timers (every interval duration)
- Uses PostgreSQL window functions for OHLC calculation

#### HealthPersistence (health.ts)
Tracks connector state in `connector_health` table:
- `markConnectorConnected(venueId, chain?)` - Set ws_connected=true
- `markConnectorDisconnected(venueId, chain?)` - Set ws_connected=false
- `incrementReconnectCount(venueId, chain?)` - Bump on reconnect attempts
- `incrementErrorCount(venueId, chain?)` - Bump on errors
- `updateLastQuote(venueId, chain?, blockNumber?)` - Update last_quote_at, last_block

### 6. Orchestration (`src/collectors/orchestrator.ts`)

#### CollectorOrchestrator
Manages full lifecycle:
1. Loads venue/pair ID mappings from Postgres
2. Starts chain providers + block watchers
3. Starts CEX connectors
4. Starts DEX connectors
5. Routes quotes to QuoteCache and persistence layers
6. Manages health tracking for all connectors

**Events:**
- Emits `quote` event for every normalized quote (CEX + DEX)
- Subscribes to connector events (connected, disconnected, error)
- Updates connector_health table on state changes

## Database Schema

### quotes_raw
High-frequency quote samples (sampled at configurable rate).

| Column | Type | Notes |
|--------|------|-------|
| id | BIGSERIAL | Primary key |
| ts | TIMESTAMPTZ | Quote timestamp (source) |
| received_at | TIMESTAMPTZ | When we received it |
| venue_id | INT | FK to venues |
| pair_id | INT | FK to pairs |
| chain | chain | NULL for CEX |
| bid | NUMERIC(24,12) | CEX only |
| ask | NUMERIC(24,12) | CEX only |
| mid | NUMERIC(24,12) | Always present |
| block_number | BIGINT | DEX only |
| sqrt_price_x96 | NUMERIC(78,0) | Uniswap V3 raw |
| liquidity | NUMERIC(38,0) | Uniswap V3 |
| latency_ms | INT | Source → received |
| is_stale | BOOLEAN | Staleness flag |

### quote_rollups
Aggregated OHLC data at 1s, 10s, 1m intervals.

| Column | Type | Notes |
|--------|------|-------|
| id | BIGSERIAL | Primary key |
| interval_type | TEXT | '1s', '10s', '1m' |
| interval_start | TIMESTAMPTZ | Bucket start time |
| venue_id | INT | FK to venues |
| pair_id | INT | FK to pairs |
| chain | chain | NULL for CEX |
| open_mid | NUMERIC(24,12) | First mid in interval |
| high_mid | NUMERIC(24,12) | Max mid in interval |
| low_mid | NUMERIC(24,12) | Min mid in interval |
| close_mid | NUMERIC(24,12) | Last mid in interval |
| vwap | NUMERIC(24,12) | Not yet implemented |
| sample_count | INT | Number of samples |

**Unique constraint:** (interval_type, interval_start, venue_id, pair_id, chain)

### connector_health
Connection state and health metrics.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL | Primary key |
| venue_id | INT | FK to venues |
| chain | chain | NULL for CEX |
| last_quote_at | TIMESTAMPTZ | Last quote received |
| last_block | BIGINT | Last block seen (DEX) |
| ws_connected | BOOLEAN | Current connection state |
| reconnect_count | INT | Total reconnects |
| error_count | INT | Total errors |
| updated_at | TIMESTAMPTZ | Last update |

**Unique constraint:** (venue_id, chain)

## Configuration

### Environment Variables
```bash
# Chain RPC (required)
RPC_BASE_HTTP=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_BASE_WS=wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# CEX API keys (optional, for authenticated endpoints)
BINANCE_API_KEY=...
COINBASE_API_KEY=...
BYBIT_API_KEY=...
```

### Config Files

**config/default.json:**
```json
{
  "system": {
    "quoteStaleThresholdMs": 3000,
    "rawQuoteSampleRate": 10,
    "rollupIntervals": ["1s", "10s", "1m"]
  }
}
```

**config/pairs.json:**
```json
{
  "pairs": [
    {
      "base": "WETH",
      "quote": "USDC",
      "chain": "base",
      "venues": {
        "binance": { "symbol": "ETHUSDC" },
        "coinbase": { "symbol": "ETH-USDC" },
        "bybit": { "symbol": "ETHUSDC" },
        "uniswap_v3": {
          "base": [
            {
              "pool": "0xd0b53D9277642d899DF5C87A3966A349A798F224",
              "feeTier": 500,
              "primary": true
            }
          ]
        }
      }
    }
  ]
}
```

## Usage Example

```typescript
import { CollectorOrchestrator } from './collectors/orchestrator.js';
import { createDbPool } from './persistence/client.js';
import type { Address } from 'viem';

const pool = createDbPool();

const orchestrator = new CollectorOrchestrator(
  {
    chains: {
      base: {
        httpUrl: process.env.RPC_BASE_HTTP!,
        wsUrl: process.env.RPC_BASE_WS,
        enabled: true,
      },
    },
    cex: {
      binance: {
        enabled: true,
        pairs: [{ symbol: 'ethusdc', canonical: 'WETH/USDC' }],
      },
      coinbase: {
        enabled: true,
        pairs: [{ symbol: 'ETH-USDC', canonical: 'WETH/USDC' }],
      },
    },
    dex: {
      uniswap_v3: {
        enabled: true,
        chains: {
          base: [
            {
              address: '0xd0b53D9277642d899DF5C87A3966A349A798F224' as Address,
              token0: '0x4200000000000000000000000000000000000006' as Address,
              token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
              token0Decimals: 18,
              token1Decimals: 6,
              token0Symbol: 'WETH',
              token1Symbol: 'USDC',
              feeTier: 500,
              canonical: 'WETH/USDC',
            },
          ],
        },
      },
    },
    quoteCache: {
      cexStaleThresholdMs: 3000,
      dexBlockLagThreshold: 2,
    },
    quotePersistence: {
      sampleRate: 10,
      rollupIntervals: ['1s', '10s', '1m'],
    },
  },
  pool
);

// Listen for quotes
orchestrator.on('quote', (quote) => {
  console.log('Quote received:', quote);
});

// Start collecting
await orchestrator.start();

// Access quote cache
const cache = orchestrator.getQuoteCache();
const freshQuotes = cache.getFreshQuotesByPair('WETH/USDC');
console.log('Fresh WETH/USDC quotes:', freshQuotes);

// Graceful shutdown
process.on('SIGINT', async () => {
  await orchestrator.stop();
  await pool.end();
  process.exit(0);
});
```

## Testing Strategy

### Unit Tests (to be implemented in Phase 5)
- `sqrtPriceX96ToPrice()` - Price conversion math
- `normalizeSymbol()` - Symbol canonicalization
- `checkStaleness()` - Staleness logic
- Rollup interval calculations

### Integration Tests (to be implemented in Phase 5)
- QuotePersistence with testcontainers (Postgres)
- CEX connector mock data parsing
- UniswapV3Connector with anvil fork

### Manual Testing
1. Start infrastructure: `docker-compose up -d`
2. Run migrations: `npm run db:migrate`
3. Seed venues: `npm run db:seed`
4. Start app: `npm run dev`
5. Verify quotes in Postgres:
   ```sql
   SELECT COUNT(*) FROM quotes_raw;
   SELECT * FROM quote_rollups ORDER BY interval_start DESC LIMIT 10;
   SELECT * FROM connector_health;
   ```

## Error Handling

### WebSocket Errors
- All errors logged with context (venue, pair, error message)
- Reconnection always attempted (exponential backoff, no max attempts)
- Health tracking updated on every error
- Staleness detection marks disconnected venue quotes as stale

### RPC Errors
- Transient errors (timeouts, rate limits): Retry with viem built-in logic
- Permanent errors (invalid params): Logged, no retry
- Connection errors: BlockWatcher continues polling (doesn't crash)

### Postgres Errors
- Quote insertion errors logged but don't crash connector
- Rollup errors logged, next interval will retry
- Health update errors logged, connector continues

## Performance Considerations

### Quote Sampling
- Default: 1/10 quotes persisted to avoid overwhelming Postgres
- All quotes go through QuoteCache regardless
- Rollups provide aggregated view for historical analysis

### Connection Pooling
- Uses pg Pool (not Client) for concurrent queries
- Pool size configurable (default 10 for dev, 20 for prod)

### Block Polling
- 2s interval for Base (matches block time)
- Only fetches block number (not full block data)
- DEX connectors batch all pool reads per block

## Next Steps (Phase 2)

The detection module will consume data from:
1. `QuoteCache.getFreshQuotesByPair(pair)` - Get all fresh quotes for a pair
2. Check anchor CEX (Binance) not stale before computing spreads
3. Calculate spread between CEX anchor and DEX pools
4. Emit opportunities when spread > threshold and persists > duration

**Handoff ready:** All CEX/DEX data is normalized, cached, and ready for spread calculation.
