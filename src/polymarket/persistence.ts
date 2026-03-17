import pg from 'pg';
import type { TrackedTrader, CopyTrade, CopyPosition, KillSwitchEvent, ShadowTrade, TraderStats } from './types.js';

export class PolymarketPersistence {
  constructor(private readonly pool: pg.Pool) {}

  getPool(): pg.Pool {
    return this.pool;
  }

  async upsertTrader(trader: TrackedTrader): Promise<void> {
    await this.pool.query(
      `INSERT INTO pm_tracked_traders (address, alias, pnl, volume, bankroll_estimate, rank, enabled, copy_eligible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (address) DO UPDATE SET
         alias = EXCLUDED.alias,
         pnl = EXCLUDED.pnl,
         volume = EXCLUDED.volume,
         bankroll_estimate = EXCLUDED.bankroll_estimate,
         rank = EXCLUDED.rank,
         enabled = EXCLUDED.enabled,
         copy_eligible = EXCLUDED.copy_eligible,
         updated_at = NOW()`,
      [trader.address, trader.alias, trader.pnl, trader.volume, trader.bankrollEstimate, trader.rank, trader.enabled, trader.copyEligible ?? false],
    );
  }

  async disableStaleTraders(): Promise<void> {
    await this.pool.query(
      `UPDATE pm_tracked_traders SET enabled = false, updated_at = NOW()
       WHERE address NOT IN (
         SELECT trader_address FROM pm_shadow_trades
         WHERE resolved = true AND side = 'BUY' AND our_entry_price > 0
         GROUP BY trader_address
         HAVING COUNT(*) >= 3 AND SUM(pnl_if_copied) > 0
       )`,
    );
  }

  async enableProvenTrader(address: string, copyEligible: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE pm_tracked_traders SET enabled = true, copy_eligible = $1, updated_at = NOW() WHERE address = $2`,
      [copyEligible, address],
    );
  }

  async updateCopyEligible(address: string, copyEligible: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE pm_tracked_traders SET copy_eligible = $1, updated_at = NOW() WHERE address = $2`,
      [copyEligible, address],
    );
  }

  async getActiveTraders(): Promise<TrackedTrader[]> {
    const result = await this.pool.query(
      `SELECT address, alias, pnl::float, volume::float, bankroll_estimate::float as "bankrollEstimate",
              rank, enabled, copy_eligible as "copyEligible", discovered_at as "discoveredAt", last_activity_at as "lastActivityAt"
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
      `SELECT COALESCE(SUM(pnl), 0) as pnl
       FROM pm_live_trades
       WHERE resolved = true AND resolved_at >= (NOW() AT TIME ZONE 'UTC')::date`,
    );
    return parseFloat(result.rows[0].pnl);
  }

  async getTotalPnl(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(pnl), 0) as pnl FROM pm_live_trades WHERE resolved = true`,
    );
    return parseFloat(result.rows[0].pnl);
  }

  async getTotalExposure(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(our_size * our_entry_price), 0) as exposure FROM pm_live_trades WHERE resolved = false`,
    );
    return parseFloat(result.rows[0].exposure);
  }

  async getOpenMarketsCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(DISTINCT condition_id)::int as count FROM pm_live_trades WHERE resolved = false`,
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

  async getPositionByCondition(conditionId: string): Promise<{ size: number; avgEntry: number } | null> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(our_size), 0)::float as size, COALESCE(AVG(our_entry_price), 0)::float as "avgEntry"
       FROM pm_live_trades WHERE condition_id = $1 AND resolved = false`,
      [conditionId],
    );
    const row = result.rows[0];
    if (!row || row.size === 0) return null;
    return { size: row.size, avgEntry: row.avgEntry };
  }

  async saveShadowTrade(trade: ShadowTrade): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO pm_shadow_trades (trader_address, trader_alias, condition_id, token_id, side, size, price, outcome, market_slug, market_question, neg_risk, our_size, our_entry_price, current_price, trader_timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [trade.traderAddress, trade.traderAlias, trade.conditionId, trade.tokenId, trade.side,
       trade.size, trade.price, trade.outcome, trade.marketSlug, trade.marketQuestion,
       trade.negRisk, trade.ourSize, trade.ourEntryPrice, trade.currentPrice, trade.traderTimestamp],
    );
    return result.rows[0].id;
  }

  async getUnresolvedShadowTrades(): Promise<(ShadowTrade & { id: number })[]> {
    const result = await this.pool.query(
      `SELECT id, condition_id as "conditionId", token_id as "tokenId", side,
              our_size::float as "ourSize", our_entry_price::float as "ourEntryPrice",
              current_price::float as "currentPrice", market_slug as "marketSlug"
       FROM pm_shadow_trades WHERE resolved = false AND side = 'BUY'
       ORDER BY observed_at ASC`,
    );
    return result.rows;
  }

  async resolveShadowTrade(id: number, resolutionPrice: number, pnl: number): Promise<void> {
    await this.pool.query(
      `UPDATE pm_shadow_trades SET resolved = true, resolution_price = $1, pnl_if_copied = $2, resolved_at = NOW() WHERE id = $3`,
      [resolutionPrice, pnl, id],
    );
  }

  async updateShadowPrice(id: number, currentPrice: number, pnl: number): Promise<void> {
    await this.pool.query(
      `UPDATE pm_shadow_trades SET current_price = $1, pnl_if_copied = $2 WHERE id = $3`,
      [currentPrice, pnl, id],
    );
  }

  async saveLiveTrade(trade: ShadowTrade): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO pm_live_trades (trader_address, trader_alias, condition_id, token_id, side, size, price, outcome, market_slug, our_size, our_entry_price, current_price, trader_timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (trader_address, condition_id, token_id, side, trader_timestamp) DO NOTHING
       RETURNING id`,
      [trade.traderAddress, trade.traderAlias, trade.conditionId, trade.tokenId, trade.side,
       trade.size, trade.price, trade.outcome, trade.marketSlug,
       trade.ourSize, trade.ourEntryPrice, trade.currentPrice, trade.traderTimestamp],
    );
    return result.rows[0]?.id ?? 0;
  }

  async getUnresolvedLiveTrades(): Promise<(ShadowTrade & { id: number })[]> {
    const result = await this.pool.query(
      `SELECT id, condition_id as "conditionId", token_id as "tokenId", side,
              our_size::float as "ourSize", our_entry_price::float as "ourEntryPrice",
              current_price::float as "currentPrice", market_slug as "marketSlug"
       FROM pm_live_trades WHERE resolved = false AND side = 'BUY'
       ORDER BY observed_at ASC`,
    );
    return result.rows;
  }

  async resolveLiveTrade(id: number, resolutionPrice: number, pnl: number): Promise<void> {
    await this.pool.query(
      `UPDATE pm_live_trades SET resolved = true, resolution_price = $1, pnl = $2, resolved_at = NOW() WHERE id = $3`,
      [resolutionPrice, pnl, id],
    );
  }

  async updateLiveTradePrice(id: number, currentPrice: number, pnl: number): Promise<void> {
    await this.pool.query(
      `UPDATE pm_live_trades SET current_price = $1, pnl = $2 WHERE id = $3`,
      [currentPrice, pnl, id],
    );
  }

  async getTraderShadowStats(): Promise<Map<string, TraderStats>> {
    const result = await this.pool.query(
      `WITH per_trader AS (
        SELECT trader_address,
          COUNT(*)::int as trades,
          COUNT(*) FILTER (WHERE pnl_if_copied > 0)::int as wins,
          COALESCE(SUM(pnl_if_copied), 0)::float as pnl,
          COALESCE(AVG(pnl_if_copied), 0)::float as avg_pnl,
          COALESCE(STDDEV(pnl_if_copied), 1)::float as std_pnl,
          COALESCE(SUM(pnl_if_copied) FILTER (WHERE pnl_if_copied > 0), 0)::float as gross_wins,
          COALESCE(SUM(pnl_if_copied) FILTER (WHERE pnl_if_copied < 0), 0)::float as gross_losses,
          COUNT(DISTINCT DATE(to_timestamp(trader_timestamp/1000)))::int as active_days
        FROM pm_shadow_trades
        WHERE resolved = true AND side = 'BUY' AND our_entry_price > 0
        GROUP BY trader_address
      ),
      cumulative AS (
        SELECT trader_address, trader_timestamp,
          SUM(pnl_if_copied) OVER (PARTITION BY trader_address ORDER BY trader_timestamp) AS equity
        FROM pm_shadow_trades
        WHERE resolved = true AND side = 'BUY' AND our_entry_price > 0
      ),
      with_hw AS (
        SELECT trader_address,
          equity - MAX(equity) OVER (PARTITION BY trader_address ORDER BY trader_timestamp) AS dd
        FROM cumulative
      ),
      max_dd AS (
        SELECT trader_address, MIN(dd)::float as max_dd FROM with_hw GROUP BY trader_address
      )
      SELECT p.trader_address, p.trades, p.wins, p.pnl, p.avg_pnl, p.std_pnl,
        p.gross_wins, p.gross_losses, p.active_days, COALESCE(d.max_dd, 0) as max_dd
      FROM per_trader p LEFT JOIN max_dd d ON p.trader_address = d.trader_address`,
    );
    const map = new Map<string, TraderStats>();
    for (const row of result.rows) {
      const sharpe = row.std_pnl > 0 ? row.avg_pnl / row.std_pnl : 0;
      const profitFactor = row.gross_losses < 0 ? row.gross_wins / Math.abs(row.gross_losses) : (row.gross_wins > 0 ? 99 : 0);
      map.set(row.trader_address, {
        trades: row.trades, wins: row.wins, pnl: row.pnl,
        activeDays: row.active_days, maxDrawdown: row.max_dd,
        sharpe, profitFactor,
      });
    }
    return map;
  }

  async saveKillSwitchEvent(event: KillSwitchEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO pm_kill_switch_events (reason, daily_pnl, total_exposure, positions_open)
       VALUES ($1, $2, $3, $4)`,
      [event.reason, event.dailyPnl, event.totalExposure, event.positionsOpen],
    );
  }
}
