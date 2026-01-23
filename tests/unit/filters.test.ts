import { describe, it, expect, beforeEach } from 'vitest';
import {
  thresholdFilter,
  durationFilter,
  depthFilter,
  stalenessFilter,
  volatilityFilter,
  anchorConfidenceFilter,
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
