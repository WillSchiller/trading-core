-- ============================================
-- SEED VENUES
-- ============================================

INSERT INTO venues (name, venue_type, is_anchor, is_enabled) VALUES
    ('binance', 'cex', TRUE, TRUE),
    ('coinbase', 'cex', FALSE, TRUE),
    ('bybit', 'cex', FALSE, TRUE),
    ('uniswap_v3', 'dex', FALSE, TRUE),
    ('aerodrome', 'dex', FALSE, TRUE),
    ('protocol', 'cex', TRUE, TRUE)
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- SEED PAIRS
-- ============================================

INSERT INTO pairs (base_asset, quote_asset, is_enabled) VALUES
    ('WETH', 'USDC', TRUE),
    ('cbETH', 'WETH', TRUE),
    ('weETH', 'WETH', TRUE),
    ('wstETH', 'WETH', TRUE),
    ('rETH', 'WETH', TRUE),
    ('USDC', 'USDbC', TRUE),
    ('cbBTC', 'USDC', TRUE),
    ('cbBTC', 'WETH', TRUE)
ON CONFLICT (base_asset, quote_asset) DO NOTHING;

-- ============================================
-- SEED PAIR VENUE CONFIG
-- ============================================

-- WETH/USDC on Binance
INSERT INTO pair_venue_config (pair_id, venue_id, external_symbol, min_spread_bps, min_duration_ms, min_liquidity_usd, max_trade_size_usd)
SELECT p.id, v.id, 'ETHUSDC', 30, 2000, 100000, 500
FROM pairs p, venues v
WHERE p.canonical = 'WETH/USDC' AND v.name = 'binance'
ON CONFLICT (pair_id, venue_id, chain, pool_address) DO NOTHING;

-- WETH/USDC on Coinbase
INSERT INTO pair_venue_config (pair_id, venue_id, external_symbol, min_spread_bps, min_duration_ms, min_liquidity_usd, max_trade_size_usd)
SELECT p.id, v.id, 'ETH-USD', 30, 2000, 100000, 500
FROM pairs p, venues v
WHERE p.canonical = 'WETH/USDC' AND v.name = 'coinbase'
ON CONFLICT (pair_id, venue_id, chain, pool_address) DO NOTHING;

-- WETH/USDC on Bybit
INSERT INTO pair_venue_config (pair_id, venue_id, external_symbol, min_spread_bps, min_duration_ms, min_liquidity_usd, max_trade_size_usd)
SELECT p.id, v.id, 'ETHUSDC', 30, 2000, 100000, 500
FROM pairs p, venues v
WHERE p.canonical = 'WETH/USDC' AND v.name = 'bybit'
ON CONFLICT (pair_id, venue_id, chain, pool_address) DO NOTHING;

-- WETH/USDC on Uniswap v3 Base (500 fee tier - primary)
INSERT INTO pair_venue_config (pair_id, venue_id, chain, pool_address, fee_tier, min_spread_bps, min_duration_ms, min_liquidity_usd, max_trade_size_usd)
SELECT p.id, v.id, 'base', '0xd0b53D9277642d899DF5C87A3966A349A798F224', 500, 30, 2000, 100000, 500
FROM pairs p, venues v
WHERE p.canonical = 'WETH/USDC' AND v.name = 'uniswap_v3'
ON CONFLICT (pair_id, venue_id, chain, pool_address) DO NOTHING;

-- WETH/USDC on Aerodrome Base
INSERT INTO pair_venue_config (pair_id, venue_id, chain, pool_address, min_spread_bps, min_duration_ms, min_liquidity_usd, max_trade_size_usd)
SELECT p.id, v.id, 'base', '0xcDAC0d6c6C59727a65F871236188350531885C43', 30, 2000, 100000, 500
FROM pairs p, venues v
WHERE p.canonical = 'WETH/USDC' AND v.name = 'aerodrome'
ON CONFLICT (pair_id, venue_id, chain, pool_address) DO NOTHING;

-- cbETH/WETH on Coinbase
INSERT INTO pair_venue_config (pair_id, venue_id, external_symbol, min_spread_bps, min_duration_ms, min_liquidity_usd, max_trade_size_usd)
SELECT p.id, v.id, 'CBETH-ETH', 20, 2000, 50000, 500
FROM pairs p, venues v
WHERE p.canonical = 'cbETH/WETH' AND v.name = 'coinbase'
ON CONFLICT (pair_id, venue_id, chain, pool_address) DO NOTHING;

-- cbETH/WETH on Uniswap v3 Base
INSERT INTO pair_venue_config (pair_id, venue_id, chain, pool_address, fee_tier, min_spread_bps, min_duration_ms, min_liquidity_usd, max_trade_size_usd)
SELECT p.id, v.id, 'base', '0x10648BA41B8565907Cfa1496765fA4D95390aa0d', 500, 20, 2000, 50000, 500
FROM pairs p, venues v
WHERE p.canonical = 'cbETH/WETH' AND v.name = 'uniswap_v3'
ON CONFLICT (pair_id, venue_id, chain, pool_address) DO NOTHING;

-- weETH/WETH on Uniswap v3 Base (0.01% fee)
INSERT INTO pair_venue_config (pair_id, venue_id, chain, pool_address, fee_tier, min_spread_bps, min_duration_ms, min_liquidity_usd, max_trade_size_usd)
SELECT p.id, v.id, 'base', '0xb1419a7f9e8c6e434b1d05377e0dbc4154e3de78', 100, 15, 2000, 25000, 500
FROM pairs p, venues v
WHERE p.canonical = 'weETH/WETH' AND v.name = 'uniswap_v3'
ON CONFLICT (pair_id, venue_id, chain, pool_address) DO NOTHING;

-- wstETH/WETH on Uniswap v3 Base (0.01% fee)
INSERT INTO pair_venue_config (pair_id, venue_id, chain, pool_address, fee_tier, min_spread_bps, min_duration_ms, min_liquidity_usd, max_trade_size_usd)
SELECT p.id, v.id, 'base', '0x20E068D76f9E90b90604500B84c7e19dCB923e7e', 100, 15, 2000, 25000, 500
FROM pairs p, venues v
WHERE p.canonical = 'wstETH/WETH' AND v.name = 'uniswap_v3'
ON CONFLICT (pair_id, venue_id, chain, pool_address) DO NOTHING;

-- rETH/WETH on Uniswap v3 Base (0.05% fee)
INSERT INTO pair_venue_config (pair_id, venue_id, chain, pool_address, fee_tier, min_spread_bps, min_duration_ms, min_liquidity_usd, max_trade_size_usd)
SELECT p.id, v.id, 'base', '0x9e13996a9f5a9870c105d7e3c311848273740e98', 500, 20, 2000, 25000, 500
FROM pairs p, venues v
WHERE p.canonical = 'rETH/WETH' AND v.name = 'uniswap_v3'
ON CONFLICT (pair_id, venue_id, chain, pool_address) DO NOTHING;

-- USDC/USDbC on Uniswap v3 Base (0.01% fee - stablecoin peg)
INSERT INTO pair_venue_config (pair_id, venue_id, chain, pool_address, fee_tier, min_spread_bps, min_duration_ms, min_liquidity_usd, max_trade_size_usd)
SELECT p.id, v.id, 'base', '0x06959273E9A65433De71F5A452D529544E07dDD0', 100, 5, 1000, 10000, 1000
FROM pairs p, venues v
WHERE p.canonical = 'USDC/USDbC' AND v.name = 'uniswap_v3'
ON CONFLICT (pair_id, venue_id, chain, pool_address) DO NOTHING;

-- ============================================
-- SEED RISK STATE
-- ============================================

INSERT INTO risk_state (chain) VALUES ('base'), ('mainnet')
ON CONFLICT (chain) DO NOTHING;

-- ============================================
-- SEED CONNECTOR HEALTH
-- ============================================

INSERT INTO connector_health (venue_id)
SELECT id FROM venues v
WHERE NOT EXISTS (SELECT 1 FROM connector_health ch WHERE ch.venue_id = v.id);
