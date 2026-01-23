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
    name            TEXT NOT NULL UNIQUE,
    venue_type      venue_type NOT NULL,
    chain           chain,
    is_anchor       BOOLEAN DEFAULT FALSE,
    is_enabled      BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE pairs (
    id              SERIAL PRIMARY KEY,
    base_asset      TEXT NOT NULL,
    quote_asset     TEXT NOT NULL,
    canonical       TEXT GENERATED ALWAYS AS (base_asset || '/' || quote_asset) STORED,
    is_enabled      BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (base_asset, quote_asset)
);

CREATE TABLE pair_venue_config (
    id                      SERIAL PRIMARY KEY,
    pair_id                 INT REFERENCES pairs(id),
    venue_id                INT REFERENCES venues(id),
    chain                   chain,
    pool_address            TEXT,
    fee_tier                INT,
    external_symbol         TEXT,
    min_spread_bps          NUMERIC(6,2) DEFAULT 10,
    min_duration_ms         INT DEFAULT 2000,
    min_liquidity_usd       NUMERIC(18,2),
    max_trade_size_usd      NUMERIC(18,2),
    is_enabled              BOOLEAN DEFAULT TRUE,
    created_at              TIMESTAMPTZ DEFAULT now(),
    UNIQUE (pair_id, venue_id, chain, pool_address)
);

-- ============================================
-- QUOTES (raw + rollups)
-- ============================================

CREATE TABLE quotes_raw (
    id              BIGSERIAL PRIMARY KEY,
    ts              TIMESTAMPTZ NOT NULL,
    received_at     TIMESTAMPTZ DEFAULT now(),
    venue_id        INT REFERENCES venues(id),
    pair_id         INT REFERENCES pairs(id),
    chain           chain,
    bid             NUMERIC(24,12),
    ask             NUMERIC(24,12),
    mid             NUMERIC(24,12),
    block_number    BIGINT,
    sqrt_price_x96  NUMERIC(78,0),
    liquidity       NUMERIC(38,0),
    latency_ms      INT,
    is_stale        BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_quotes_raw_ts ON quotes_raw (ts DESC);
CREATE INDEX idx_quotes_raw_venue_pair ON quotes_raw (venue_id, pair_id, ts DESC);

CREATE TABLE quote_rollups (
    id              BIGSERIAL PRIMARY KEY,
    interval_type   TEXT NOT NULL,
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
    anchor_venue_id     INT REFERENCES venues(id),
    anchor_mid          NUMERIC(24,12) NOT NULL,
    confirm_venue_id    INT REFERENCES venues(id),
    confirm_mid         NUMERIC(24,12),
    dex_venue_id        INT REFERENCES venues(id),
    dex_pool_address    TEXT,
    dex_mid             NUMERIC(24,12) NOT NULL,
    dex_block_number    BIGINT,
    spread_bps          NUMERIC(8,4) NOT NULL,
    direction           trade_direction NOT NULL,
    estimated_slippage_bps  NUMERIC(8,4),
    estimated_gas_usd       NUMERIC(12,4),
    estimated_pool_fee_bps  NUMERIC(8,4),
    estimated_profit_usd    NUMERIC(12,4),
    status              opportunity_status DEFAULT 'detected',
    skip_reason         TEXT,
    volatility_regime   TEXT,
    reason_codes        TEXT[],
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
    created_at          TIMESTAMPTZ DEFAULT now(),
    pair_id             INT REFERENCES pairs(id),
    chain               chain NOT NULL,
    direction           trade_direction NOT NULL,
    pool_address        TEXT NOT NULL,
    input_token         TEXT NOT NULL,
    input_amount        NUMERIC(38,0) NOT NULL,
    input_amount_human  NUMERIC(24,12),
    expected_output     NUMERIC(38,0),
    expected_output_human NUMERIC(24,12),
    quoted_price        NUMERIC(24,12),
    max_slippage_bps    NUMERIC(8,4),
    amount_out_minimum  NUMERIC(38,0),
    deadline            TIMESTAMPTZ,
    gas_price_gwei      NUMERIC(12,4),
    max_fee_per_gas     NUMERIC(18,0),
    max_priority_fee    NUMERIC(18,0),
    gas_limit           INT,
    is_paper_trade      BOOLEAN DEFAULT TRUE,
    tx_hash             TEXT,
    submitted_at        TIMESTAMPTZ,
    submitted_block     BIGINT,
    status              TEXT,
    confirmed_at        TIMESTAMPTZ,
    confirmed_block     BIGINT,
    gas_used            INT,
    gas_cost_usd        NUMERIC(12,4),
    actual_output       NUMERIC(38,0),
    actual_output_human NUMERIC(24,12),
    realized_price      NUMERIC(24,12),
    realized_slippage_bps NUMERIC(8,4),
    realized_pnl_usd    NUMERIC(12,4),
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
    updated_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (venue_id, chain)
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
