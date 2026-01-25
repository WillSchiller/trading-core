import { describe, it, expect, beforeEach } from 'vitest';
import { PoolStateTracker } from '../../src/chain/pool-state-tracker.js';
import type { Address } from 'viem';

describe('PoolStateTracker', () => {
  const testPools: Address[] = [
    '0xd0b53D9277642d899DF5C87A3966A349A798F224' as Address,
    '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18' as Address,
  ];

  let tracker: PoolStateTracker;

  beforeEach(() => {
    tracker = new PoolStateTracker({
      chain: 'base',
      initialPools: testPools,
    });
  });

  describe('initialization', () => {
    it('initializes all pools as dirty', () => {
      for (const pool of testPools) {
        expect(tracker.isDirty(pool)).toBe(true);
      }
    });

    it('returns correct initial stats', () => {
      const stats = tracker.getStats();
      expect(stats.totalPools).toBe(2);
      expect(stats.dirtyPools).toBe(2);
      expect(stats.cleanPools).toBe(0);
      expect(stats.totalEvents).toBe(0);
      expect(stats.totalFetches).toBe(0);
    });

    it('handles case-insensitive addresses', () => {
      const upperPool = testPools[0].toUpperCase() as Address;
      expect(tracker.isDirty(upperPool)).toBe(true);
    });
  });

  describe('markDirty', () => {
    it('marks a clean pool as dirty', () => {
      const pool = testPools[0];
      tracker.markClean(pool, 100n, 1234567890n);
      expect(tracker.isDirty(pool)).toBe(false);

      tracker.markDirty(pool, 101n);
      expect(tracker.isDirty(pool)).toBe(true);
    });

    it('increments event counter', () => {
      const pool = testPools[0];
      tracker.markDirty(pool, 100n);
      tracker.markDirty(pool, 101n);

      const state = tracker.getPoolState(pool);
      expect(state?.totalEvents).toBe(2);
    });

    it('updates last event block', () => {
      const pool = testPools[0];
      tracker.markDirty(pool, 100n);
      tracker.markDirty(pool, 105n);

      const state = tracker.getPoolState(pool);
      expect(state?.lastEventBlock).toBe(105n);
    });

    it('creates state for unknown pool', () => {
      const newPool = '0x1234567890123456789012345678901234567890' as Address;
      tracker.markDirty(newPool, 100n);

      expect(tracker.isDirty(newPool)).toBe(true);
      const stats = tracker.getStats();
      expect(stats.totalPools).toBe(3);
    });
  });

  describe('markClean', () => {
    it('marks a dirty pool as clean', () => {
      const pool = testPools[0];
      expect(tracker.isDirty(pool)).toBe(true);

      tracker.markClean(pool, 100n, 1234567890n);
      expect(tracker.isDirty(pool)).toBe(false);
    });

    it('updates pool state correctly', () => {
      const pool = testPools[0];
      const blockNumber = 100n;
      const sqrtPriceX96 = 1234567890n;

      tracker.markClean(pool, blockNumber, sqrtPriceX96);

      const state = tracker.getPoolState(pool);
      expect(state?.dirty).toBe(false);
      expect(state?.lastBlock).toBe(blockNumber);
      expect(state?.lastFetchBlock).toBe(blockNumber);
      expect(state?.lastSqrtPriceX96).toBe(sqrtPriceX96);
      expect(state?.totalFetches).toBe(1);
    });

    it('increments fetch counter', () => {
      const pool = testPools[0];
      tracker.markClean(pool, 100n, 1234567890n);
      tracker.markClean(pool, 101n, 1234567891n);

      const state = tracker.getPoolState(pool);
      expect(state?.totalFetches).toBe(2);
    });
  });

  describe('getDirtyPools / getCleanPools', () => {
    it('returns correct dirty pools', () => {
      tracker.markClean(testPools[0], 100n, 1234567890n);

      const dirty = tracker.getDirtyPools();
      expect(dirty).toHaveLength(1);
      expect(dirty[0].toLowerCase()).toBe(testPools[1].toLowerCase());
    });

    it('returns correct clean pools', () => {
      tracker.markClean(testPools[0], 100n, 1234567890n);

      const clean = tracker.getCleanPools();
      expect(clean).toHaveLength(1);
      expect(clean[0].toLowerCase()).toBe(testPools[0].toLowerCase());
    });

    it('handles all dirty', () => {
      const dirty = tracker.getDirtyPools();
      expect(dirty).toHaveLength(2);

      const clean = tracker.getCleanPools();
      expect(clean).toHaveLength(0);
    });

    it('handles all clean', () => {
      tracker.markClean(testPools[0], 100n, 1234567890n);
      tracker.markClean(testPools[1], 100n, 1234567890n);

      const dirty = tracker.getDirtyPools();
      expect(dirty).toHaveLength(0);

      const clean = tracker.getCleanPools();
      expect(clean).toHaveLength(2);
    });
  });

  describe('calculateSavedFetches', () => {
    it('calculates savings correctly', () => {
      const pool = testPools[0];

      tracker.markDirty(pool, 100n);
      tracker.markDirty(pool, 101n);
      tracker.markDirty(pool, 102n);
      tracker.markClean(pool, 102n, 1234567890n);

      const saved = tracker.calculateSavedFetches();
      expect(saved).toBe(2);
    });

    it('handles zero events', () => {
      const pool = testPools[0];
      tracker.markClean(pool, 100n, 1234567890n);

      const saved = tracker.calculateSavedFetches();
      expect(saved).toBe(-1);
    });

    it('calculates across multiple pools', () => {
      tracker.markDirty(testPools[0], 100n);
      tracker.markDirty(testPools[0], 101n);
      tracker.markClean(testPools[0], 101n, 1234567890n);

      tracker.markDirty(testPools[1], 100n);
      tracker.markDirty(testPools[1], 101n);
      tracker.markDirty(testPools[1], 102n);
      tracker.markClean(testPools[1], 102n, 1234567890n);

      const saved = tracker.calculateSavedFetches();
      expect(saved).toBe(3);
    });
  });

  describe('getStats', () => {
    it('returns comprehensive stats', () => {
      tracker.markDirty(testPools[0], 100n);
      tracker.markDirty(testPools[0], 101n);
      tracker.markClean(testPools[0], 101n, 1234567890n);

      tracker.markDirty(testPools[1], 100n);

      const stats = tracker.getStats();

      expect(stats.totalPools).toBe(2);
      expect(stats.dirtyPools).toBe(1);
      expect(stats.cleanPools).toBe(1);
      expect(stats.totalEvents).toBe(3);
      expect(stats.totalFetches).toBe(1);
      expect(stats.totalSavedFetches).toBe(2);
      expect(stats.savingsRate).toBeCloseTo(66.67, 1);
    });

    it('calculates 100% savings when no fetches', () => {
      tracker.markDirty(testPools[0], 100n);
      tracker.markDirty(testPools[0], 101n);

      const stats = tracker.getStats();
      expect(stats.savingsRate).toBe(100);
    });

    it('calculates 0% savings when events equal fetches', () => {
      tracker.markDirty(testPools[0], 100n);
      tracker.markClean(testPools[0], 100n, 1234567890n);

      const stats = tracker.getStats();
      expect(stats.savingsRate).toBe(0);
    });
  });

  describe('globalBlock tracking', () => {
    it('updates global last block', () => {
      expect(tracker.getGlobalLastBlock()).toBe(0n);

      tracker.updateGlobalBlock(100n);
      expect(tracker.getGlobalLastBlock()).toBe(100n);
    });

    it('only updates when newer', () => {
      tracker.updateGlobalBlock(100n);
      tracker.updateGlobalBlock(99n);
      expect(tracker.getGlobalLastBlock()).toBe(100n);
    });

    it('handles incremental updates', () => {
      tracker.updateGlobalBlock(100n);
      tracker.updateGlobalBlock(101n);
      tracker.updateGlobalBlock(102n);
      expect(tracker.getGlobalLastBlock()).toBe(102n);
    });
  });

  describe('resetStats', () => {
    it('resets all counters', () => {
      tracker.markDirty(testPools[0], 100n);
      tracker.markClean(testPools[0], 100n, 1234567890n);

      tracker.resetStats();

      const state = tracker.getPoolState(testPools[0]);
      expect(state?.totalEvents).toBe(0);
      expect(state?.totalFetches).toBe(0);
      expect(state?.savedFetches).toBe(0);
    });

    it('preserves dirty/clean state', () => {
      tracker.markClean(testPools[0], 100n, 1234567890n);
      tracker.resetStats();

      expect(tracker.isDirty(testPools[0])).toBe(false);
    });
  });

  describe('event-driven simulation', () => {
    it('simulates realistic event pattern', () => {
      const pool = testPools[0];

      for (let block = 100n; block < 110n; block++) {
        if (block % 3n === 0n) {
          tracker.markDirty(pool, block);
        }
      }

      tracker.markClean(pool, 102n, 1234567890n);
      tracker.markClean(pool, 105n, 1234567891n);
      tracker.markClean(pool, 108n, 1234567892n);

      const stats = tracker.getStats();
      expect(stats.totalEvents).toBe(3);
      expect(stats.totalFetches).toBe(3);
      expect(stats.totalSavedFetches).toBe(0);
    });

    it('simulates quiet pool (no events)', () => {
      const pool = testPools[0];
      tracker.markClean(pool, 100n, 1234567890n);

      for (let i = 0; i < 10; i++) {
        tracker.updateGlobalBlock(BigInt(100 + i));
      }

      tracker.calculateSavedFetches();

      const state = tracker.getPoolState(pool);
      expect(state?.totalEvents).toBe(0);
      expect(state?.totalFetches).toBe(1);
      expect(state?.savedFetches).toBe(-1);
    });

    it('simulates active pool (many events)', () => {
      const pool = testPools[0];

      for (let block = 100n; block < 120n; block++) {
        tracker.markDirty(pool, block);
        if (block % 5n === 0n) {
          tracker.markClean(pool, block, BigInt(1234567890 + Number(block)));
        }
      }

      const stats = tracker.getStats();
      expect(stats.totalEvents).toBe(20);
      expect(stats.totalFetches).toBe(4);
      expect(stats.savingsRate).toBe(80);
    });
  });
});
