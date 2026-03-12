import pg from 'pg';
import type { TrackedTrader, CopyTrade, CopyPosition, KillSwitchEvent } from './types.js';

export class PolymarketPersistence {
  constructor(private readonly pool: pg.Pool) {}

  async upsertTrader(trader: TrackedTrader): Promise<void> {
    await this.pool.query(
      `INSERT INTO pm_tracked_traders (address, alias, pnl, volume, bankroll_estimate, rank, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (address) DO UPDATE SET
         alias = EXCLUDED.alias,
         pnl = EXCLUDED.pnl,
         volume = EXCLUDED.volume,
         bankroll_estimate = EXCLUDED.bankroll_estimate,
         rank = EXCLUDED.rank,
         updated_at = NOW()`,
      [trader.address, trader.alias, trader.pnl, trader.volume, trader.bankrollEstimate, trader.rank, trader.enabled],
    );
  }

  async getActiveTraders(): Promise<TrackedTrader[]> {
    const result = await this.pool.query(
      `SELECT address, alias, pnl::float, volume::float, bankroll_estimate::float as "bankrollEstimate",
              rank, enabled, discovered_at as "discoveredAt", last_activity_at as "lastActivityAt"
       FROM pm_tracked_traders WHERE enabled = true ORDER BY rank ASC`,
    );
    return result.rows;
  }

  async updateTraderActivity(address: string): Promise<void> {
    await this.pool.query(
      `UPDATE pm_tracked_traders SET last_activity_at = NOW(), updated_at = NOW() WHERE address = $1`,
      [address],
    );
  }

  async saveCopyTrade(trade: CopyTrade): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO pm_copy_trades (trader_address, condition_id, token_id, side, size, price, outcome, market_slug, status, paper, order_id, fill_price, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [trade.traderAddress, trade.conditionId, trade.tokenId, trade.side, trade.size, trade.price,
       trade.outcome, trade.marketSlug, trade.status, trade.paper, trade.orderId, trade.fillPrice, trade.errorMessage],
    );
    return result.rows[0].id;
  }

  async updateCopyTrade(id: number, update: Partial<Pick<CopyTrade, 'status' | 'orderId' | 'fillPrice' | 'errorMessage'>>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (update.status !== undefined) { sets.push(`status = $${i++}`); params.push(update.status); }
    if (update.orderId !== undefined) { sets.push(`order_id = $${i++}`); params.push(update.orderId); }
    if (update.fillPrice !== undefined) { sets.push(`fill_price = $${i++}`); params.push(update.fillPrice); }
    if (update.errorMessage !== undefined) { sets.push(`error_message = $${i++}`); params.push(update.errorMessage); }

    if (sets.length === 0) return;
    params.push(id);
    await this.pool.query(`UPDATE pm_copy_trades SET ${sets.join(', ')} WHERE id = $${i}`, params);
  }

  async upsertPosition(pos: CopyPosition): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO pm_positions (condition_id, token_id, side, outcome, market_slug, market_question, avg_entry, size, current_price, unrealized_pnl, realized_pnl, status, paper)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT ON CONSTRAINT pm_positions_pkey DO UPDATE SET
         avg_entry = EXCLUDED.avg_entry,
         size = EXCLUDED.size,
         current_price = EXCLUDED.current_price,
         unrealized_pnl = EXCLUDED.unrealized_pnl,
         realized_pnl = EXCLUDED.realized_pnl,
         status = EXCLUDED.status
       RETURNING id`,
      [pos.conditionId, pos.tokenId, pos.side, pos.outcome, pos.marketSlug, pos.marketQuestion,
       pos.avgEntry, pos.size, pos.currentPrice, pos.unrealizedPnl, pos.realizedPnl, pos.status, pos.paper],
    );
    return result.rows[0].id;
  }

  async savePosition(pos: CopyPosition): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO pm_positions (condition_id, token_id, side, outcome, market_slug, market_question, avg_entry, size, current_price, unrealized_pnl, realized_pnl, status, paper)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [pos.conditionId, pos.tokenId, pos.side, pos.outcome, pos.marketSlug, pos.marketQuestion,
       pos.avgEntry, pos.size, pos.currentPrice, pos.unrealizedPnl, pos.realizedPnl, pos.status, pos.paper],
    );
    return result.rows[0].id;
  }

  async updatePosition(id: number, update: Partial<Pick<CopyPosition, 'currentPrice' | 'unrealizedPnl' | 'realizedPnl' | 'size' | 'avgEntry' | 'status'>>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (update.currentPrice !== undefined) { sets.push(`current_price = $${i++}`); params.push(update.currentPrice); }
    if (update.unrealizedPnl !== undefined) { sets.push(`unrealized_pnl = $${i++}`); params.push(update.unrealizedPnl); }
    if (update.realizedPnl !== undefined) { sets.push(`realized_pnl = $${i++}`); params.push(update.realizedPnl); }
    if (update.size !== undefined) { sets.push(`size = $${i++}`); params.push(update.size); }
    if (update.avgEntry !== undefined) { sets.push(`avg_entry = $${i++}`); params.push(update.avgEntry); }
    if (update.status !== undefined) { sets.push(`status = $${i++}`); params.push(update.status); }

    if (sets.length === 0) return;
    params.push(id);
    await this.pool.query(`UPDATE pm_positions SET ${sets.join(', ')} WHERE id = $${i}`, params);
  }

  async closePosition(id: number, realizedPnl: number): Promise<void> {
    await this.pool.query(
      `UPDATE pm_positions SET status = 'closed', realized_pnl = $1, closed_at = NOW() WHERE id = $2`,
      [realizedPnl, id],
    );
  }

  async getOpenPositions(): Promise<(CopyPosition & { id: number })[]> {
    const result = await this.pool.query(
      `SELECT id, condition_id as "conditionId", token_id as "tokenId", side, outcome,
              market_slug as "marketSlug", market_question as "marketQuestion",
              avg_entry::float as "avgEntry", size::float, current_price::float as "currentPrice",
              unrealized_pnl::float as "unrealizedPnl", realized_pnl::float as "realizedPnl",
              status, paper, opened_at as "openedAt", closed_at as "closedAt"
       FROM pm_positions WHERE status = 'open' ORDER BY opened_at DESC`,
    );
    return result.rows;
  }

  async getDailyPnl(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(realized_pnl), 0)::float as pnl
       FROM pm_positions
       WHERE status = 'closed' AND closed_at >= (NOW() AT TIME ZONE 'UTC')::date`,
    );
    return result.rows[0].pnl;
  }

  async getTotalPnl(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(realized_pnl), 0)::float as pnl FROM pm_positions WHERE status = 'closed'`,
    );
    return result.rows[0].pnl;
  }

  async getTotalExposure(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(size * avg_entry), 0)::float as exposure FROM pm_positions WHERE status = 'open'`,
    );
    return result.rows[0].exposure;
  }

  async getOpenMarketsCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(DISTINCT condition_id)::int as count FROM pm_positions WHERE status = 'open'`,
    );
    return result.rows[0].count;
  }

  async getPositionByToken(tokenId: string): Promise<(CopyPosition & { id: number }) | null> {
    const result = await this.pool.query(
      `SELECT id, condition_id as "conditionId", token_id as "tokenId", side, outcome,
              market_slug as "marketSlug", market_question as "marketQuestion",
              avg_entry::float as "avgEntry", size::float, current_price::float as "currentPrice",
              unrealized_pnl::float as "unrealizedPnl", realized_pnl::float as "realizedPnl",
              status, paper, opened_at as "openedAt", closed_at as "closedAt"
       FROM pm_positions WHERE token_id = $1 AND status = 'open' LIMIT 1`,
      [tokenId],
    );
    return result.rows[0] ?? null;
  }

  async saveKillSwitchEvent(event: KillSwitchEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO pm_kill_switch_events (reason, daily_pnl, total_exposure, positions_open)
       VALUES ($1, $2, $3, $4)`,
      [event.reason, event.dailyPnl, event.totalExposure, event.positionsOpen],
    );
  }
}
