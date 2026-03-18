import type pg from 'pg';
import type { PMMFill, PMMStats, PMMActiveMarket } from './types.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger({ component: 'pmm-persistence' });

export class PMMPersistence {
  constructor(private readonly pool: pg.Pool) {}

  async saveFills(fills: PMMFill[]): Promise<void> {
    if (fills.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const f of fills) {
      placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6}, $${idx+7}, $${idx+8}, $${idx+9}, $${idx+10}, $${idx+11}, $${idx+12}, $${idx+13})`);
      values.push(
        f.conditionId, f.tokenId, f.side, f.price, f.size, f.notionalUsd,
        new Date(f.timestamp), f.midAtFill, f.edgeCents,
        f.adverseSelectionCents ?? null, f.ofi ?? null, f.vpin ?? null,
        f.ewmaVol ?? null, f.bookImbalance ?? null,
      );
      idx += 14;
    }

    try {
      await this.pool.query(
        `INSERT INTO pmm_fills (condition_id, token_id, side, price, size, notional_usd,
          fill_time, mid_at_fill, edge_cents, adverse_cents, ofi, vpin, ewma_vol, book_imbalance)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT DO NOTHING`,
        values,
      );
    } catch (err) {
      log.warn({ error: (err as Error).message, count: fills.length }, 'Failed to persist PMM fills');
    }
  }

  async saveStats(stats: PMMStats, runHours: number): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO pmm_stats (snapshot_time, run_hours, total_fills, total_volume_usd,
          spread_pnl, adverse_cost, net_pnl, avg_edge_cents, fills_per_hour, toxic_pct, markets_active)
         VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          runHours, stats.totalFills, stats.totalVolumeUsd,
          stats.spreadPnl, stats.adverseCost, stats.netPnl,
          stats.avgEdgeCents, stats.fillsPerHour, stats.toxicFillPct, stats.marketsActive,
        ],
      );
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to persist PMM stats');
    }
  }

  async upsertActiveMarket(market: PMMActiveMarket): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO pmm_active_markets (condition_id, question, slug, yes_token_id, no_token_id,
          mid_price, volume_24h, liquidity, end_date, score, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (condition_id) DO UPDATE SET
           mid_price = EXCLUDED.mid_price,
           volume_24h = EXCLUDED.volume_24h,
           liquidity = EXCLUDED.liquidity,
           score = EXCLUDED.score,
           updated_at = NOW()`,
        [
          market.conditionId, market.question, market.slug,
          market.yesTokenId, market.noTokenId, market.midPrice,
          market.volume24h, market.liquidity, market.endDate,
          market.score, new Date(market.startedAt),
        ],
      );
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to upsert active market');
    }
  }

  async removeActiveMarket(conditionId: string): Promise<void> {
    try {
      await this.pool.query(
        `DELETE FROM pmm_active_markets WHERE condition_id = $1`,
        [conditionId],
      );
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to remove active market');
    }
  }

  async getPositionPnl(conditionId: string): Promise<number> {
    const res = await this.pool.query(
      `SELECT COALESCE(SUM(
        CASE WHEN side = 'BUY' THEN -notional_usd ELSE notional_usd END
      ), 0) as net_pnl FROM pmm_fills WHERE condition_id = $1`,
      [conditionId],
    );
    return parseFloat(res.rows[0]?.net_pnl || '0');
  }

  async getTotalExposure(): Promise<number> {
    const res = await this.pool.query(
      `SELECT COALESCE(SUM(ABS(net_shares * avg_entry)), 0) as exposure
       FROM pmm_positions WHERE net_shares != 0`,
    );
    return parseFloat(res.rows[0]?.exposure || '0');
  }
}
