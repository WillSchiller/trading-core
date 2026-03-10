import type { Pool } from 'pg';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';

export interface ConnectorHealthUpdate {
  venueId: number;
  chain?: Chain;
  lastQuoteAt?: Date;
  lastBlock?: bigint;
  wsConnected?: boolean;
  reconnectCount?: number;
  errorCount?: number;
  lastLatencyMs?: number;
  p95LatencyMs?: number;
  invalidTsCount?: number;
  futureTsCount?: number;
}

const FLUSH_INTERVAL_MS = 30_000;

export class HealthPersistence {
  private logger: Logger;
  private pool: Pool;
  private pending: Map<string, ConnectorHealthUpdate> = new Map();
  private pendingIncrements: Map<string, { reconnect: number; error: number; invalidTs: number; futureTs: number }> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
    this.logger = createChildLogger({ component: 'health-persistence' });
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  private key(venueId: number, chain?: Chain): string {
    return `${venueId}:${chain || 'null'}`;
  }

  private getIncrements(k: string) {
    let inc = this.pendingIncrements.get(k);
    if (!inc) {
      inc = { reconnect: 0, error: 0, invalidTs: 0, futureTs: 0 };
      this.pendingIncrements.set(k, inc);
    }
    return inc;
  }

  private async flush(): Promise<void> {
    if (this.pending.size === 0 && this.pendingIncrements.size === 0) return;

    const updates = new Map(this.pending);
    const increments = new Map(this.pendingIncrements);
    this.pending.clear();
    this.pendingIncrements.clear();

    for (const [, update] of updates) {
      try {
        await this.writeUpdate(update);
      } catch (error) {
        this.logger.error({ error: (error as Error).message, venueId: update.venueId }, 'Failed to flush health update');
      }
    }

    for (const [k, inc] of increments) {
      if (inc.reconnect === 0 && inc.error === 0 && inc.invalidTs === 0 && inc.futureTs === 0) continue;
      const [venueId, chain] = k.split(':');
      try {
        await this.pool.query(
          `UPDATE connector_health
           SET reconnect_count = reconnect_count + $1,
               error_count = error_count + $2,
               invalid_ts_count = invalid_ts_count + $3,
               future_ts_count = future_ts_count + $4,
               updated_at = NOW()
           WHERE venue_id = $5 AND (chain = $6 OR ($6 IS NULL AND chain IS NULL))`,
          [inc.reconnect, inc.error, inc.invalidTs, inc.futureTs, parseInt(venueId), chain === 'null' ? null : chain]
        );
      } catch (error) {
        this.logger.error({ error: (error as Error).message, venueId }, 'Failed to flush health increments');
      }
    }
  }

  private async writeUpdate(update: ConnectorHealthUpdate): Promise<void> {
    const chain = update.chain || null;

    const existsResult = await this.pool.query(
      `SELECT id FROM connector_health
       WHERE venue_id = $1 AND (chain = $2 OR ($2 IS NULL AND chain IS NULL))`,
      [update.venueId, chain]
    );

    if (existsResult.rows.length > 0) {
      const setFields: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (update.lastQuoteAt !== undefined) {
        setFields.push(`last_quote_at = $${paramIndex++}`);
        values.push(update.lastQuoteAt);
      }
      if (update.lastBlock !== undefined) {
        setFields.push(`last_block = $${paramIndex++}`);
        values.push(update.lastBlock.toString());
      }
      if (update.wsConnected !== undefined) {
        setFields.push(`ws_connected = $${paramIndex++}`);
        values.push(update.wsConnected);
      }
      if (update.lastLatencyMs !== undefined) {
        setFields.push(`last_latency_ms = $${paramIndex++}`);
        values.push(update.lastLatencyMs);
      }
      if (update.p95LatencyMs !== undefined) {
        setFields.push(`p95_latency_ms = $${paramIndex++}`);
        values.push(update.p95LatencyMs);
      }

      if (setFields.length === 0) return;

      setFields.push(`updated_at = $${paramIndex++}`);
      values.push(new Date());
      values.push(existsResult.rows[0].id);

      await this.pool.query(
        `UPDATE connector_health SET ${setFields.join(', ')} WHERE id = $${paramIndex}`,
        values
      );
    } else {
      await this.pool.query(
        `INSERT INTO connector_health (venue_id, chain, ws_connected, last_quote_at, last_block, reconnect_count, error_count, last_latency_ms, p95_latency_ms, invalid_ts_count, future_ts_count, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
        [
          update.venueId,
          chain,
          update.wsConnected ?? false,
          update.lastQuoteAt ?? null,
          update.lastBlock?.toString() ?? null,
          0,
          0,
          update.lastLatencyMs ?? null,
          update.p95LatencyMs ?? null,
          0,
          0,
        ]
      );
    }
  }

  public async upsertConnectorHealth(update: ConnectorHealthUpdate): Promise<void> {
    const k = this.key(update.venueId, update.chain);
    const existing = this.pending.get(k);
    if (existing) {
      // Merge: newer values overwrite
      if (update.lastQuoteAt !== undefined) existing.lastQuoteAt = update.lastQuoteAt;
      if (update.lastBlock !== undefined) existing.lastBlock = update.lastBlock;
      if (update.wsConnected !== undefined) existing.wsConnected = update.wsConnected;
      if (update.lastLatencyMs !== undefined) existing.lastLatencyMs = update.lastLatencyMs;
      if (update.p95LatencyMs !== undefined) existing.p95LatencyMs = update.p95LatencyMs;
    } else {
      this.pending.set(k, { ...update });
    }
  }

  public async markConnectorConnected(venueId: number, chain?: Chain): Promise<void> {
    await this.upsertConnectorHealth({ venueId, chain, wsConnected: true });
  }

  public async markConnectorDisconnected(venueId: number, chain?: Chain): Promise<void> {
    await this.upsertConnectorHealth({ venueId, chain, wsConnected: false });
  }

  public async incrementReconnectCount(venueId: number, chain?: Chain): Promise<void> {
    this.getIncrements(this.key(venueId, chain)).reconnect++;
  }

  public async incrementErrorCount(venueId: number, chain?: Chain): Promise<void> {
    this.getIncrements(this.key(venueId, chain)).error++;
  }

  public async updateLastQuote(
    venueId: number,
    chain: Chain | undefined,
    blockNumber?: bigint,
    latencyMs?: number
  ): Promise<void> {
    await this.upsertConnectorHealth({
      venueId,
      chain,
      lastQuoteAt: new Date(),
      lastBlock: blockNumber,
      wsConnected: true,
      lastLatencyMs: latencyMs,
    });
  }

  public async updateLatencyMetrics(
    venueId: number,
    chain: Chain | undefined,
    latencyMs: number,
    p95LatencyMs?: number
  ): Promise<void> {
    await this.upsertConnectorHealth({
      venueId,
      chain,
      lastLatencyMs: latencyMs,
      p95LatencyMs,
    });
  }

  public async incrementInvalidTsCount(venueId: number, chain?: Chain): Promise<void> {
    this.getIncrements(this.key(venueId, chain)).invalidTs++;
  }

  public async incrementFutureTsCount(venueId: number, chain?: Chain): Promise<void> {
    this.getIncrements(this.key(venueId, chain)).futureTs++;
  }

  public async getConnectorHealth(venueId: number, chain?: Chain) {
    try {
      const result = await this.pool.query(
        `SELECT * FROM connector_health
         WHERE venue_id = $1 AND (chain = $2 OR ($2 IS NULL AND chain IS NULL))`,
        [venueId, chain || null]
      );
      return result.rows[0] || null;
    } catch (error) {
      this.logger.error({ error: (error as Error).message, venueId, chain }, 'Failed to get connector health');
      return null;
    }
  }

  public async getAllConnectorHealth() {
    try {
      const result = await this.pool.query(
        `SELECT ch.*, v.name as venue_name
         FROM connector_health ch
         JOIN venues v ON ch.venue_id = v.id
         ORDER BY v.name, ch.chain`
      );
      return result.rows;
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Failed to get all connector health');
      return [];
    }
  }

  public async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
