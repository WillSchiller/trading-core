Spec Additions: Schema, Config, Structure & Policies

Additions to the CEX/DEX Dislocation Trading System spec.

---

1. Database Schema (Postgres DDL)

-- ============================================
-- ENUMS
-- ============================================

CREATE TYPE venue_type AS ENUM ('cex', 'dex');
CREATE TYPE chain AS ENUM ('mainnet', 'base', 'arbitrum');
CREATE TYPE opportunity_status AS ENUM ('detected', 'evaluating', 'skipped', 'submitted', 'filled', 'reverted', 'expired');
CREATE TYPE trade_direction AS ENUM ('buy_dex', 'sell_dex');

-- ============================================
-- VENUE & PAIR CONFIGURATION (reference data)
-- ============================================

CREATE TABLE venues (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,           -- 'binance', 'coinbase', 'uniswap_v3', etc.
    venue_type      venue_type NOT NULL,
    chain           chain,                          -- NULL for CEX
    is_anchor       BOOLEAN DEFAULT FALSE,          -- TRUE for price reference venues (Binance)
    is_enabled      BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE pairs (
    id              SERIAL PRIMARY KEY,
    base_asset      TEXT NOT NULL,                  -- 'ETH'
    quote_asset     TEXT NOT NULL,                  -- 'USDC'
    canonical       TEXT GENERATED ALWAYS AS (base_asset || '/' || quote_asset) STORED,
    is_enabled      BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (base_asset, quote_asset)
);

CREATE TABLE pair_venue_config (
    id                      SERIAL PRIMARY KEY,
    pair_id                 INT REFERENCES pairs(id),
    venue_id                INT REFERENCES venues(id),
    chain                   chain,                      -- for DEX venues
    pool_address            TEXT,                       -- DEX pool address (NULL for CEX)
    fee_tier                INT,                        -- e.g., 500, 3000, 10000 for Uniswap
    external_symbol         TEXT,                       -- venue-specific symbol ('ETHUSDC', 'ETH-USDC')
    min_spread_bps          NUMERIC(6,2) DEFAULT 10,    -- threshold to flag opportunity
    min_duration_ms         INT DEFAULT 2000,           -- min gap duration
    min_liquidity_usd       NUMERIC(18,2),              -- depth threshold
    max_trade_size_usd      NUMERIC(18,2),              -- per-trade cap
    is_enabled              BOOLEAN DEFAULT TRUE,
    created_at              TIMESTAMPTZ DEFAULT now(),
    UNIQUE (pair_id, venue_id, chain, pool_address)
);

-- ============================================
-- QUOTES (raw + rollups)
-- ============================================

-- Raw quotes: high-frequency, consider partitioning by time or sampling
CREATE TABLE quotes_raw (
    id              BIGSERIAL PRIMARY KEY,
    ts              TIMESTAMPTZ NOT NULL,           -- quote timestamp (source time)
    received_at     TIMESTAMPTZ DEFAULT now(),      -- when we received it
    venue_id        INT REFERENCES venues(id),
    pair_id         INT REFERENCES pairs(id),
    chain           chain,
    bid             NUMERIC(24,12),
    ask             NUMERIC(24,12),
    mid             NUMERIC(24,12),
    block_number    BIGINT,                         -- DEX only
    sqrt_price_x96  NUMERIC(78,0),                  -- Uniswap v3 raw
    liquidity       NUMERIC(38,0),                  -- Uniswap v3
    latency_ms      INT,                            -- source → received
    is_stale        BOOLEAN DEFAULT FALSE
);

-- Partition by day for manageability (optional, add later)
CREATE INDEX idx_quotes_raw_ts ON quotes_raw (ts DESC);
CREATE INDEX idx_quotes_raw_venue_pair ON quotes_raw (venue_id, pair_id, ts DESC);

-- Rollups: 1s / 10s / 1m OHLC-style aggregates
CREATE TABLE quote_rollups (
    id              BIGSERIAL PRIMARY KEY,
    interval_type   TEXT NOT NULL,                  -- '1s', '10s', '1m'
    interval_start  TIMESTAMPTZ NOT NULL,
    venue_id        INT REFERENCES venues(id),
    pair_id         INT REFERENCES pairs(id),
    chain           chain,
    open_mid        NUMERIC(24,12),
    high_mid        NUMERIC(24,12),
    low_mid         NUMERIC(24,12),
    close_mid       NUMERIC(24,12),
    vwap            NUMERIC(24,12),
    sample_count    INT,
    UNIQUE (interval_type, interval_start, venue_id, pair_id, chain)
);

CREATE INDEX idx_quote_rollups_lookup ON quote_rollups (venue_id, pair_id, interval_type, interval_start DESC);

-- ============================================
-- OPPORTUNITIES (detected dislocations)
-- ============================================

CREATE TABLE opportunities (
    id                  BIGSERIAL PRIMARY KEY,
    detected_at         TIMESTAMPTZ DEFAULT now(),
    pair_id             INT REFERENCES pairs(id),
    chain               chain NOT NULL,
    
    -- Anchor prices at detection
    anchor_venue_id     INT REFERENCES venues(id),      -- e.g., Binance
    anchor_mid          NUMERIC(24,12) NOT NULL,
    confirm_venue_id    INT REFERENCES venues(id),      -- e.g., Coinbase
    confirm_mid         NUMERIC(24,12),
    
    -- DEX price
    dex_venue_id        INT REFERENCES venues(id),
    dex_pool_address    TEXT,
    dex_mid             NUMERIC(24,12) NOT NULL,
    dex_block_number    BIGINT,
    
    -- Spread analysis
    spread_bps          NUMERIC(8,4) NOT NULL,
    direction           trade_direction NOT NULL,
    
    -- Cost estimates
    estimated_slippage_bps  NUMERIC(8,4),
    estimated_gas_usd       NUMERIC(12,4),
    estimated_pool_fee_bps  NUMERIC(8,4),
    estimated_profit_usd    NUMERIC(12,4),
    
    -- Decision
    status              opportunity_status DEFAULT 'detected',
    skip_reason         TEXT,                           -- if skipped: 'insufficient_spread', 'high_gas', etc.
    
    -- Metadata
    volatility_regime   TEXT,                           -- 'low', 'normal', 'high' (optional)
    reason_codes        TEXT[],                         -- ['v3_vs_cex_gap', 'depth_ok', 'gas_ok']
    metadata            JSONB
);

CREATE INDEX idx_opportunities_ts ON opportunities (detected_at DESC);
CREATE INDEX idx_opportunities_status ON opportunities (status, detected_at DESC);
CREATE INDEX idx_opportunities_pair_chain ON opportunities (pair_id, chain, detected_at DESC);

-- ============================================
-- EXECUTIONS (trade attempts + outcomes)
-- ============================================

CREATE TABLE executions (
    id                  BIGSERIAL PRIMARY KEY,
    opportunity_id      BIGINT REFERENCES opportunities(id),
    
    -- Pre-trade
    created_at          TIMESTAMPTZ DEFAULT now(),
    pair_id             INT REFERENCES pairs(id),
    chain               chain NOT NULL,
    direction           trade_direction NOT NULL,
    pool_address        TEXT NOT NULL,
    
    -- Quoter output (pre-submission)
    input_token         TEXT NOT NULL,
    input_amount        NUMERIC(38,0) NOT NULL,         -- raw units
    input_amount_human  NUMERIC(24,12),                 -- decimal-adjusted
    expected_output     NUMERIC(38,0),
    expected_output_human NUMERIC(24,12),
    quoted_price        NUMERIC(24,12),
    max_slippage_bps    NUMERIC(8,4),
    amount_out_minimum  NUMERIC(38,0),
    deadline            TIMESTAMPTZ,
    
    -- Gas
    gas_price_gwei      NUMERIC(12,4),
    max_fee_per_gas     NUMERIC(18,0),
    max_priority_fee    NUMERIC(18,0),
    gas_limit           INT,
    
    -- Submission
    is_paper_trade      BOOLEAN DEFAULT TRUE,
    tx_hash             TEXT,
    submitted_at        TIMESTAMPTZ,
    submitted_block     BIGINT,
    
    -- Outcome
    status              TEXT,                           -- 'pending', 'confirmed', 'reverted', 'dropped'
    confirmed_at        TIMESTAMPTZ,
    confirmed_block     BIGINT,
    gas_used            INT,
    gas_cost_usd        NUMERIC(12,4),
    
    -- Realized fill
    actual_output       NUMERIC(38,0),
    actual_output_human NUMERIC(24,12),
    realized_price      NUMERIC(24,12),
    realized_slippage_bps NUMERIC(8,4),
    
    -- PnL proxy
    realized_pnl_usd    NUMERIC(12,4),                  -- (actual - expected) in USD terms minus gas
    
    -- Debugging
    revert_reason       TEXT,
    error_message       TEXT,
    metadata            JSONB
);

CREATE INDEX idx_executions_opportunity ON executions (opportunity_id);
CREATE INDEX idx_executions_ts ON executions (created_at DESC);
CREATE INDEX idx_executions_status ON executions (status, created_at DESC);
CREATE INDEX idx_executions_tx ON executions (tx_hash) WHERE tx_hash IS NOT NULL;

-- ============================================
-- SYSTEM STATE & HEALTH
-- ============================================

CREATE TABLE connector_health (
    id              SERIAL PRIMARY KEY,
    venue_id        INT REFERENCES venues(id),
    chain           chain,
    last_quote_at   TIMESTAMPTZ,
    last_block      BIGINT,
    ws_connected    BOOLEAN DEFAULT FALSE,
    reconnect_count INT DEFAULT 0,
    error_count     INT DEFAULT 0,
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE risk_state (
    id                      SERIAL PRIMARY KEY,
    chain                   chain NOT NULL UNIQUE,
    open_exposure_usd       NUMERIC(18,4) DEFAULT 0,
    trades_last_hour        INT DEFAULT 0,
    last_trade_at           TIMESTAMPTZ,
    cooldown_until          TIMESTAMPTZ,
    is_halted               BOOLEAN DEFAULT FALSE,
    halt_reason             TEXT,
    updated_at              TIMESTAMPTZ DEFAULT now()
);

---

2. Project File Structure

dislocation-trader/
│
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── .env.example
├── .env                          # gitignored
├── README.md
│
├── config/
│   ├── default.json              # base config (non-sensitive)
│   ├── production.json           # production overrides
│   └── pairs.json                # pair/venue/pool definitions
│
├── src/
│   ├── index.ts                  # entrypoint: bootstrap, graceful shutdown
│   │
│   ├── config/
│   │   ├── index.ts              # config loader (merges env + files)
│   │   ├── schema.ts             # Zod schemas for config validation
│   │   └── types.ts              # TypeScript interfaces
│   │
│   ├── collectors/
│   │   ├── index.ts              # collector orchestrator
│   │   ├── types.ts              # Quote, NormalizedQuote interfaces
│   │   ├── cex/
│   │   │   ├── base.ts           # abstract CexConnector class
│   │   │   ├── binance.ts
│   │   │   ├── coinbase.ts
│   │   │   ├── bybit.ts
│   │   │   ├── okx.ts
│   │   │   └── kraken.ts
│   │   └── dex/
│   │       ├── base.ts           # abstract DexConnector class
│   │       ├── uniswap-v3.ts
│   │       ├── curve.ts
│   │       ├── aerodrome.ts
│   │       └── balancer.ts
│   │
│   ├── state/
│   │   ├── index.ts              # in-memory price state manager
│   │   ├── quote-cache.ts        # latest quotes per venue/pair
│   │   └── types.ts
│   │
│   ├── detection/
│   │   ├── index.ts              # opportunity detector main loop
│   │   ├── spread-calculator.ts  # CEX vs DEX spread computation
│   │   ├── filters.ts            # threshold checks, depth checks
│   │   ├── opportunity.ts        # Opportunity class/interface
│   │   └── emitter.ts            # event emitter for opportunities
│   │
│   ├── execution/
│   │   ├── index.ts              # execution orchestrator
│   │   ├── quoter.ts             # Uniswap v3 Quoter calls
│   │   ├── router.ts             # SwapRouter tx building
│   │   ├── signer.ts             # wallet/signer management
│   │   ├── gas.ts                # gas estimation, EIP-1559 logic
│   │   ├── risk.ts               # risk limits, cooldowns, exposure
│   │   ├── paper-trader.ts       # paper mode execution (log only)
│   │   └── live-trader.ts        # real tx submission
│   │
│   ├── persistence/
│   │   ├── index.ts              # Postgres client init
│   │   ├── client.ts             # pg Pool wrapper
│   │   ├── quotes.ts             # quote insert/rollup logic
│   │   ├── opportunities.ts      # opportunity CRUD
│   │   ├── executions.ts         # execution logging
│   │   └── health.ts             # connector health updates
│   │
│   ├── chain/
│   │   ├── index.ts              # multi-chain provider manager
│   │   ├── provider.ts           # ethers/viem provider wrapper
│   │   ├── contracts.ts          # contract ABIs and addresses
│   │   └── block-watcher.ts      # new block subscription
│   │
│   ├── utils/
│   │   ├── logger.ts             # structured logging (pino)
│   │   ├── metrics.ts            # internal metrics (optional)
│   │   ├── retry.ts              # exponential backoff helper
│   │   ├── normalization.ts      # pair string normalization
│   │   └── math.ts               # bps calculations, sqrtPriceX96 conversion
│   │
│   └── types/
│       └── index.ts              # shared TypeScript types
│
├── sql/
│   ├── 001_initial_schema.sql    # DDL from above
│   └── 002_seed_venues.sql       # insert default venues/pairs
│
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/
│   │   │   └── postgres.yml
│   │   └── dashboards/
│   │       └── main.json
│   └── dashboards/
│       ├── overview.json
│       ├── spreads.json
│       └── executions.json
│
└── tests/
    ├── unit/
    │   ├── spread-calculator.test.ts
    │   ├── filters.test.ts
    │   ├── gas.test.ts
    │   └── normalization.test.ts
    ├── integration/
    │   ├── collectors.test.ts
    │   ├── persistence.test.ts
    │   └── quoter.test.ts
    └── mocks/
        ├── cex-responses.ts
        ├── rpc-responses.ts
        └── test-helpers.ts

---

3. Configuration Schema

3.1 Environment Variables (.env.example)

# ============================================
# NODE
# ============================================
NODE_ENV=development
LOG_LEVEL=info

# ============================================
# DATABASE
# ============================================
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=dislocation_trader
POSTGRES_USER=trader
POSTGRES_PASSWORD=

# ============================================
# CHAIN RPC
# ============================================
RPC_MAINNET_HTTP=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_MAINNET_WS=wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_BASE_HTTP=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_BASE_WS=wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# ============================================
# CEX API KEYS (read-only, market data only)
# ============================================
BINANCE_API_KEY=
BINANCE_API_SECRET=
COINBASE_API_KEY=
COINBASE_API_SECRET=
COINBASE_PASSPHRASE=
BYBIT_API_KEY=
BYBIT_API_SECRET=
OKX_API_KEY=
OKX_API_SECRET=
OKX_PASSPHRASE=

# ============================================
# EXECUTION WALLET
# ============================================
# CRITICAL: Use a dedicated hot wallet with limited funds
EXECUTOR_PRIVATE_KEY=
# OR use AWS KMS / hardware signer reference
# EXECUTOR_KMS_KEY_ID=

# ============================================
# FEATURE FLAGS
# ============================================
PAPER_MODE=true
ENABLE_EXECUTION=false
ENABLE_MAINNET=false
ENABLE_BASE=true

# ============================================
# RISK LIMITS (can also be in config JSON)
# ============================================
MAX_TRADE_SIZE_USD=1000
MAX_OPEN_EXPOSURE_USD=5000
MAX_GAS_GWEI=100
COOLDOWN_SECONDS=30

3.2 Application Config (config/default.json)

{
  "system": {
    "tickIntervalMs": 100,
    "quoteStaleThresholdMs": 3000,
    "rollupIntervals": ["1s", "10s", "1m"],
    "persistRawQuotes": false,
    "rawQuoteSampleRate": 10
  },

  "detection": {
    "defaultMinSpreadBps": 15,
    "defaultMinDurationMs": 2000,
    "defaultMinLiquidityUsd": 50000,
    "volatilityAdjustment": true,
    "requireConfirmationVenue": true
  },

  "execution": {
    "paperMode": true,
    "maxSlippageBps": 50,
    "deadlineSeconds": 120,
    "gasBufferPercent": 20,
    "simulateBeforeSend": true
  },

  "risk": {
    "maxTradeSizeUsd": 1000,
    "maxOpenExposureUsd": 5000,
    "maxTradesPerHour": 20,
    "cooldownSeconds": 30,
    "maxGasGwei": 100,
    "haltOnConsecutiveReverts": 3
  },

  "venues": {
    "cex": {
      "binance": { "enabled": true, "isAnchor": true, "wsUrl": "wss://stream.binance.com:9443/ws" },
      "coinbase": { "enabled": true, "isAnchor": false, "wsUrl": "wss://ws-feed.exchange.coinbase.com" },
      "bybit": { "enabled": true, "isAnchor": false, "wsUrl": "wss://stream.bybit.com/v5/public/spot" },
      "okx": { "enabled": false, "isAnchor": false, "wsUrl": "wss://ws.okx.com:8443/ws/v5/public" },
      "kraken": { "enabled": false, "isAnchor": false, "wsUrl": "wss://ws.kraken.com" }
    },
    "dex": {
      "uniswap_v3": { "enabled": true, "chains": ["mainnet", "base"] },
      "curve": { "enabled": false, "chains": ["mainnet"] },
      "aerodrome": { "enabled": true, "chains": ["base"] },
      "balancer": { "enabled": false, "chains": ["mainnet"] }
    }
  },

  "chains": {
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
    },
    "base": {
      "enabled": true,
      "chainId": 8453,
      "blockTimeMs": 2000,
      "contracts": {
        "uniswapV3Factory": "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
        "uniswapV3Quoter": "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        "uniswapV3QuoterV2": "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        "uniswapV3Router": "0x2626664c2603336E57B271c5C0b26F421741e481",
        "uniswapUniversalRouter": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
        "aerodromeRouter": "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"
      }
    }
  }
}

3.3 Pairs Config (config/pairs.json)

{
  "meta": {
    "selectionRule": "Each pair requires: (1) two CEX anchors, (2) one primary v3 pool with depth, (3) optional secondary DEX"
  },

  "pairs": [
    {
      "_comment": "=== BASE TIER 1: Deep majors ===",
      "base": "WETH",
      "quote": "USDC",
      "chain": "base",
      "tier": 1,
      "aliases": ["ETH/USDC"],
      "venues": {
        "binance": { "symbol": "ETHUSDC" },
        "coinbase": { "symbol": "ETH-USDC" },
        "bybit": { "symbol": "ETHUSDC" },
        "uniswap_v3": {
          "base": [
            { "pool": "0xd0b53D9277642d899DF5C87A3966A349A798F224", "feeTier": 500, "primary": true },
            { "pool": "0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18", "feeTier": 3000 }
          ]
        },
        "aerodrome": {
          "base": [
            { "pool": "0xcDAC0d6c6C59727a65F871236188350531885C43", "stable": false }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 12,
        "minDurationMs": 1500,
        "minLiquidityUsd": 100000,
        "maxTradeSizeUsd": 5000
      }
    },
    {
      "base": "cbETH",
      "quote": "WETH",
      "chain": "base",
      "tier": 1,
      "_comment": "Coinbase native LST on Base - often more persistent dislocations",
      "venues": {
        "coinbase": { "symbol": "CBETH-ETH", "note": "check if available" },
        "binance": { "symbol": "CBETHETH", "note": "may need CBETH/USDT + ETH/USDT" },
        "uniswap_v3": {
          "base": [
            { "pool": "0x10648BA41B8565907Cfa1496765fA4D95390aa0d", "feeTier": 500, "primary": true }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 8,
        "minDurationMs": 3000,
        "minLiquidityUsd": 50000,
        "maxTradeSizeUsd": 3000
      }
    },
    {
      "base": "wstETH",
      "quote": "WETH",
      "chain": "base",
      "tier": 1,
      "_comment": "Lido LST - check liquidity on Base before enabling",
      "enabled": false,
      "venues": {
        "binance": { "symbol": "WSTETHETH", "note": "may need synthetic via USDT" },
        "uniswap_v3": {
          "base": [
            { "pool": "TBD", "feeTier": 100, "primary": true, "note": "verify pool address" }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 6,
        "minDurationMs": 5000,
        "minLiquidityUsd": 50000,
        "maxTradeSizeUsd": 3000
      }
    },

    {
      "_comment": "=== BASE TIER 2: High-flow alts ===",
      "base": "LINK",
      "quote": "WETH",
      "chain": "base",
      "tier": 2,
      "venues": {
        "binance": { "symbol": "LINKETH" },
        "coinbase": { "symbol": "LINK-ETH" },
        "uniswap_v3": {
          "base": [
            { "pool": "TBD", "feeTier": 3000, "primary": true }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 18,
        "minDurationMs": 2000,
        "minLiquidityUsd": 30000,
        "maxTradeSizeUsd": 2000
      }
    },
    {
      "base": "UNI",
      "quote": "WETH",
      "chain": "base",
      "tier": 2,
      "venues": {
        "binance": { "symbol": "UNIETH" },
        "coinbase": { "symbol": "UNI-ETH" },
        "uniswap_v3": {
          "base": [
            { "pool": "TBD", "feeTier": 3000, "primary": true }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 18,
        "minDurationMs": 2000,
        "minLiquidityUsd": 25000,
        "maxTradeSizeUsd": 2000
      }
    },
    {
      "base": "WBTC",
      "quote": "WETH",
      "chain": "base",
      "tier": 2,
      "_comment": "Only if liquidity is real on Base",
      "enabled": false,
      "venues": {
        "binance": { "symbol": "BTCETH", "note": "use BTC pairs" },
        "coinbase": { "symbol": "BTC-ETH" },
        "uniswap_v3": {
          "base": [
            { "pool": "TBD", "feeTier": 500, "primary": true }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 10,
        "minDurationMs": 2000,
        "minLiquidityUsd": 50000,
        "maxTradeSizeUsd": 3000
      }
    },

    {
      "_comment": "=== BASE TIER 3: Base-native / high reflexivity ===",
      "base": "AERO",
      "quote": "WETH",
      "chain": "base",
      "tier": 3,
      "_comment": "Aerodrome native token - big moves, execution risk",
      "venues": {
        "binance": { "symbol": "AEROETH", "note": "check availability" },
        "coinbase": { "symbol": "AERO-ETH", "note": "may be AERO-USD only" },
        "uniswap_v3": {
          "base": [
            { "pool": "TBD", "feeTier": 3000, "primary": true }
          ]
        },
        "aerodrome": {
          "base": [
            { "pool": "TBD", "stable": false, "note": "native venue" }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 30,
        "minDurationMs": 1500,
        "minLiquidityUsd": 20000,
        "maxTradeSizeUsd": 1000
      }
    },
    {
      "base": "DEGEN",
      "quote": "WETH",
      "chain": "base",
      "tier": 3,
      "_comment": "Meme volatility - only if you accept the risk",
      "enabled": false,
      "venues": {
        "binance": { "symbol": "DEGENETH", "note": "check availability" },
        "uniswap_v3": {
          "base": [
            { "pool": "TBD", "feeTier": 10000, "primary": true }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 50,
        "minDurationMs": 1000,
        "minLiquidityUsd": 10000,
        "maxTradeSizeUsd": 500
      }
    },

    {
      "_comment": "=== MAINNET TIER 1: Core benchmarks (Phase 2) ===",
      "base": "WETH",
      "quote": "USDC",
      "chain": "mainnet",
      "tier": 1,
      "enabled": false,
      "aliases": ["ETH/USDC"],
      "venues": {
        "binance": { "symbol": "ETHUSDC" },
        "coinbase": { "symbol": "ETH-USDC" },
        "bybit": { "symbol": "ETHUSDC" },
        "uniswap_v3": {
          "mainnet": [
            { "pool": "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", "feeTier": 500, "primary": true },
            { "pool": "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8", "feeTier": 3000 }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 8,
        "minDurationMs": 3000,
        "minLiquidityUsd": 500000,
        "maxTradeSizeUsd": 10000
      }
    },

    {
      "_comment": "=== MAINNET TIER 2: LST/LRT families (Phase 2) ===",
      "base": "wstETH",
      "quote": "WETH",
      "chain": "mainnet",
      "tier": 2,
      "enabled": false,
      "_comment": "Mean reversion / basis playground - often more persistent",
      "venues": {
        "binance": { "symbol": "WSTETHETH" },
        "uniswap_v3": {
          "mainnet": [
            { "pool": "0x109830a1AAaD605BbF02a9dFA7B0B92EC2FB7dAa", "feeTier": 100, "primary": true }
          ]
        },
        "curve": {
          "mainnet": [
            { "pool": "0xDC24316b9AE028F1497c275EB9192a3Ea0f67022", "note": "stETH/ETH" }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 5,
        "minDurationMs": 10000,
        "minLiquidityUsd": 200000,
        "maxTradeSizeUsd": 5000
      }
    },
    {
      "base": "rETH",
      "quote": "WETH",
      "chain": "mainnet",
      "tier": 2,
      "enabled": false,
      "_comment": "Rocket Pool LST",
      "venues": {
        "binance": { "symbol": "RETHETH", "note": "check availability" },
        "uniswap_v3": {
          "mainnet": [
            { "pool": "0xa4e0faA58465A2D369aa21B3e42d43374c6F9613", "feeTier": 500, "primary": true }
          ]
        },
        "balancer": {
          "mainnet": [
            { "pool": "0x1E19CF2D73a72Ef1332C882F20534B6519Be0276", "note": "rETH/WETH" }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 5,
        "minDurationMs": 10000,
        "minLiquidityUsd": 100000,
        "maxTradeSizeUsd": 5000
      }
    },
    {
      "base": "cbETH",
      "quote": "WETH",
      "chain": "mainnet",
      "tier": 2,
      "enabled": false,
      "venues": {
        "coinbase": { "symbol": "CBETH-ETH" },
        "uniswap_v3": {
          "mainnet": [
            { "pool": "0x840DEEef2f115Cf50DA625F7368C24af6fE74410", "feeTier": 500, "primary": true }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 6,
        "minDurationMs": 8000,
        "minLiquidityUsd": 100000,
        "maxTradeSizeUsd": 5000
      }
    },
    {
      "base": "weETH",
      "quote": "WETH",
      "chain": "mainnet",
      "tier": 2,
      "enabled": false,
      "_comment": "ether.fi LRT - newer, may have wider dislocations",
      "venues": {
        "binance": { "symbol": "WEETHETH", "note": "check availability" },
        "uniswap_v3": {
          "mainnet": [
            { "pool": "TBD", "feeTier": 500, "primary": true }
          ]
        }
      },
      "thresholds": {
        "minSpreadBps": 8,
        "minDurationMs": 5000,
        "minLiquidityUsd": 50000,
        "maxTradeSizeUsd": 3000
      }
    }
  ]
}

Pool address verification required: Several pools marked TBD need verification before enabling. Use:

* Uniswap Info: https://info.uniswap.org/#/base/pools
* DEX Screener: https://dexscreener.com/base
* On-chain factory query

Tier definitions:

Column 1	Column 2	Column 3	Column 4
Tier	Characteristics	Risk	Threshold guidance
1	Deep majors, tight spreads, high confidence	Low	Lower bps threshold, higher size
2	High-flow alts, more dislocations	Medium	Medium thresholds
3	Native/meme tokens, big moves	High	Higher bps threshold, smaller size


3.4 TypeScript Config Interfaces (src/config/types.ts)

export interface SystemConfig {
  tickIntervalMs: number;
  quoteStaleThresholdMs: number;
  rollupIntervals: ('1s' | '10s' | '1m')[];
  persistRawQuotes: boolean;
  rawQuoteSampleRate: number;
}

export interface DetectionConfig {
  defaultMinSpreadBps: number;
  defaultMinDurationMs: number;
  defaultMinLiquidityUsd: number;
  volatilityAdjustment: boolean;
  requireConfirmationVenue: boolean;
}

export interface ExecutionConfig {
  paperMode: boolean;
  maxSlippageBps: number;
  deadlineSeconds: number;
  gasBufferPercent: number;
  simulateBeforeSend: boolean;
}

export interface RiskConfig {
  maxTradeSizeUsd: number;
  maxOpenExposureUsd: number;
  maxTradesPerHour: number;
  cooldownSeconds: number;
  maxGasGwei: number;
  haltOnConsecutiveReverts: number;
}

export interface ChainConfig {
  enabled: boolean;
  chainId: number;
  blockTimeMs: number;
  contracts: {
    uniswapV3Factory: string;
    uniswapV3Quoter: string;
    uniswapV3QuoterV2: string;
    uniswapV3Router: string;
    uniswapUniversalRouter: string;
    aerodromeRouter?: string;
  };
}

export interface PairThresholds {
  minSpreadBps: number;
  minDurationMs: number;
  minLiquidityUsd: number;
  maxTradeSizeUsd: number;
}

export interface PairVenueConfig {
  symbol?: string;                          // CEX symbol
  pool?: string;                            // DEX pool address
  feeTier?: number;                         // Uniswap fee tier
}

export interface PairConfig {
  base: string;
  quote: string;
  canonical?: string;                       // computed: "ETH/USDC"
  aliasOf?: string;                         // for WETH/USDC -> ETH/USDC
  venues: Record<string, PairVenueConfig | Record<string, PairVenueConfig[]>>;
  thresholds: PairThresholds;
}

export interface AppConfig {
  system: SystemConfig;
  detection: DetectionConfig;
  execution: ExecutionConfig;
  risk: RiskConfig;
  chains: Record<string, ChainConfig>;
  pairs: PairConfig[];
}

---

4. Error Handling & Reconnect Policy

4.1 General Principles

// src/utils/retry.ts

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterPercent: number;                    // 0-100
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterPercent: 20,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY, ...config };
  let lastError: Error;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt === cfg.maxAttempts) break;

      const baseDelay = Math.min(
        cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt - 1),
        cfg.maxDelayMs
      );
      const jitter = baseDelay * (cfg.jitterPercent / 100) * (Math.random() - 0.5) * 2;
      const delay = Math.round(baseDelay + jitter);

      onRetry?.(attempt, lastError, delay);
      await sleep(delay);
    }
  }

  throw lastError!;
}

4.2 WebSocket Reconnect Policy (CEX Connectors)

// Embedded in each CEX connector

interface WsReconnectState {
  isConnected: boolean;
  reconnectAttempts: number;
  lastConnectTime: Date | null;
  lastDisconnectTime: Date | null;
  lastError: string | null;
}

const WS_RECONNECT_CONFIG = {
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
  maxAttempts: Infinity,                    // never give up
  resetAfterMs: 300000,                     // reset attempt count after 5min stable
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMs: 10000,
};

// Behavior:
// 1. On disconnect: increment reconnectAttempts, schedule reconnect with backoff
// 2. On connect success: if stable for resetAfterMs, reset reconnectAttempts to 0
// 3. Send ping every heartbeatIntervalMs; if no pong in heartbeatTimeoutMs, force reconnect
// 4. Log all state transitions to connector_health table
// 5. Mark quotes as stale immediately on disconnect

4.3 RPC Error Handling

// Error categories and handling

enum RpcErrorCategory {
  TRANSIENT = 'transient',                  // retry: rate limit, timeout, 5xx
  PERMANENT = 'permanent',                  // no retry: invalid params, contract revert
  DEGRADED = 'degraded',                    // switch provider: node syncing, bad data
}

function categorizeRpcError(error: Error): RpcErrorCategory {
  const msg = error.message.toLowerCase();
  
  if (msg.includes('rate limit') || msg.includes('429')) return RpcErrorCategory.TRANSIENT;
  if (msg.includes('timeout') || msg.includes('econnreset')) return RpcErrorCategory.TRANSIENT;
  if (msg.includes('502') || msg.includes('503') || msg.includes('504')) return RpcErrorCategory.TRANSIENT;
  
  if (msg.includes('revert') || msg.includes('execution reverted')) return RpcErrorCategory.PERMANENT;
  if (msg.includes('invalid') || msg.includes('bad request')) return RpcErrorCategory.PERMANENT;
  
  if (msg.includes('syncing') || msg.includes('not available')) return RpcErrorCategory.DEGRADED;
  
  return RpcErrorCategory.TRANSIENT;        // default to retry
}

// RPC calls: retry transient errors, fail fast on permanent, switch provider on degraded

4.4 Quote Staleness Policy

// A quote is considered stale if:
// 1. CEX: received_at > quoteStaleThresholdMs (default 3000ms)
// 2. DEX: block_number < currentBlock - 2

// When a venue's quotes go stale:
// 1. Mark is_stale = true in state
// 2. EXCLUDE from opportunity detection (do not use stale prices)
// 3. Log warning
// 4. If anchor (Binance) goes stale: pause all detection until recovered

interface QuoteWithStaleness {
  quote: NormalizedQuote;
  isStale: boolean;
  staleReason?: 'age' | 'disconnect' | 'block_lag';
  staleDurationMs?: number;
}

4.5 Transaction Error Handling

// Execution errors and responses

enum TxErrorType {
  SIMULATION_FAILED = 'simulation_failed',
  UNDERPRICED = 'underpriced',
  NONCE_TOO_LOW = 'nonce_too_low',
  INSUFFICIENT_FUNDS = 'insufficient_funds',
  REVERTED = 'reverted',
  DROPPED = 'dropped',
  TIMEOUT = 'timeout',
}

interface TxErrorResponse {
  type: TxErrorType;
  shouldRetry: boolean;
  shouldHalt: boolean;                      // halt system for manual review
  cooldownMs: number;                       // wait before next trade
  message: string;
}

const TX_ERROR_POLICY: Record<TxErrorType, Omit<TxErrorResponse, 'message' | 'type'>> = {
  simulation_failed: { shouldRetry: false, shouldHalt: false, cooldownMs: 0 },
  underpriced: { shouldRetry: true, shouldHalt: false, cooldownMs: 5000 },
  nonce_too_low: { shouldRetry: true, shouldHalt: false, cooldownMs: 1000 },
  insufficient_funds: { shouldRetry: false, shouldHalt: true, cooldownMs: 0 },
  reverted: { shouldRetry: false, shouldHalt: false, cooldownMs: 10000 },
  dropped: { shouldRetry: true, shouldHalt: false, cooldownMs: 15000 },
  timeout: { shouldRetry: true, shouldHalt: false, cooldownMs: 30000 },
};

---

5. Secrets Management

5.1 Hierarchy

Priority (highest to lowest):
1. Environment variables (for CI/CD and container orchestration)
2. AWS Secrets Manager / Parameter Store (for production)
3. .env file (for local development only)

Never:
- Commit secrets to git
- Log secrets (mask in logger)
- Pass secrets as CLI arguments

5.2 Required Secrets

Column 1	Column 2	Column 3	Column 4
Secret	Env Var	Required	Notes
Postgres password	POSTGRES_PASSWORD	Yes	
RPC URL (Mainnet)	RPC_MAINNET_HTTP	If mainnet enabled	Contains API key
RPC URL (Base)	RPC_BASE_HTTP	If base enabled	Contains API key
Binance API key	BINANCE_API_KEY	If Binance enabled	Read-only sufficient
Binance API secret	BINANCE_API_SECRET	If Binance enabled	
Coinbase credentials	COINBASE_API_KEY, _SECRET, _PASSPHRASE	If Coinbase enabled	
Executor private key	EXECUTOR_PRIVATE_KEY	If live trading	HIGH SENSITIVITY


5.3 Wallet Security (Production)

// For production, avoid raw private keys in env vars.
// Options:

// Option A: AWS KMS
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
// Sign tx digests via KMS; never expose key material

// Option B: Hardware wallet via Frame/Lattice
// Connect via local RPC to hardware signer

// Option C: Dedicated hot wallet with limited funds
// Fund only what you're willing to lose
// Monitor balance and alert on unexpected withdrawals

// Regardless of method:
// - Use a SEPARATE wallet from any other purpose
// - Set up balance alerts
// - Consider multisig for fund recovery

5.4 Secret Rotation

Rotation schedule:
- CEX API keys: every 90 days (or on suspected compromise)
- RPC provider keys: every 90 days
- Postgres password: every 90 days
- Executor wallet: generate new address if compromised; transfer funds

Rotation process:
1. Generate new credential
2. Update in Secrets Manager / env
3. Deploy new version
4. Verify functionality
5. Revoke old credential
6. Log rotation event

---

6. Testing Strategy

6.1 Test Pyramid

                    /\
                   /  \
                  / E2E \           <- Few: full docker-compose, real DBs
                 /______\
                /        \
               / Integr.  \         <- Some: real DB, mocked externals
              /____________\
             /              \
            /     Unit       \      <- Many: pure functions, no I/O
           /__________________\

6.2 Unit Tests

What to unit test:

* spread-calculator.ts: bps calculations, direction logic
* filters.ts: threshold checks, depth validation
* gas.ts: fee estimation, EIP-1559 calculations
* normalization.ts: pair string parsing, symbol mapping
* math.ts: sqrtPriceX96 conversions, liquidity math

Tooling:

* vitest or jest
* No mocks needed (pure functions)

Example:

// tests/unit/spread-calculator.test.ts
import { describe, it, expect } from 'vitest';
import { calculateSpreadBps, determineDirection } from '../../src/detection/spread-calculator';

describe('calculateSpreadBps', () => {
  it('returns positive bps when DEX > CEX', () => {
    const spread = calculateSpreadBps({ cexMid: 1000, dexMid: 1010 });
    expect(spread).toBeCloseTo(100, 1);  // 100 bps = 1%
  });

  it('returns negative bps when DEX < CEX', () => {
    const spread = calculateSpreadBps({ cexMid: 1000, dexMid: 990 });
    expect(spread).toBeCloseTo(-100, 1);
  });
});

describe('determineDirection', () => {
  it('returns buy_dex when DEX is cheaper', () => {
    expect(determineDirection(-50)).toBe('buy_dex');
  });

  it('returns sell_dex when DEX is more expensive', () => {
    expect(determineDirection(50)).toBe('sell_dex');
  });
});

6.3 Integration Tests

What to integration test:

* Postgres persistence (real PG via testcontainers)
* Quoter contract calls (forked mainnet or mocked responses)
* Config loading and validation

Tooling:

* vitest or jest
* testcontainers for Postgres
* anvil (Foundry) for local EVM fork

Example:

// tests/integration/persistence.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createClient, runMigrations } from '../../src/persistence';

describe('Opportunities persistence', () => {
  let container: any;
  let client: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer().start();
    client = createClient(container.getConnectionUri());
    await runMigrations(client);
  }, 60000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it('inserts and retrieves an opportunity', async () => {
    const opp = { pairId: 1, chain: 'base', spreadBps: 25.5, /* ... */ };
    const id = await client.opportunities.insert(opp);
    const retrieved = await client.opportunities.getById(id);
    expect(retrieved.spreadBps).toBe(25.5);
  });
});

6.4 Mocking External Services

// tests/mocks/cex-responses.ts

export const binanceBookTicker = {
  symbol: 'ETHUSDC',
  bidPrice: '1850.50',
  bidQty: '10.5',
  askPrice: '1850.75',
  askQty: '8.2',
  time: 1704067200000,
};

export const coinbaseTicker = {
  type: 'ticker',
  product_id: 'ETH-USDC',
  price: '1850.60',
  best_bid: '1850.55',
  best_ask: '1850.70',
  time: '2025-01-01T00:00:00.000000Z',
};

// tests/mocks/rpc-responses.ts

export const uniswapV3Slot0 = {
  sqrtPriceX96: '1234567890123456789012345678',
  tick: -200100,
  observationIndex: 500,
  observationCardinality: 1000,
  observationCardinalityNext: 1000,
  feeProtocol: 0,
  unlocked: true,
};

export const quoterQuoteExactInputSingle = {
  amountOut: '1850000000',                  // 1850 USDC (6 decimals)
  sqrtPriceX96After: '1234567890123456789012345679',
  initializedTicksCrossed: 2,
  gasEstimate: 150000,
};

6.5 E2E / Smoke Tests

Scope:

* Full docker-compose up
* Inject mock WS data
* Verify opportunity detection fires
* Verify paper trade logged to DB
* Verify Grafana can query data

Run: Manually or in CI before deploy (not on every commit).

6.6 Test Commands

// package.json scripts
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "docker-compose -f docker-compose.test.yml up --abort-on-container-exit"
  }
}

---

7. Task Breakdown (Claude Code–Friendly)

Atomic tasks for implementation, in dependency order:

Phase 0: Scaffolding

[ ] T0.1: Initialize Node.js project with TypeScript, ESLint, Prettier
[ ] T0.2: Create docker-compose.yml with Postgres + Grafana containers
[ ] T0.3: Set up folder structure per spec
[ ] T0.4: Implement config loader with Zod validation
[ ] T0.5: Implement structured logger (pino)
[ ] T0.6: Run initial DDL to create Postgres schema

Phase 1: Data Collection

[ ] T1.1: Implement abstract CexConnector base class with WS lifecycle
[ ] T1.2: Implement BinanceConnector (bookTicker stream)
[ ] T1.3: Implement CoinbaseConnector (level1 stream)
[ ] T1.4: Implement BybitConnector (ticker stream)
[ ] T1.5: Implement in-memory QuoteCache (latest quote per venue/pair)
[ ] T1.6: Implement ChainProvider wrapper (ethers v6 or viem)
[ ] T1.7: Implement UniswapV3Connector (slot0 polling per block)
[ ] T1.8: Implement quote persistence (raw sampling + rollups)
[ ] T1.9: Implement connector health tracking

Phase 2: Detection

[ ] T2.1: Implement SpreadCalculator (CEX anchor vs DEX mid)
[ ] T2.2: Implement spread filters (threshold, duration, depth)
[ ] T2.3: Implement OpportunityDetector main loop
[ ] T2.4: Implement opportunity persistence
[ ] T2.5: Wire up event emitter for detected opportunities

Phase 3: Execution

[ ] T3.1: Implement UniswapQuoter (quoteExactInputSingle call)
[ ] T3.2: Implement GasEstimator (EIP-1559 fee logic)
[ ] T3.3: Implement RiskManager (exposure, cooldown, limits)
[ ] T3.4: Implement PaperTrader (log-only execution)
[ ] T3.5: Implement SwapRouter tx builder
[ ] T3.6: Implement LiveTrader (real tx submission)
[ ] T3.7: Implement execution persistence + outcome tracking

Phase 4: Observability

[ ] T4.1: Create Grafana datasource provisioning (Postgres)
[ ] T4.2: Build “Spreads” dashboard (CEX vs DEX overlay, spread histogram)
[ ] T4.3: Build “Opportunities” dashboard (count, distribution, skip reasons)
[ ] T4.4: Build “Executions” dashboard (fill rate, PnL, gas costs)

Phase 5: Hardening

[ ] T5.1: Add unit tests for spread calculator + filters
[ ] T5.2: Add integration tests for persistence layer
[ ] T5.3: Add integration test for quoter (anvil fork)
[ ] T5.4: Implement graceful shutdown (drain in-flight, close connections)
[ ] T5.5: Add health check endpoint (for monitoring)
[ ] T5.6: Document runbook (start, stop, recover, rotate secrets)

---

8. Resolved Decisions

8.1 Pair List

Approach: Tiered structure maximizing dislocation frequency, persistence, and tradable depth.

Selection rule: Each pair must have:

1. Two independent CEX price anchors (Binance + Coinbase minimum)
2. One primary execution pool (Uniswap v3) with real depth
3. Optional: secondary DEX venue for context (Aerodrome/Curve)

If a pair can’t meet (1) + (2), exclude it.

8.2 Base vs Mainnet Priority

Decision: Base first for MVP.

* Cheaper iterations, lower gas, faster blocks
* Learn execution + slippage dynamics faster
* Add Mainnet once detectors show persistent dislocations with positive EV in paper mode and execution reliability is high

8.3 RPC Provider

Decision: Paid tier from day 1 (core infra cost).

* Preference: QuickNode or Alchemy (good WS + throughput)
* Requirements: HTTPS + WS per chain, sufficient rate limits for slot0 + quoter calls
* Region: low-latency near EC2 deployment region

8.4 Wallet Custody

MVP: Dedicated hot wallet private key via env var, acceptable if:

* Tiny funds only
* Strict risk caps enforced in code
* EC2 locked down (security groups, SSH keys, no public services)

Production: Move to AWS KMS once live with meaningful size.

Non-negotiable: Separate wallet from any other purpose + balance alerts.

8.5 Paper Mode Duration

Run paper until:

* At least a few thousand opportunity observations across market regimes
* Stable cost model (gas + slippage) that matches reality
* Confidence that modeled EV translates to realized PnL

8.6 Canonicalization

Treat WETH/USDC and ETH/USDC as aliases; canonicalize to WETH on-chain.

8.7 Alert Channels

Decision: Telegram for critical errors.

Implementation: Use a Telegram bot + chat group. Simple Node integration:

// src/utils/alerts.ts
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendAlert(message: string, level: 'info' | 'warn' | 'critical' = 'info') {
  const emoji = { info: 'ℹ️', warn: '⚠️', critical: '🚨' }[level];
  const text = `${emoji} *${level.toUpperCase()}*\n\n${message}`;
  
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
  });
}

Alert on:

* System halt (consecutive reverts, insufficient funds)
* Connector disconnects > 60s
* Execution failures
* Risk limit breaches

8.8 Grafana Auth

Decision: IP whitelist + expose port 3000 (simplest for MVP).

Implementation in EC2 security group:

Inbound rule:
- Type: Custom TCP
- Port: 3000
- Source: <your-team-IPs>/32 (comma-separated for multiple)

No additional auth layer for MVP. Revisit if team grows or remote access patterns change.

---

9. Timestamp & Clock Policy (MVP-Hardening)

9.1 Requirements

**Server clock discipline**
- EC2 host MUST run NTP (chrony or systemd-timesyncd)
- Log current NTP sync status at startup (best-effort)

**Use exchange timestamps when provided**
For CEX feeds that provide an exchange event timestamp, parse it and store:
- `exchangeTsMs` - exchange event timestamp
- `receivedTsMs` - local receive time
- `latencyMs = receivedTsMs - exchangeTsMs`

**Timestamp sanity validation**
Drop/flag any quote where:
- `exchangeTsMs > receivedTsMs + 500ms` (future)
- `exchangeTsMs < receivedTsMs - 30000ms` (ancient)
- `latencyMs` is negative (beyond small tolerance)
Mark quote as invalid/stale and exclude from anchor calculations.

**DEX time source**
- Primary staleness remains block-based: stale if `blockNumber < latestBlock - 2`
- Store `blockTsMs` from block header timestamp (via cached block watcher)
- For DEX quotes, set `tsMs = blockTsMs` (preferred) else `receivedTsMs`

**Time alignment gate for opportunity detection**
Only compute spreads/durations using quotes that are time-aligned:
- `tAnchor = anchorQuote.exchangeTsMs ?? anchorQuote.receivedTsMs`
- `tDex = dexQuote.blockTsMs ?? dexQuote.receivedTsMs`
- Require `abs(tAnchor - tDex) <= MAX_TIME_SKEW_MS`
- Default: Base 1500ms, Mainnet 3000ms
- If not aligned: skip opportunity (reason: `time_skew`)

9.2 Drift Monitoring

Maintain rolling metrics per venue:
- `p50/p95 latencyMs`
- `clockOffsetMs = receivedTsMs - exchangeTsMs`

Alert/mark degraded if:
- `p95 latencyMs > 2000ms` for > 60s
- Frequent "future timestamp" rejects occur

Persist to connector_health:
- `last_latency_ms`
- `p95_latency_ms`
- `invalid_ts_count`
- `future_ts_count`

9.3 Implementation Notes

- Binance bookTicker includes event time (`E`). Use it as `exchangeTsMs`.
- Coinbase ticker includes `time` field. Parse ISO timestamp.
- Bybit includes `ts` field (Unix ms).
- For DEX block timestamps, BlockWatcher caches `blockNumber → timestamp` for last N blocks.
- Duration filter "gap persists X ms" must use aligned time basis (not raw local `Date.now()`).

9.4 Defaults

| Parameter | Value |
|-----------|-------|
| MAX_TIME_SKEW_MS (Base) | 1500ms |
| MAX_TIME_SKEW_MS (Mainnet) | 3000ms |
| STALE_CEX_MS | 2000-3000ms |
| STALE_DEX_BLOCK_LAG | 2 blocks |
| MAX_FUTURE_TS_MS | 500ms |
| MAX_PAST_TS_MS | 30000ms |

9.5 Config Schema Additions

```json
{
  "system": {
    "maxFutureTsMs": 500,
    "maxPastTsMs": 30000,
    "dexBlockLagThreshold": 2
  },
  "detection": {
    "maxTimeSkewMsBase": 1500,
    "maxTimeSkewMsMainnet": 3000
  }
}
```

9.6 Database Schema Additions

```sql
-- Add to quotes_raw
ALTER TABLE quotes_raw ADD COLUMN exchange_ts_ms BIGINT;
ALTER TABLE quotes_raw ADD COLUMN received_ts_ms BIGINT;
ALTER TABLE quotes_raw ADD COLUMN block_ts_ms BIGINT;

-- Add to connector_health
ALTER TABLE connector_health ADD COLUMN last_latency_ms INT;
ALTER TABLE connector_health ADD COLUMN p95_latency_ms INT;
ALTER TABLE connector_health ADD COLUMN invalid_ts_count INT DEFAULT 0;
ALTER TABLE connector_health ADD COLUMN future_ts_count INT DEFAULT 0;
```