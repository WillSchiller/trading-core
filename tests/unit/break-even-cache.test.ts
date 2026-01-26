import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BreakEvenCache } from '../../src/execution/break-even-cache.js';

describe('BreakEvenCache', () => {
  let cache: BreakEvenCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new BreakEvenCache({ ttlMs: 30000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getSizeBucket', () => {
    it('returns 100 for trade sizes <= 100', () => {
      expect(cache.getSizeBucket(50)).toBe(100);
      expect(cache.getSizeBucket(100)).toBe(100);
    });

    it('returns 500 for trade sizes > 100 and <= 500', () => {
      expect(cache.getSizeBucket(101)).toBe(500);
      expect(cache.getSizeBucket(300)).toBe(500);
      expect(cache.getSizeBucket(500)).toBe(500);
    });

    it('returns 1000 for trade sizes > 500', () => {
      expect(cache.getSizeBucket(501)).toBe(1000);
      expect(cache.getSizeBucket(1000)).toBe(1000);
      expect(cache.getSizeBucket(5000)).toBe(1000);
    });
  });

  describe('get/refresh', () => {
    it('returns null for cache miss', () => {
      const result = cache.get('WETH/USDC', 500);
      expect(result).toBeNull();
    });

    it('returns cached value after refresh', () => {
      cache.refresh('WETH/USDC', 500, 30, 5, 2);

      const result = cache.get('WETH/USDC', 500);
      expect(result).not.toBeNull();
      expect(result!.feeTierBps).toBe(30);
      expect(result!.typicalGasBps).toBe(5);
      expect(result!.typicalSlippageBps).toBe(2);
      expect(result!.breakEvenBps).toBe(37);
    });

    it('computes breakEvenBps as feeTierBps + |slippageBps| + gasBps', () => {
      cache.refresh('WETH/USDC', 500, 30, 5, -3);

      const result = cache.get('WETH/USDC', 500);
      expect(result!.breakEvenBps).toBe(38);
    });

    it('returns null after TTL expires', () => {
      cache.refresh('WETH/USDC', 500, 30, 5, 2);

      vi.advanceTimersByTime(31000);

      const result = cache.get('WETH/USDC', 500);
      expect(result).toBeNull();
    });

    it('returns cached value before TTL expires', () => {
      cache.refresh('WETH/USDC', 500, 30, 5, 2);

      vi.advanceTimersByTime(29000);

      const result = cache.get('WETH/USDC', 500);
      expect(result).not.toBeNull();
    });

    it('uses different cache keys for different pairs', () => {
      cache.refresh('WETH/USDC', 500, 30, 5, 2);
      cache.refresh('WBTC/USDC', 500, 30, 10, 5);

      const wethResult = cache.get('WETH/USDC', 500);
      const wbtcResult = cache.get('WBTC/USDC', 500);

      expect(wethResult!.typicalGasBps).toBe(5);
      expect(wbtcResult!.typicalGasBps).toBe(10);
    });

    it('uses different cache keys for different size buckets', () => {
      cache.refresh('WETH/USDC', 100, 30, 10, 2);
      cache.refresh('WETH/USDC', 500, 30, 5, 2);

      const small = cache.get('WETH/USDC', 100);
      const medium = cache.get('WETH/USDC', 500);
      const large = cache.get('WETH/USDC', 1000);

      expect(small!.typicalGasBps).toBe(10);
      expect(medium!.typicalGasBps).toBe(5);
      expect(large).toBeNull();
    });
  });

  describe('getStats', () => {
    it('tracks hits and misses', () => {
      cache.get('WETH/USDC', 500);
      cache.refresh('WETH/USDC', 500, 30, 5, 2);
      cache.get('WETH/USDC', 500);
      cache.get('WETH/USDC', 500);
      cache.get('WBTC/USDC', 500);

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBe(0.5);
      expect(stats.size).toBe(1);
    });

    it('returns 0 hit rate when no accesses', () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('clear', () => {
    it('clears cache and resets stats', () => {
      cache.refresh('WETH/USDC', 500, 30, 5, 2);
      cache.get('WETH/USDC', 500);

      cache.clear();

      expect(cache.get('WETH/USDC', 500)).toBeNull();
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(1);
      expect(stats.size).toBe(0);
    });
  });
});
