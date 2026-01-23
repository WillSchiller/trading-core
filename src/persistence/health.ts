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

export class HealthPersistence {
  private logger: Logger;
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
    this.logger = createChildLogger({ component: 'health-persistence' });
  }

  public async upsertConnectorHealth(update: ConnectorHealthUpdate): Promise<void> {
    try {
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

        if (update.reconnectCount !== undefined) {
          setFields.push(`reconnect_count = $${paramIndex++}`);
          values.push(update.reconnectCount);
        }

        if (update.errorCount !== undefined) {
          setFields.push(`error_count = $${paramIndex++}`);
          values.push(update.errorCount);
        }

        if (update.lastLatencyMs !== undefined) {
          setFields.push(`last_latency_ms = $${paramIndex++}`);
          values.push(update.lastLatencyMs);
        }

        if (update.p95LatencyMs !== undefined) {
          setFields.push(`p95_latency_ms = $${paramIndex++}`);
          values.push(update.p95LatencyMs);
        }

        if (update.invalidTsCount !== undefined) {
          setFields.push(`invalid_ts_count = $${paramIndex++}`);
          values.push(update.invalidTsCount);
        }

        if (update.futureTsCount !== undefined) {
          setFields.push(`future_ts_count = $${paramIndex++}`);
          values.push(update.futureTsCount);
        }

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
            update.reconnectCount ?? 0,
            update.errorCount ?? 0,
            update.lastLatencyMs ?? null,
            update.p95LatencyMs ?? null,
            update.invalidTsCount ?? 0,
            update.futureTsCount ?? 0,
          ]
        );
      }

      this.logger.debug({ venueId: update.venueId, chain: update.chain }, 'Connector health updated');
    } catch (error) {
      this.logger.error(
        {
          error: (error as Error).message,
          venueId: update.venueId,
          chain: update.chain,
        },
        'Failed to update connector health'
      );
    }
  }

  public async markConnectorConnected(venueId: number, chain?: Chain): Promise<void> {
    await this.upsertConnectorHealth({
      venueId,
      chain,
      wsConnected: true,
    });
  }

  public async markConnectorDisconnected(venueId: number, chain?: Chain): Promise<void> {
    await this.upsertConnectorHealth({
      venueId,
      chain,
      wsConnected: false,
    });
  }

  public async incrementReconnectCount(venueId: number, chain?: Chain): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE connector_health
         SET reconnect_count = reconnect_count + 1,
             updated_at = NOW()
         WHERE venue_id = $1 AND (chain = $2 OR ($2 IS NULL AND chain IS NULL))`,
        [venueId, chain || null]
      );

      this.logger.debug({ venueId, chain }, 'Incremented reconnect count');
    } catch (error) {
      this.logger.error(
        {
          error: (error as Error).message,
          venueId,
          chain,
        },
        'Failed to increment reconnect count'
      );
    }
  }

  public async incrementErrorCount(venueId: number, chain?: Chain): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE connector_health
         SET error_count = error_count + 1,
             updated_at = NOW()
         WHERE venue_id = $1 AND (chain = $2 OR ($2 IS NULL AND chain IS NULL))`,
        [venueId, chain || null]
      );

      this.logger.debug({ venueId, chain }, 'Incremented error count');
    } catch (error) {
      this.logger.error(
        {
          error: (error as Error).message,
          venueId,
          chain,
        },
        'Failed to increment error count'
      );
    }
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
    try {
      await this.pool.query(
        `UPDATE connector_health
         SET invalid_ts_count = invalid_ts_count + 1,
             updated_at = NOW()
         WHERE venue_id = $1 AND (chain = $2 OR ($2 IS NULL AND chain IS NULL))`,
        [venueId, chain || null]
      );

      this.logger.debug({ venueId, chain }, 'Incremented invalid timestamp count');
    } catch (error) {
      this.logger.error(
        {
          error: (error as Error).message,
          venueId,
          chain,
        },
        'Failed to increment invalid timestamp count'
      );
    }
  }

  public async incrementFutureTsCount(venueId: number, chain?: Chain): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE connector_health
         SET future_ts_count = future_ts_count + 1,
             updated_at = NOW()
         WHERE venue_id = $1 AND (chain = $2 OR ($2 IS NULL AND chain IS NULL))`,
        [venueId, chain || null]
      );

      this.logger.debug({ venueId, chain }, 'Incremented future timestamp count');
    } catch (error) {
      this.logger.error(
        {
          error: (error as Error).message,
          venueId,
          chain,
        },
        'Failed to increment future timestamp count'
      );
    }
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
      this.logger.error(
        {
          error: (error as Error).message,
          venueId,
          chain,
        },
        'Failed to get connector health'
      );
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
}
