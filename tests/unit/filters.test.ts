import { describe, it, expect, beforeEach } from 'vitest';
import {
  thresholdFilter,
  durationFilter,
  depthFilter,
  stalenessFilter,
  volatilityFilter,
  anchorConfidenceFilter,
  quoteRefreshFilter,
  gasAdjustedThresholdFilter,
  getMaxTimeSkewMs,
  getMinSpreadBpsMultiplier,
  getMinDurationMsMultiplier,
  getMinQuoteRefreshes,
  type QuoteRefreshState,
} from '../../src/detection/filters.js';
import type { QuoteWithStaleness, NormalizedQuote } from '../../src/types/index.js';

describe('thresholdFilter', () => {
  it('passes when absolute spread exceeds threshold', () => {
    const result = thresholdFilter({ spreadBps: 15, minSpreadBps: 10 });
    expect(result.passed).toBe(true);
    expect(result.reason).toBe('spread_above_threshold');
  });

  it('passes when negative spread exceeds threshold', () => {
    const result = thresholdFilter({ spreadBps: -15, minSpreadBps: 10 });
    expect(result.passed).toBe(true);
    expect(result.reason).toBe('spread_above_threshold');
  });

  it('fails when spread is below threshold', () => {
    const result = thresholdFilter({ spreadBps: 5, minSpreadBps: 10 });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('spread_below_threshold');
  });

  it('passes when spread exactly equals threshold', () => {
    const result = thresholdFilter({ spreadBps: 10, minSpreadBps: 10 });
    expect(result.passed).toBe(true);
  });
});

describe('durationFilter', () => {
  let gapFirstSeenMap: Map<string, number>;

  beforeEach(() => {
    gapFirstSeenMap = new Map();
  });

  it('fails on first detection and tracks gap', () => {
    const result = durationFilter({
      pairChainKey: 'WETH/USDC:base',
      currentSpreadBps: 15,
      minSpreadBps: 10,
      minDurationMs: 2000,
      gapFirstSeenMap,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('duration_not_met');
    expect(gapFirstSeenMap.has('WETH/USDC:base')).toBe(true);
  });

  it('fails when duration not met', () => {
    const now = Date.now();
    gapFirstSeenMap.set('WETH/USDC:base', now - 1000);

    const result = durationFilter({
      pairChainKey: 'WETH/USDC:base',
      currentSpreadBps: 15,
      minSpreadBps: 10,
      minDurationMs: 2000,
      gapFirstSeenMap,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('duration_not_met');
  });

  it('passes when duration threshold met', () => {
    const now = Date.now();
    gapFirstSeenMap.set('WETH/USDC:base', now - 2500);

    const result = durationFilter({
      pairChainKey: 'WETH/USDC:base',
      currentSpreadBps: 15,
      minSpreadBps: 10,
      minDurationMs: 2000,
      gapFirstSeenMap,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBe('duration_met');
  });

  it('resets tracking when spread falls below threshold', () => {
    gapFirstSeenMap.set('WETH/USDC:base', Date.now() - 3000);

    const result = durationFilter({
      pairChainKey: 'WETH/USDC:base',
      currentSpreadBps: 5,
      minSpreadBps: 10,
      minDurationMs: 2000,
      gapFirstSeenMap,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('spread_below_threshold');
    expect(gapFirstSeenMap.has('WETH/USDC:base')).toBe(false);
  });

  it('resets quote refresh map when spread falls below threshold', () => {
    const quoteRefreshMap: Map<string, QuoteRefreshState> = new Map();
    gapFirstSeenMap.set('WETH/USDC:base', Date.now() - 3000);
    quoteRefreshMap.set('WETH/USDC:base', {
      count: 3,
      lastHash: 'some-hash',
      spreadDirection: 'sell_dex',
    });

    const result = durationFilter({
      pairChainKey: 'WETH/USDC:base',
      currentSpreadBps: 5,
      minSpreadBps: 10,
      minDurationMs: 2000,
      gapFirstSeenMap,
      quoteRefreshMap,
    });

    expect(result.passed).toBe(false);
    expect(gapFirstSeenMap.has('WETH/USDC:base')).toBe(false);
    expect(quoteRefreshMap.has('WETH/USDC:base')).toBe(false);
  });

  it('tracks different pair-chain combinations independently', () => {
    const now = Date.now();
    gapFirstSeenMap.set('WETH/USDC:base', now - 3000);
    gapFirstSeenMap.set('cbETH/WETH:base', now - 500);

    const result1 = durationFilter({
      pairChainKey: 'WETH/USDC:base',
      currentSpreadBps: 15,
      minSpreadBps: 10,
      minDurationMs: 2000,
      gapFirstSeenMap,
    });

    const result2 = durationFilter({
      pairChainKey: 'cbETH/WETH:base',
      currentSpreadBps: 15,
      minSpreadBps: 10,
      minDurationMs: 2000,
      gapFirstSeenMap,
    });

    expect(result1.passed).toBe(true);
    expect(result2.passed).toBe(false);
  });
});

describe('depthFilter', () => {
  it('passes when liquidity exceeds minimum', () => {
    const result = depthFilter({
      liquidity: BigInt(100),
      minLiquidityUsd: 100000,
      dexMid: 2000,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBe('depth_sufficient');
  });

  it('fails when liquidity is below minimum', () => {
    const result = depthFilter({
      liquidity: BigInt(10),
      minLiquidityUsd: 100000,
      dexMid: 2000,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('depth_insufficient');
  });

  it('fails when liquidity is undefined', () => {
    const result = depthFilter({
      liquidity: undefined,
      minLiquidityUsd: 100000,
      dexMid: 2000,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('depth_unknown');
  });

  it('calculates liquidity in USD correctly', () => {
    const result = depthFilter({
      liquidity: BigInt(50),
      minLiquidityUsd: 100000,
      dexMid: 2000,
    });

    expect(result.passed).toBe(true);
  });
});

describe('stalenessFilter', () => {
  function createQuoteWithStaleness(
    venue: string,
    isStale: boolean
  ): QuoteWithStaleness {
    return {
      quote: {
        ts: new Date(),
        venue,
        pair: 'WETH/USDC',
        mid: 2000,
        latencyMs: 10,
      },
      isStale,
    };
  }

  it('passes when all quotes are fresh', () => {
    const quotes = [
      createQuoteWithStaleness('binance', false),
      createQuoteWithStaleness('uniswap_v3', false),
    ];

    const result = stalenessFilter({ quotes });

    expect(result.passed).toBe(true);
    expect(result.reason).toBe('quotes_fresh');
  });

  it('fails when any quote is stale', () => {
    const quotes = [
      createQuoteWithStaleness('binance', false),
      createQuoteWithStaleness('uniswap_v3', true),
    ];

    const result = stalenessFilter({ quotes });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('quotes_stale');
    expect(result.reason).toContain('uniswap_v3');
  });

  it('lists all stale venues in reason', () => {
    const quotes = [
      createQuoteWithStaleness('binance', true),
      createQuoteWithStaleness('coinbase', false),
      createQuoteWithStaleness('uniswap_v3', true),
    ];

    const result = stalenessFilter({ quotes });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('binance');
    expect(result.reason).toContain('uniswap_v3');
    expect(result.reason).not.toContain('coinbase');
  });
});

describe('volatilityFilter', () => {
  it('passes when volatility adjustment is disabled', () => {
    const result = volatilityFilter({
      spreadBps: 5,
      minSpreadBps: 10,
      volatilityAdjustment: false,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBe('volatility_adjustment_disabled');
  });

  it('passes in normal volatility when spread exceeds threshold', () => {
    const result = volatilityFilter({
      spreadBps: 15,
      minSpreadBps: 10,
      volatilityRegime: 'normal',
      volatilityAdjustment: true,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBe('volatility_normal');
  });

  it('widens threshold in high volatility regime', () => {
    const result = volatilityFilter({
      spreadBps: 12,
      minSpreadBps: 10,
      volatilityRegime: 'high',
      volatilityAdjustment: true,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('volatility_high_threshold_not_met');
  });

  it('passes in high volatility when spread exceeds adjusted threshold', () => {
    const result = volatilityFilter({
      spreadBps: 20,
      minSpreadBps: 10,
      volatilityRegime: 'high',
      volatilityAdjustment: true,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBe('volatility_high_threshold_met');
  });
});

describe('anchorConfidenceFilter', () => {
  it('passes with high confidence', () => {
    const result = anchorConfidenceFilter({
      confidence: 'high',
      anchorDivergenceBps: 3,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBe('anchors_agree');
  });

  it('passes with medium confidence', () => {
    const result = anchorConfidenceFilter({
      confidence: 'medium',
      anchorDivergenceBps: 7,
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toContain('anchors_moderate_agreement');
  });

  it('fails with low confidence', () => {
    const result = anchorConfidenceFilter({
      confidence: 'low',
      anchorDivergenceBps: 15,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('anchors_divergent');
  });

  it('includes divergence amount in reason', () => {
    const result = anchorConfidenceFilter({
      confidence: 'low',
      anchorDivergenceBps: 25.5,
    });

    expect(result.reason).toContain('25.50bps');
  });
});

describe('getMaxTimeSkewMs', () => {
  it('returns 1500ms for base chain', () => {
    expect(getMaxTimeSkewMs('base')).toBe(1500);
  });

  it('returns 3000ms for mainnet chain', () => {
    expect(getMaxTimeSkewMs('mainnet')).toBe(3000);
  });

  it('returns default 1500ms for unknown chain', () => {
    expect(getMaxTimeSkewMs('arbitrum')).toBe(1500);
  });
});

describe('getMinSpreadBpsMultiplier', () => {
  it('returns 1.0 for base chain', () => {
    expect(getMinSpreadBpsMultiplier('base')).toBe(1.0);
  });

  it('returns 2.75 for mainnet chain', () => {
    expect(getMinSpreadBpsMultiplier('mainnet')).toBe(2.75);
  });

  it('returns default 1.0 for unknown chain', () => {
    expect(getMinSpreadBpsMultiplier('arbitrum')).toBe(1.0);
  });
});

describe('getMinDurationMsMultiplier', () => {
  it('returns 1.0 for base chain', () => {
    expect(getMinDurationMsMultiplier('base')).toBe(1.0);
  });

  it('returns 2.5 for mainnet chain', () => {
    expect(getMinDurationMsMultiplier('mainnet')).toBe(2.5);
  });

  it('returns default 1.0 for unknown chain', () => {
    expect(getMinDurationMsMultiplier('arbitrum')).toBe(1.0);
  });
});

describe('getMinQuoteRefreshes', () => {
  it('returns 1 for base chain', () => {
    expect(getMinQuoteRefreshes('base')).toBe(1);
  });

  it('returns 2 for mainnet chain', () => {
    expect(getMinQuoteRefreshes('mainnet')).toBe(2);
  });

  it('returns default 1 for unknown chain', () => {
    expect(getMinQuoteRefreshes('arbitrum')).toBe(1);
  });
});

describe('quoteRefreshFilter', () => {
  let quoteRefreshMap: Map<string, QuoteRefreshState>;

  function createMockQuote(mid: number, receivedTsMs: number, exchangeTsMs?: number): NormalizedQuote {
    return {
      ts: new Date(receivedTsMs),
      venue: 'binance',
      pair: 'WETH/USDC',
      mid,
      latencyMs: 10,
      receivedTsMs,
      exchangeTsMs,
    };
  }

  function createDexQuote(mid: number, blockTsMs: number): NormalizedQuote {
    return {
      ts: new Date(blockTsMs),
      venue: 'uniswap_v3',
      pair: 'WETH/USDC',
      chain: 'mainnet',
      mid,
      latencyMs: 10,
      receivedTsMs: blockTsMs,
      blockTsMs,
    };
  }

  beforeEach(() => {
    quoteRefreshMap = new Map();
  });

  it('fails on first detection and tracks state', () => {
    const result = quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:mainnet',
      anchorQuote: createMockQuote(2000, 1000, 995),
      dexQuote: createDexQuote(2030, 1000),
      spreadDirection: 'sell_dex',
      minQuoteRefreshes: 2,
      quoteRefreshMap,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('quote_refresh_count: 1/2');
    expect(quoteRefreshMap.has('WETH/USDC:mainnet')).toBe(true);

    const state = quoteRefreshMap.get('WETH/USDC:mainnet');
    expect(state?.count).toBe(1);
    expect(state?.spreadDirection).toBe('sell_dex');
  });

  it('increments count when quote data changes', () => {
    quoteRefreshMap.set('WETH/USDC:mainnet', {
      count: 1,
      lastHash: '2000.00000000|995|2030.00000000|1000',
      spreadDirection: 'sell_dex',
    });

    const result = quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:mainnet',
      anchorQuote: createMockQuote(2001, 1100, 1095),
      dexQuote: createDexQuote(2031, 1100),
      spreadDirection: 'sell_dex',
      minQuoteRefreshes: 2,
      quoteRefreshMap,
    });

    const state = quoteRefreshMap.get('WETH/USDC:mainnet');
    expect(state?.count).toBe(2);
    expect(result.passed).toBe(true);
    expect(result.reason).toBe('quote_refresh_met: 2/2');
  });

  it('does not increment count when quote data is unchanged', () => {
    const anchorQuote = createMockQuote(2000, 1000, 995);
    const dexQuote = createDexQuote(2030, 1000);

    quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:mainnet',
      anchorQuote,
      dexQuote,
      spreadDirection: 'sell_dex',
      minQuoteRefreshes: 2,
      quoteRefreshMap,
    });

    const result = quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:mainnet',
      anchorQuote,
      dexQuote,
      spreadDirection: 'sell_dex',
      minQuoteRefreshes: 2,
      quoteRefreshMap,
    });

    const state = quoteRefreshMap.get('WETH/USDC:mainnet');
    expect(state?.count).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('quote_refresh_count: 1/2');
  });

  it('resets count when spread direction changes', () => {
    quoteRefreshMap.set('WETH/USDC:mainnet', {
      count: 3,
      lastHash: '2000.00000000|995|2030.00000000|1000',
      spreadDirection: 'sell_dex',
    });

    const result = quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:mainnet',
      anchorQuote: createMockQuote(2000, 1100, 1095),
      dexQuote: createDexQuote(1970, 1100),
      spreadDirection: 'buy_dex',
      minQuoteRefreshes: 2,
      quoteRefreshMap,
    });

    const state = quoteRefreshMap.get('WETH/USDC:mainnet');
    expect(state?.count).toBe(1);
    expect(state?.spreadDirection).toBe('buy_dex');
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('quote_refresh_direction_changed: 1/2');
  });

  it('passes immediately for Base chain with minQuoteRefreshes=1', () => {
    const result = quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:base',
      anchorQuote: createMockQuote(2000, 1000, 995),
      dexQuote: createDexQuote(2030, 1000),
      spreadDirection: 'sell_dex',
      minQuoteRefreshes: 1,
      quoteRefreshMap,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('quote_refresh_count: 1/1');

    const result2 = quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:base',
      anchorQuote: createMockQuote(2001, 1100, 1095),
      dexQuote: createDexQuote(2031, 1100),
      spreadDirection: 'sell_dex',
      minQuoteRefreshes: 1,
      quoteRefreshMap,
    });

    expect(result2.passed).toBe(true);
    expect(result2.reason).toBe('quote_refresh_met: 2/1');
  });

  it('detects price changes even with same timestamp', () => {
    quoteRefreshMap.set('WETH/USDC:mainnet', {
      count: 1,
      lastHash: '2000.00000000|1000|2030.00000000|1000',
      spreadDirection: 'sell_dex',
    });

    const result = quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:mainnet',
      anchorQuote: createMockQuote(2005, 1000),
      dexQuote: createDexQuote(2030, 1000),
      spreadDirection: 'sell_dex',
      minQuoteRefreshes: 2,
      quoteRefreshMap,
    });

    const state = quoteRefreshMap.get('WETH/USDC:mainnet');
    expect(state?.count).toBe(2);
    expect(result.passed).toBe(true);
  });

  it('includes confirmation quote in hash when present', () => {
    const result1 = quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:mainnet',
      anchorQuote: createMockQuote(2000, 1000, 995),
      dexQuote: createDexQuote(2030, 1000),
      confirmQuote: createMockQuote(2002, 1000, 998),
      spreadDirection: 'sell_dex',
      minQuoteRefreshes: 2,
      quoteRefreshMap,
    });

    expect(result1.passed).toBe(false);

    const result2 = quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:mainnet',
      anchorQuote: createMockQuote(2000, 1000, 995),
      dexQuote: createDexQuote(2030, 1000),
      confirmQuote: createMockQuote(2003, 1100, 1095),
      spreadDirection: 'sell_dex',
      minQuoteRefreshes: 2,
      quoteRefreshMap,
    });

    const state = quoteRefreshMap.get('WETH/USDC:mainnet');
    expect(state?.count).toBe(2);
    expect(result2.passed).toBe(true);
  });

  it('tracks different pair-chain combinations independently', () => {
    quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:mainnet',
      anchorQuote: createMockQuote(2000, 1000),
      dexQuote: createDexQuote(2030, 1000),
      spreadDirection: 'sell_dex',
      minQuoteRefreshes: 2,
      quoteRefreshMap,
    });

    quoteRefreshFilter({
      pairChainKey: 'WETH/USDC:base',
      anchorQuote: createMockQuote(2000, 1000),
      dexQuote: createDexQuote(2030, 1000),
      spreadDirection: 'sell_dex',
      minQuoteRefreshes: 1,
      quoteRefreshMap,
    });

    expect(quoteRefreshMap.get('WETH/USDC:mainnet')?.count).toBe(1);
    expect(quoteRefreshMap.get('WETH/USDC:base')?.count).toBe(1);
  });
});

describe('gasAdjustedThresholdFilter', () => {
  it('passes for Base chain (gas filter not applicable)', () => {
    const result = gasAdjustedThresholdFilter({
      spreadBps: 15,
      minSpreadBps: 10,
      chain: 'base',
      gasGwei: 0.5,
      gasBpsPerGwei: 0.5,
      defaultGasGwei: 50,
    });
    expect(result.passed).toBe(true);
    expect(result.reason).toBe('gas_adjustment_not_required_for_chain');
  });

  it('passes when spread exceeds gas-adjusted threshold on mainnet', () => {
    const result = gasAdjustedThresholdFilter({
      spreadBps: 40,
      minSpreadBps: 10,
      chain: 'mainnet',
      gasGwei: 30,
      gasBpsPerGwei: 0.5,
      defaultGasGwei: 50,
    });
    expect(result.passed).toBe(true);
    expect(result.reason).toContain('gas_adjusted_threshold_met');
    expect(result.reason).toContain('gas: 30.0 gwei');
    expect(result.reason).toContain('adjustment: +15.0 bps');
  });

  it('fails when spread below gas-adjusted threshold on mainnet', () => {
    const result = gasAdjustedThresholdFilter({
      spreadBps: 20,
      minSpreadBps: 10,
      chain: 'mainnet',
      gasGwei: 30,
      gasBpsPerGwei: 0.5,
      defaultGasGwei: 50,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('gas_adjusted_threshold_not_met');
    expect(result.reason).toContain('20.0 < 25.0');
  });

  it('uses default gas when gasGwei is undefined', () => {
    const result = gasAdjustedThresholdFilter({
      spreadBps: 40,
      minSpreadBps: 10,
      chain: 'mainnet',
      gasGwei: undefined,
      gasBpsPerGwei: 0.5,
      defaultGasGwei: 50,
    });
    expect(result.passed).toBe(true);
    expect(result.reason).toContain('gas: 50.0 gwei');
    expect(result.reason).toContain('adjustment: +25.0 bps');
  });

  it('calculates adjustment correctly at high gas (100 gwei)', () => {
    const result = gasAdjustedThresholdFilter({
      spreadBps: 60,
      minSpreadBps: 10,
      chain: 'mainnet',
      gasGwei: 100,
      gasBpsPerGwei: 0.5,
      defaultGasGwei: 50,
    });
    expect(result.passed).toBe(true);
    expect(result.reason).toContain('adjustment: +50.0 bps');
  });

  it('handles negative spread correctly', () => {
    const result = gasAdjustedThresholdFilter({
      spreadBps: -40,
      minSpreadBps: 10,
      chain: 'mainnet',
      gasGwei: 30,
      gasBpsPerGwei: 0.5,
      defaultGasGwei: 50,
    });
    expect(result.passed).toBe(true);
  });

  it('fails when negative spread below gas-adjusted threshold', () => {
    const result = gasAdjustedThresholdFilter({
      spreadBps: -20,
      minSpreadBps: 10,
      chain: 'mainnet',
      gasGwei: 30,
      gasBpsPerGwei: 0.5,
      defaultGasGwei: 50,
    });
    expect(result.passed).toBe(false);
  });
});
