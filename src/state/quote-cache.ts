import { createChildLogger, type Logger } from '../utils/logger.js';
import type { NormalizedQuote, QuoteWithStaleness, Chain, QuoteQuality } from '../types/index.js';
import { validateTimestamps } from '../utils/clock.js';

interface CacheKey {
  venue: string;
  pair: string;
  chain?: Chain;
}

interface CacheEntry {
  quote: NormalizedQuote;
  receivedAt: Date;
  isValidTs: boolean;
  invalidTsReason?: string;
  isThinMarket?: boolean;
  quality?: QuoteQuality;
}

export interface ThinMarketConfig {
  pair: string;
  maxQuoteAgeMs: number;
}

export interface QuoteCacheConfig {
  cexStaleThresholdMs: number;
  dexBlockLagThreshold: number;
  maxFutureTsMs?: number;
  maxPastTsMs?: number;
  thinMarketPairs?: ThinMarketConfig[];
}

export interface QuoteCacheStats {
  totalQuotes: number;
  freshQuotes: number;
  staleQuotes: number;
  invalidTsQuotes: number;
  byVenue: Record<string, { total: number; fresh: number; stale: number; invalidTs: number }>;
}

export class QuoteCache {
  private logger: Logger;
  private cache: Map<string, CacheEntry>;
  private config: Required<Omit<QuoteCacheConfig, 'thinMarketPairs'>> & { thinMarketPairs: ThinMarketConfig[] };
  private currentBlocks: Map<Chain, bigint>;
  private blockTimestamps: Map<string, number>;
  private thinMarketMap: Map<string, number>;

  constructor(config: QuoteCacheConfig) {
    this.logger = createChildLogger({ component: 'quote-cache' });
    this.cache = new Map();
    this.config = {
      ...config,
      maxFutureTsMs: config.maxFutureTsMs ?? 500,
      maxPastTsMs: config.maxPastTsMs ?? 30000,
      thinMarketPairs: config.thinMarketPairs ?? [],
    };
    this.currentBlocks = new Map();
    this.blockTimestamps = new Map();
    this.thinMarketMap = new Map(
      this.config.thinMarketPairs.map(p => [p.pair, p.maxQuoteAgeMs])
    );
  }

  public addThinMarketPair(pair: string, maxQuoteAgeMs: number): void {
    this.thinMarketMap.set(pair, maxQuoteAgeMs);
    this.logger.info({ pair, maxQuoteAgeMs }, 'Added thin market pair');
  }

  public updateQuote(quote: NormalizedQuote): void {
    const key = this.buildKey({
      venue: quote.venue,
      pair: quote.pair,
      chain: quote.chain,
    });

    let isValidTs = true;
    let invalidTsReason: string | undefined;
    let isThinMarket = false;
    let quality: QuoteQuality = 'fresh';

    const thinMarketMaxAge = this.thinMarketMap.get(quote.pair);

    if (quote.exchangeTsMs !== undefined) {
      const validation = validateTimestamps(
        quote.exchangeTsMs,
        quote.receivedTsMs,
        this.config.maxFutureTsMs,
        this.config.maxPastTsMs
      );

      if (!validation.isValid) {
        if (thinMarketMaxAge !== undefined) {
          const age = quote.receivedTsMs - quote.exchangeTsMs;
          if (age <= thinMarketMaxAge && age > 0) {
            isValidTs = true;
            isThinMarket = true;
            quality = 'thin_market_ok';
            this.logger.debug(
              {
                venue: quote.venue,
                pair: quote.pair,
                ageMs: age,
                maxAgeMs: thinMarketMaxAge,
              },
              'Thin market quote accepted'
            );
          } else {
            isValidTs = false;
            invalidTsReason = validation.reason;
            quality = 'stale_reject';
          }
        } else {
          isValidTs = false;
          invalidTsReason = validation.reason;
          quality = 'stale_reject';

          this.logger.warn(
            {
              venue: quote.venue,
              pair: quote.pair,
              exchangeTsMs: quote.exchangeTsMs,
              receivedTsMs: quote.receivedTsMs,
              reason: invalidTsReason,
            },
            'Invalid timestamp detected'
          );
        }
      }
    }

    this.cache.set(key, {
      quote,
      receivedAt: new Date(),
      isValidTs,
      invalidTsReason,
      isThinMarket,
      quality,
    });

    this.logger.debug(
      {
        venue: quote.venue,
        pair: quote.pair,
        chain: quote.chain,
        mid: quote.mid,
        latencyMs: quote.latencyMs,
        isValidTs,
        isThinMarket,
        quality,
      },
      'Quote updated'
    );
  }

  public updateCurrentBlock(chain: Chain, blockNumber: bigint, timestamp?: number): void {
    this.currentBlocks.set(chain, blockNumber);
    if (timestamp !== undefined) {
      const key = `${chain}:${blockNumber.toString()}`;
      this.blockTimestamps.set(key, timestamp);

      if (this.blockTimestamps.size > 100) {
        const firstKey = this.blockTimestamps.keys().next().value;
        if (firstKey) {
          this.blockTimestamps.delete(firstKey);
        }
      }
    }
    this.logger.debug(
      { chain, blockNumber: blockNumber.toString(), timestamp },
      'Current block updated'
    );
  }

  public getBlockTimestamp(chain: Chain, blockNumber: bigint): number | undefined {
    const key = `${chain}:${blockNumber.toString()}`;
    return this.blockTimestamps.get(key);
  }

  public getQuote(key: CacheKey): NormalizedQuote | null {
    const cacheKey = this.buildKey(key);
    const entry = this.cache.get(cacheKey);
    return entry ? entry.quote : null;
  }

  public getQuoteWithStaleness(key: CacheKey): QuoteWithStaleness | null {
    const cacheKey = this.buildKey(key);
    const entry = this.cache.get(cacheKey);

    if (!entry) {
      return null;
    }

    const staleness = this.checkStaleness(entry);

    return {
      quote: entry.quote,
      ...staleness,
      quality: entry.quality,
      isThinMarket: entry.isThinMarket,
    };
  }

  public getLatestQuotes(): QuoteWithStaleness[] {
    const quotes: QuoteWithStaleness[] = [];

    for (const entry of this.cache.values()) {
      const staleness = this.checkStaleness(entry);
      quotes.push({
        quote: entry.quote,
        ...staleness,
        quality: entry.quality,
        isThinMarket: entry.isThinMarket,
      });
    }

    return quotes;
  }

  public getLatestQuotesByPair(pair: string): QuoteWithStaleness[] {
    const quotes: QuoteWithStaleness[] = [];

    for (const entry of this.cache.values()) {
      if (entry.quote.pair === pair) {
        const staleness = this.checkStaleness(entry);
        quotes.push({
          quote: entry.quote,
          ...staleness,
          quality: entry.quality,
          isThinMarket: entry.isThinMarket,
        });
      }
    }

    return quotes;
  }

  public getLatestQuotesByVenue(venue: string): QuoteWithStaleness[] {
    const quotes: QuoteWithStaleness[] = [];

    for (const entry of this.cache.values()) {
      if (entry.quote.venue === venue) {
        const staleness = this.checkStaleness(entry);
        quotes.push({
          quote: entry.quote,
          ...staleness,
          quality: entry.quality,
          isThinMarket: entry.isThinMarket,
        });
      }
    }

    return quotes;
  }

  public getFreshQuotes(): NormalizedQuote[] {
    const quotes: NormalizedQuote[] = [];

    for (const entry of this.cache.values()) {
      const staleness = this.checkStaleness(entry);
      if (!staleness.isStale) {
        quotes.push(entry.quote);
      }
    }

    return quotes;
  }

  public getFreshQuotesByPair(pair: string): NormalizedQuote[] {
    const quotes: NormalizedQuote[] = [];

    for (const entry of this.cache.values()) {
      if (entry.quote.pair === pair) {
        const staleness = this.checkStaleness(entry);
        if (!staleness.isStale) {
          quotes.push(entry.quote);
        }
      }
    }

    return quotes;
  }

  public clear(): void {
    this.cache.clear();
    this.logger.info('Cache cleared');
  }

  public size(): number {
    return this.cache.size;
  }

  public getStats(): QuoteCacheStats {
    const stats: QuoteCacheStats = {
      totalQuotes: this.cache.size,
      freshQuotes: 0,
      staleQuotes: 0,
      invalidTsQuotes: 0,
      byVenue: {},
    };

    for (const entry of this.cache.values()) {
      const staleness = this.checkStaleness(entry);
      const venue = entry.quote.venue;

      if (!stats.byVenue[venue]) {
        stats.byVenue[venue] = { total: 0, fresh: 0, stale: 0, invalidTs: 0 };
      }

      stats.byVenue[venue].total++;

      if (!entry.isValidTs) {
        stats.invalidTsQuotes++;
        stats.byVenue[venue].invalidTs++;
      }

      if (staleness.isStale) {
        stats.staleQuotes++;
        stats.byVenue[venue].stale++;
      } else {
        stats.freshQuotes++;
        stats.byVenue[venue].fresh++;
      }
    }

    return stats;
  }

  private checkStaleness(entry: CacheEntry): {
    isStale: boolean;
    staleReason?: 'age' | 'disconnect' | 'block_lag' | 'invalid_timestamp';
    staleDurationMs?: number;
  } {
    if (!entry.isValidTs) {
      return {
        isStale: true,
        staleReason: 'invalid_timestamp',
        staleDurationMs: 0,
      };
    }

    const now = Date.now();
    const age = now - entry.receivedAt.getTime();

    if (entry.quote.chain && entry.quote.blockNumber !== undefined) {
      const currentBlock = this.currentBlocks.get(entry.quote.chain);
      if (currentBlock !== undefined) {
        const blockLag = currentBlock - entry.quote.blockNumber;
        if (blockLag > BigInt(this.config.dexBlockLagThreshold)) {
          return {
            isStale: true,
            staleReason: 'block_lag',
            staleDurationMs: age,
          };
        }
      }
    } else {
      if (age > this.config.cexStaleThresholdMs) {
        return {
          isStale: true,
          staleReason: 'age',
          staleDurationMs: age,
        };
      }
    }

    return { isStale: false };
  }

  private buildKey(key: CacheKey): string {
    const parts = [key.venue, key.pair];
    if (key.chain) {
      parts.push(key.chain);
    }
    return parts.join(':');
  }
}
