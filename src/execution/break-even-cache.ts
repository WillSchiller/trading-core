import { createChildLogger, type Logger } from '../utils/logger.js';

export type SizeBucket = 100 | 500 | 1000;

export interface BreakEvenEntry {
  feeTierBps: number;
  typicalSlippageBps: number;
  typicalGasBps: number;
  breakEvenBps: number;
  computedAt: number;
}

export interface BreakEvenCacheConfig {
  ttlMs?: number;
}

export class BreakEvenCache {
  private logger: Logger;
  private cache: Map<string, BreakEvenEntry> = new Map();
  private ttlMs: number;
  private hits = 0;
  private misses = 0;

  constructor(config: BreakEvenCacheConfig = {}) {
    this.logger = createChildLogger({ component: 'break-even-cache' });
    this.ttlMs = config.ttlMs ?? 30000;
  }

  private makeKey(pair: string, sizeBucket: SizeBucket): string {
    return `${pair}:${sizeBucket}`;
  }

  get(pair: string, sizeBucket: SizeBucket): BreakEvenEntry | null {
    const key = this.makeKey(pair, sizeBucket);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    const age = Date.now() - entry.computedAt;
    if (age > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry;
  }

  refresh(
    pair: string,
    sizeBucket: SizeBucket,
    feeTierBps: number,
    gasBps: number,
    slippageBps: number
  ): void {
    const key = this.makeKey(pair, sizeBucket);
    const breakEvenBps = feeTierBps + Math.abs(slippageBps) + gasBps;

    const entry: BreakEvenEntry = {
      feeTierBps,
      typicalSlippageBps: Math.abs(slippageBps),
      typicalGasBps: gasBps,
      breakEvenBps,
      computedAt: Date.now(),
    };

    this.cache.set(key, entry);

    this.logger.debug(
      { pair, sizeBucket, breakEvenBps, feeTierBps, gasBps, slippageBps: Math.abs(slippageBps) },
      'Break-even cache refreshed'
    );
  }

  getSizeBucket(tradeSizeUsd: number): SizeBucket {
    if (tradeSizeUsd <= 100) return 100;
    if (tradeSizeUsd <= 500) return 500;
    return 1000;
  }

  getStats(): { hits: number; misses: number; hitRate: number; size: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: this.cache.size,
    };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
