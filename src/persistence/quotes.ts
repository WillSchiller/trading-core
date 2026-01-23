import type { Pool } from 'pg';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { NormalizedQuote, RollupInterval } from '../types/index.js';

export interface QuotePersistenceConfig {
  sampleRate: number;
  rollupIntervals: RollupInterval[];
}

interface RollupData {
  intervalType: RollupInterval;
  intervalStart: Date;
  venueId: number;
  pairId: number;
  chain: string | null;
  openMid: number;
  highMid: number;
  lowMid: number;
  closeMid: number;
  sampleCount: number;
}

export class QuotePersistence {
  private logger: Logger;
  private pool: Pool;
  private config: QuotePersistenceConfig;
  private sampleCounter = 0;
  private rollupTimers: Map<RollupInterval, NodeJS.Timeout>;
  private rollupBuffers: Map<string, number[]>;

  constructor(pool: Pool, config: QuotePersistenceConfig) {
    this.pool = pool;
    this.config = config;
    this.logger = createChildLogger({ component: 'quote-persistence' });
    this.rollupTimers = new Map();
    this.rollupBuffers = new Map();
  }

  public async insertRawQuote(quote: NormalizedQuote, venueId: number, pairId: number): Promise<void> {
    this.sampleCounter++;

    const shouldSample = this.sampleCounter % this.config.sampleRate === 0;

    if (!shouldSample) {
      this.bufferForRollup(quote, venueId, pairId);
      return;
    }

    try {
      await this.pool.query(
        `INSERT INTO quotes_raw (
          ts, received_at, venue_id, pair_id, chain,
          bid, ask, mid, block_number, sqrt_price_x96, liquidity, latency_ms, is_stale,
          exchange_ts_ms, received_ts_ms, block_ts_ms
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          quote.ts,
          new Date(),
          venueId,
          pairId,
          quote.chain || null,
          quote.bid || null,
          quote.ask || null,
          quote.mid,
          quote.blockNumber ? quote.blockNumber.toString() : null,
          quote.sqrtPriceX96 ? quote.sqrtPriceX96.toString() : null,
          quote.liquidity ? quote.liquidity.toString() : null,
          quote.latencyMs,
          false,
          quote.exchangeTsMs ?? null,
          quote.receivedTsMs,
          quote.blockTsMs ?? null,
        ]
      );

      this.bufferForRollup(quote, venueId, pairId);

      this.logger.debug(
        {
          venue: quote.venue,
          pair: quote.pair,
          mid: quote.mid,
        },
        'Raw quote inserted'
      );
    } catch (error) {
      this.logger.error(
        {
          error: (error as Error).message,
          venue: quote.venue,
          pair: quote.pair,
        },
        'Failed to insert raw quote'
      );
    }
  }

  public startRollups(): void {
    for (const interval of this.config.rollupIntervals) {
      const intervalMs = this.parseInterval(interval);
      this.logger.info({ interval, intervalMs }, 'Starting rollup timer');

      const timer = setInterval(() => {
        this.performRollup(interval).catch((error) => {
          this.logger.error({ error: error.message, interval }, 'Rollup failed');
        });
      }, intervalMs);

      this.rollupTimers.set(interval, timer);
    }
  }

  public stopRollups(): void {
    for (const [interval, timer] of this.rollupTimers.entries()) {
      clearInterval(timer);
      this.logger.info({ interval }, 'Stopped rollup timer');
    }
    this.rollupTimers.clear();
  }

  private async performRollup(interval: RollupInterval): Promise<void> {
    const intervalMs = this.parseInterval(interval);
    const now = new Date();
    const intervalStart = this.getIntervalStart(now, intervalMs);

    this.logger.debug({ interval, intervalStart }, 'Performing rollup');

    try {
      const result = await this.pool.query<RollupData>(
        `INSERT INTO quote_rollups (
          interval_type, interval_start, venue_id, pair_id, chain,
          open_mid, high_mid, low_mid, close_mid, sample_count
        )
        SELECT
          $1 as interval_type,
          $2 as interval_start,
          venue_id,
          pair_id,
          chain,
          (ARRAY_AGG(mid ORDER BY ts ASC))[1] as open_mid,
          MAX(mid) as high_mid,
          MIN(mid) as low_mid,
          (ARRAY_AGG(mid ORDER BY ts DESC))[1] as close_mid,
          COUNT(*) as sample_count
        FROM quotes_raw
        WHERE ts >= $2 AND ts < $3
        GROUP BY venue_id, pair_id, chain
        ON CONFLICT (interval_type, interval_start, venue_id, pair_id, chain)
        DO UPDATE SET
          open_mid = EXCLUDED.open_mid,
          high_mid = EXCLUDED.high_mid,
          low_mid = EXCLUDED.low_mid,
          close_mid = EXCLUDED.close_mid,
          sample_count = EXCLUDED.sample_count
        RETURNING *`,
        [interval, intervalStart, new Date(intervalStart.getTime() + intervalMs)]
      );

      this.logger.debug(
        { interval, intervalStart, rowCount: result.rowCount },
        'Rollup completed'
      );
    } catch (error) {
      this.logger.error({ error: (error as Error).message, interval }, 'Failed to perform rollup');
    }
  }

  private bufferForRollup(quote: NormalizedQuote, venueId: number, pairId: number): void {
    const key = `${venueId}:${pairId}:${quote.chain || 'null'}`;
    if (!this.rollupBuffers.has(key)) {
      this.rollupBuffers.set(key, []);
    }
    this.rollupBuffers.get(key)!.push(quote.mid);
  }

  private parseInterval(interval: RollupInterval): number {
    switch (interval) {
      case '1s':
        return 1000;
      case '10s':
        return 10000;
      case '1m':
        return 60000;
      default:
        throw new Error(`Unknown interval: ${interval}`);
    }
  }

  private getIntervalStart(date: Date, intervalMs: number): Date {
    const timestamp = date.getTime();
    const intervalStart = Math.floor(timestamp / intervalMs) * intervalMs;
    return new Date(intervalStart);
  }
}
