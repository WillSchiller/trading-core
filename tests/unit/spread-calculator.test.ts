import { describe, it, expect } from 'vitest';
import {
  calculateSpread,
  calculateSpreadBps,
  determineDirection,
  type SpreadCalculationInput,
} from '../../src/detection/spread-calculator.js';
import type { NormalizedQuote } from '../../src/types/index.js';

function createMockQuote(venue: string, pair: string, mid: number): NormalizedQuote {
  return {
    ts: new Date(),
    venue,
    pair,
    mid,
    latencyMs: 10,
  };
}

describe('calculateSpreadBps', () => {
  it('returns positive bps when DEX > CEX', () => {
    const spread = calculateSpreadBps({ cexMid: 1000, dexMid: 1010 });
    expect(spread).toBeCloseTo(100, 1);
  });

  it('returns negative bps when DEX < CEX', () => {
    const spread = calculateSpreadBps({ cexMid: 1000, dexMid: 990 });
    expect(spread).toBeCloseTo(-100, 1);
  });

  it('returns zero bps when prices are equal', () => {
    const spread = calculateSpreadBps({ cexMid: 1000, dexMid: 1000 });
    expect(spread).toBe(0);
  });

  it('handles small spreads accurately', () => {
    const spread = calculateSpreadBps({ cexMid: 1000, dexMid: 1000.5 });
    expect(spread).toBeCloseTo(5, 1);
  });

  it('handles large spreads', () => {
    const spread = calculateSpreadBps({ cexMid: 1000, dexMid: 1100 });
    expect(spread).toBeCloseTo(1000, 1);
  });
});

describe('determineDirection', () => {
  it('returns buy_dex when spreadBps is negative', () => {
    expect(determineDirection(-50)).toBe('buy_dex');
  });

  it('returns sell_dex when spreadBps is positive', () => {
    expect(determineDirection(50)).toBe('sell_dex');
  });

  it('returns sell_dex when spreadBps is zero', () => {
    expect(determineDirection(0)).toBe('sell_dex');
  });
});

describe('calculateSpread', () => {
  it('calculates spread correctly with anchor and dex only', () => {
    const input: SpreadCalculationInput = {
      anchorQuote: createMockQuote('binance', 'WETH/USDC', 2000),
      dexQuote: createMockQuote('uniswap_v3', 'WETH/USDC', 2020),
    };

    const result = calculateSpread(input);

    expect(result.spreadBps).toBeCloseTo(100, 1);
    expect(result.direction).toBe('sell_dex');
    expect(result.anchorMid).toBe(2000);
    expect(result.dexMid).toBe(2020);
    expect(result.confidence).toBe('high');
    expect(result.confirmMid).toBeUndefined();
    expect(result.anchorDivergenceBps).toBeUndefined();
  });

  it('calculates spread with confirmation venue', () => {
    const input: SpreadCalculationInput = {
      anchorQuote: createMockQuote('binance', 'WETH/USDC', 2000),
      confirmQuote: createMockQuote('coinbase', 'WETH/USDC', 2001),
      dexQuote: createMockQuote('uniswap_v3', 'WETH/USDC', 1980),
    };

    const result = calculateSpread(input);

    expect(result.spreadBps).toBeCloseTo(-100, 1);
    expect(result.direction).toBe('buy_dex');
    expect(result.anchorMid).toBe(2000);
    expect(result.confirmMid).toBe(2001);
    expect(result.dexMid).toBe(1980);
    expect(result.confidence).toBe('high');
    expect(result.anchorDivergenceBps).toBeCloseTo(5, 1);
  });

  it('downgrades confidence when anchors diverge moderately', () => {
    const input: SpreadCalculationInput = {
      anchorQuote: createMockQuote('binance', 'WETH/USDC', 2000),
      confirmQuote: createMockQuote('coinbase', 'WETH/USDC', 2007),
      dexQuote: createMockQuote('uniswap_v3', 'WETH/USDC', 1980),
    };

    const result = calculateSpread(input);

    expect(result.confidence).toBe('low');
    expect(result.anchorDivergenceBps).toBeCloseTo(35, 0);
  });

  it('sets low confidence when anchors diverge significantly', () => {
    const input: SpreadCalculationInput = {
      anchorQuote: createMockQuote('binance', 'WETH/USDC', 2000),
      confirmQuote: createMockQuote('coinbase', 'WETH/USDC', 2025),
      dexQuote: createMockQuote('uniswap_v3', 'WETH/USDC', 1980),
    };

    const result = calculateSpread(input);

    expect(result.confidence).toBe('low');
    expect(result.anchorDivergenceBps).toBeCloseTo(125, 0);
  });

  it('handles DEX cheaper than CEX correctly', () => {
    const input: SpreadCalculationInput = {
      anchorQuote: createMockQuote('binance', 'WETH/USDC', 2000),
      dexQuote: createMockQuote('uniswap_v3', 'WETH/USDC', 1950),
    };

    const result = calculateSpread(input);

    expect(result.spreadBps).toBeCloseTo(-250, 1);
    expect(result.direction).toBe('buy_dex');
  });

  it('handles very small spreads', () => {
    const input: SpreadCalculationInput = {
      anchorQuote: createMockQuote('binance', 'WETH/USDC', 2000),
      dexQuote: createMockQuote('uniswap_v3', 'WETH/USDC', 2000.2),
    };

    const result = calculateSpread(input);

    expect(result.spreadBps).toBeCloseTo(1, 1);
    expect(result.direction).toBe('sell_dex');
  });

  it('uses Decimal.js for precision', () => {
    const input: SpreadCalculationInput = {
      anchorQuote: createMockQuote('binance', 'WETH/USDC', 1234.567891),
      dexQuote: createMockQuote('uniswap_v3', 'WETH/USDC', 1235.678901),
    };

    const result = calculateSpread(input);

    expect(result.spreadBps).toBeCloseTo(9, 0);
  });
});
