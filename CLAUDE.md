# CLAUDE.md

> This file provides context for Claude Code when working on this repository.

## Project Overview

**Name**: Dislocation Trader  
**Purpose**: Detect and exploit short-term price dislocations between CEX (Binance, Coinbase, Bybit) and DEX (Uniswap v3, Aerodrome) venues.

**Hypothesis**: Material price gaps occur regularly, persist long enough to act on, and are monetizable after real costs (gas, slippage, fees).

**Architecture**: Single Node.js/TypeScript monolith + Postgres + Grafana, deployed via docker-compose on a single EC2 instance.

## Production Access

SSH to EC2 and query Postgres directly:
```bash
ssh -o StrictHostKeyChecking=no ubuntu@34.252.148.98 "docker exec dislocation-postgres psql -U trader -d dislocation_trader -c \"<SQL>\""
```

Container names: `dislocation-trader-app`, `dislocation-postgres`, `dislocation-grafana`

Grafana: http://34.252.148.98:3000 (not reachable from local, use SSH or browser)

## Documentation

Read these before starting any phase:
- `/docs/spec.md` — Original hypothesis and system overview
- `/docs/spec-additions.md` — Schema, config, file structure, error handling, testing, task breakdown

## Quick Start

```bash
# Install dependencies
npm install

# Start infrastructure (Postgres + Grafana)
docker-compose up -d

# Run database migrations
npm run db:migrate

# Start in development mode
npm run dev

# Run tests
npm run test
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `npm run dev` | Start app in dev mode with hot reload |
| `npm run build` | Compile TypeScript to dist/ |
| `npm run start` | Run compiled app (production) |
| `npm run test` | Run all tests |
| `npm run test:unit` | Run unit tests only |
| `npm run test:integration` | Run integration tests (requires Postgres) |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript compiler check |
| `npm run db:migrate` | Apply database migrations |
| `npm run db:seed` | Seed venues and pairs |

## Project Structure

```
src/
├── index.ts                 # Entrypoint, bootstrap, graceful shutdown
├── config/                  # Config loading + Zod validation
├── collectors/              # CEX and DEX data connectors
│   ├── cex/                 # Binance, Coinbase, Bybit WebSocket clients
│   └── dex/                 # Uniswap v3 slot0 reader, Aerodrome
├── state/                   # In-memory quote cache
├── detection/               # Spread calculator, filters, opportunity emitter
├── execution/               # Quoter, router, paper/live traders, risk manager
├── persistence/             # Postgres client, quote/opportunity/execution repos
├── chain/                   # Multi-chain provider manager, contract ABIs
└── utils/                   # Logger, retry, normalization, math helpers
```

## Tech Stack & Conventions

### Language & Runtime
- **Node.js 20+** with TypeScript 5+
- **ES Modules** (type: "module" in package.json)
- Strict TypeScript config (strict: true, no implicit any)

### Key Libraries
| Purpose | Library | Notes |
|---------|---------|-------|
| Ethereum | `viem` or `ethers` v6 | Prefer viem for new code |
| Postgres | `pg` | Use Pool, not Client |
| WebSocket | `ws` | For CEX connections |
| Validation | `zod` | All config and inputs |
| Logging | `pino` | Structured JSON logs |
| Testing | `vitest` | Unit + integration |
| HTTP | Native `fetch` | No axios needed |

### Code Conventions

**Naming**
- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Types/Interfaces: `PascalCase`

**Prices & Numbers**
- Store prices as `NUMERIC` in Postgres, never `FLOAT`
- Use `bigint` for on-chain amounts (wei, raw token units)
- Use `number` for display values (human-readable amounts)
- Use `Decimal.js` or string math for precise calculations

**Pair Canonicalization**
- Format: `BASE/QUOTE` (e.g., `WETH/USDC`)
- On-chain: always use `WETH`, never `ETH`
- Aliases: `ETH/USDC` → `WETH/USDC`

**Error Handling**
- Use typed errors extending `Error`
- Always include context in error messages
- Use retry helper for transient failures
- Categorize RPC errors (transient/permanent/degraded)

**Logging**
```typescript
// Good
logger.info({ pair: 'WETH/USDC', spreadBps: 15.2, block: 12345 }, 'opportunity detected');

// Bad
logger.info('Opportunity detected for WETH/USDC with spread 15.2 at block 12345');
```

**Config Access**
- Load once at startup via `src/config/index.ts`
- Validate with Zod schema
- Access via typed config object, never raw env vars in business logic

## Database

### Connection
- Use connection pool (pg.Pool)
- Max connections: 10 for dev, 20 for prod
- Credentials from env vars only

### Schema Conventions
- Primary keys: `id SERIAL` or `BIGSERIAL`
- Timestamps: `TIMESTAMPTZ`, always with timezone
- Prices: `NUMERIC(24,12)` for prices, `NUMERIC(38,0)` for raw amounts
- Use enums for fixed sets: `venue_type`, `chain`, `opportunity_status`

### Key Tables
| Table | Purpose |
|-------|---------|
| `venues` | CEX/DEX venue definitions |
| `pairs` | Trading pair definitions |
| `pair_venue_config` | Per-pair-per-venue thresholds |
| `quotes_raw` | High-frequency quote samples |
| `quote_rollups` | Aggregated OHLC data |
| `opportunities` | Detected dislocations |
| `executions` | Trade attempts and outcomes |
| `connector_health` | WS/RPC connection status |
| `risk_state` | Per-chain exposure and limits |

## Chain Configuration

### Supported Chains
| Chain | Chain ID | Block Time | Status |
|-------|----------|------------|--------|
| Base | 8453 | ~2s | MVP (enabled) |
| Mainnet | 1 | ~12s | Phase 2 (disabled) |

### Contract Addresses (Base)
```typescript
const BASE_CONTRACTS = {
  uniswapV3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  uniswapV3Quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  uniswapV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481',
  uniswapUniversalRouter: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
  aerodromeRouter: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
};
```

### RPC Requirements
- Provider: QuickNode or Alchemy (paid tier)
- Endpoints needed: HTTPS + WebSocket
- Rate limits: Must handle slot0 + quoter calls per block

## Risk & Execution Parameters

### Risk Limits (MVP)
```typescript
const RISK_LIMITS = {
  maxTradeSizeUsd: 1000,
  maxOpenExposureUsd: 5000,
  maxTradesPerHour: 20,
  cooldownSeconds: 30,
  maxGasGwei: 100,
  haltOnConsecutiveReverts: 3,
};
```

### Paper Mode
- Default: `PAPER_MODE=true`
- Paper mode logs everything but doesn't submit transactions
- Switch to live only after validating signals

## Testing

### Unit Tests
Test pure functions with no I/O:
- `spread-calculator.ts`
- `filters.ts`
- `gas.ts`
- `normalization.ts`
- `math.ts` (sqrtPriceX96 conversions)

### Integration Tests
Use testcontainers for Postgres:
```typescript
import { PostgreSqlContainer } from '@testcontainers/postgresql';
```

Use anvil for EVM fork testing:
```bash
anvil --fork-url $RPC_BASE_HTTP
```

### Mocks
Located in `tests/mocks/`:
- `cex-responses.ts` — Binance/Coinbase ticker payloads
- `rpc-responses.ts` — slot0, quoter responses

## Environment Variables

Required for development:
```bash
# Database
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=dislocation_trader
POSTGRES_USER=trader
POSTGRES_PASSWORD=<secret>

# RPC (Base)
RPC_BASE_HTTP=https://base-mainnet.g.alchemy.com/v2/<key>
RPC_BASE_WS=wss://base-mainnet.g.alchemy.com/v2/<key>

# CEX (read-only keys)
BINANCE_API_KEY=<key>
BINANCE_API_SECRET=<secret>
COINBASE_API_KEY=<key>
COINBASE_API_SECRET=<secret>
COINBASE_PASSPHRASE=<passphrase>

# Execution (only for live mode)
EXECUTOR_PRIVATE_KEY=<key>

# Alerts
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat_id>

# Feature flags
PAPER_MODE=true
ENABLE_BASE=true
ENABLE_MAINNET=false
```

## Current Status

**Mode**: Perps execution disabled. PCA signals + Polymarket copy trading active.

**Perps context**: Live run (hl_live) ran Feb 2, lost $2.50 over 9 trades before kill switch fired. Shadow data shows positive expectancy but insufficient sample size. On hold.

**Active system**: Polymarket copy trading — shadow-tracking sports traders, recording hypothetical PnL in `pm_live_trades`.

- [x] **Phase 0**: Project setup, docker-compose, config, logging, schema
- [x] **Phase 1**: Data collection (CEX WS, DEX readers, persistence)
- [x] **Phase 2**: Detection (spread calculator, filters, opportunity logging)
- [x] **Phase 3**: Execution (quoter, router, paper trader, live trader)
- [x] **Phase 4**: Observability (Grafana dashboards)
- [ ] **Phase 5**: Hardening (tests, graceful shutdown, runbook)

## Polymarket Copy Trading

**Architecture**: Shadow-track trades from eligible Polymarket sports traders, record hypothetical PnL in `pm_live_trades`.

**Key tables**:
- `pm_shadow_trades` — all observed trades for all tracked traders (training data for eligibility)
- `pm_live_trades` — forward test trades from eligible traders only (clean, no backfill)
- `pm_tracked_traders` — trader registry with eligibility flags

**Dead tables** (historical, not used):
- `pm_positions` — old position tracking, replaced by pm_live_trades
- `pm_copy_trades` — old copy trade records

**Eligibility filters** (from train/test analysis on 769 traders, p=0.0000):
- Sharpe > 0.05
- Profit factor > 1.3
- 50+ resolved trades
- 14+ active days
- Max drawdown < 50% of PnL

**Per-trader circuit breaker**:
- 5 consecutive losses → stop copying
- -$200 total live PnL → stop copying

**Risk limits**:
- $500 max total exposure
- $100 max per market
- $50 daily loss limit (kill switch)

## Task Reference

Each phase has numbered tasks (T0.1, T1.1, etc.) defined in `/docs/spec-additions.md` Section 7.

When starting a phase, reference those tasks explicitly.

Example prompt:
> "Implement Phase 1 tasks T1.1 through T1.4 (CEX connectors + quote cache)"

## Common Gotchas

1. **sqrtPriceX96 conversion**: Uniswap v3 prices are encoded. Use:
   ```typescript
   price = (sqrtPriceX96 ** 2) / (2 ** 192)
   // Adjust for decimals: price * (10 ** (token0Decimals - token1Decimals))
   ```

2. **Quote staleness**: Drop CEX quotes older than 3000ms. Drop DEX quotes if block < currentBlock - 2.

3. **Binance symbol format**: No separator (`ETHUSDC`), Coinbase uses dash (`ETH-USDC`).

4. **Gas estimation**: Always add 20% buffer to estimated gas.

5. **Nonce management**: Track nonce locally to avoid conflicts on rapid submissions.

6. **Pool token ordering**: Uniswap v3 pools have token0 < token1 by address. Price direction depends on which token is which.

## Asking for Help

If you're stuck or need clarification:
1. Reference the specific task number (e.g., "T1.3")
2. Quote the relevant section from the spec
3. Describe what you've tried

## Do Not

- Use `any` type — always define proper types
- Store prices as floats — use NUMERIC/Decimal
- Commit secrets — use .env (gitignored)
- Skip error handling — wrap external calls in try/catch
- Ignore reconnection logic — WS connections will drop
- Submit transactions without simulation — always dry-run first
- Trade on Mainnet in Phase 1 — Base only for MVP
