import pg from 'pg';
import type { TrackedTrader, KillSwitchEvent, ShadowTrade, TraderStats } from './types.js';

export class PolymarketPersistence {
  constructor(private readonly pool: pg.Pool) {}

  getPool(): pg.Pool {
    return this.pool;
  }

  async upsertTrader(trader: TrackedTrader): Promise<void> {
    await this.pool.query(
      `INSERT INTO pm_tracked_traders (address, alias, pnl, volume, bankroll_estimate, rank, enabled, copy_eligible, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (address) DO UPDATE SET
         alias = EXCLUDED.alias,
         pnl = EXCLUDED.pnl,
         volume = EXCLUDED.volume,
         bankroll_estimate = EXCLUDED.bankroll_estimate,
         rank = EXCLUDED.rank,
         enabled = EXCLUDED.enabled,
         copy_eligible = EXCLUDED.copy_eligible,
         category = EXCLUDED.category,
         updated_at = NOW()`,
      [trader.address, trader.alias, trader.pnl, trader.volume, trader.bankrollEstimate, trader.rank, trader.enabled, trader.copyEligible ?? false, trader.category || 'SPORTS'],
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
              rank, enabled, copy_eligible as "copyEligible", category, discovered_at as "discoveredAt", last_activity_at as "lastActivityAt"
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

  async getDailyPnl(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(real_pnl), 0) as pnl
       FROM pm_live_trades
       WHERE resolved = true AND execution_status = 'filled'
         AND resolved_at >= (NOW() AT TIME ZONE 'UTC')::date`,
    );
    return parseFloat(result.rows[0].pnl);
  }

  async getTotalPnl(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(real_pnl), 0) as pnl
       FROM pm_live_trades WHERE resolved = true AND execution_status = 'filled'`,
    );
    return parseFloat(result.rows[0].pnl);
  }

  async getTotalExposure(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(COALESCE(fill_size, our_size) * COALESCE(fill_price, our_entry_price)), 0) as exposure
       FROM pm_live_trades WHERE resolved = false AND execution_status = 'filled'`,
    );
    return parseFloat(result.rows[0].exposure);
  }

  async getOpenMarketsCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(DISTINCT condition_id)::int as count FROM pm_live_trades WHERE resolved = false AND execution_status = 'filled'`,
    );
    return result.rows[0].count;
  }

  async getPositionByCondition(conditionId: string): Promise<{ size: number; avgEntry: number; notional: number; tradeCount: number } | null> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(COALESCE(fill_size, our_size)), 0)::float as size,
              COALESCE(AVG(COALESCE(fill_price, our_entry_price)), 0)::float as "avgEntry",
              COALESCE(SUM(COALESCE(fill_size, our_size) * COALESCE(fill_price, our_entry_price)), 0)::float as notional,
              COUNT(*)::int as "tradeCount"
       FROM pm_live_trades WHERE condition_id = $1 AND resolved = false AND execution_status = 'filled'`,
      [conditionId],
    );
    const row = result.rows[0];
    if (!row || row.size === 0) return null;
    return { size: row.size, avgEntry: row.avgEntry, notional: row.notional, tradeCount: row.tradeCount };
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

  async saveLiveTrade(trade: ShadowTrade, scores?: { winScore?: number; capScore?: number; calProb?: number; kellySize?: number; apyScore?: number }): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO pm_live_trades (trader_address, trader_alias, condition_id, token_id, side, size, price, outcome, market_slug, our_size, our_entry_price, current_price, trader_timestamp, win_score, cap_score, cal_prob, kelly_size, apy_score, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'node')
       ON CONFLICT (trader_address, condition_id, token_id, side, trader_timestamp) DO NOTHING
       RETURNING id`,
      [trade.traderAddress, trade.traderAlias, trade.conditionId, trade.tokenId, trade.side,
       trade.size, trade.price, trade.outcome, trade.marketSlug,
       trade.ourSize, trade.ourEntryPrice, trade.currentPrice, trade.traderTimestamp,
       scores?.winScore ?? null, scores?.capScore ?? null, scores?.calProb ?? null, scores?.kellySize ?? null, scores?.apyScore ?? null],
    );
    return result.rows[0]?.id ?? 0;
  }

  async getUnresolvedLiveTrades(): Promise<(ShadowTrade & { id: number; executionStatus: string; fillPrice: number | null; fillSize: number | null })[]> {
    const result = await this.pool.query(
      `SELECT id, condition_id as "conditionId", token_id as "tokenId", side,
              our_size::float as "ourSize", our_entry_price::float as "ourEntryPrice",
              current_price::float as "currentPrice", market_slug as "marketSlug",
              execution_status as "executionStatus", fill_price::float as "fillPrice",
              fill_size::float as "fillSize"
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

  async updateLiveTradeExecution(
    id: number,
    orderId: string | null,
    fillPrice: number | null,
    fillSize: number | null,
    status: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE pm_live_trades SET order_id = $1, fill_price = $2, fill_size = $3, execution_status = $4, executed_at = NOW() WHERE id = $5`,
      [orderId, fillPrice, fillSize, status, id],
    );
  }

  async resolveLiveTradeWithRealPnl(id: number, resolutionPrice: number, pnl: number): Promise<void> {
    await this.pool.query(
      `UPDATE pm_live_trades SET resolved = true, resolution_price = $1, pnl = $2,
        real_pnl = CASE WHEN fill_price IS NOT NULL THEN ($1 - fill_price) * COALESCE(fill_size, our_size) ELSE NULL END,
        resolved_at = NOW() WHERE id = $3`,
      [resolutionPrice, pnl, id],
    );
  }

  async getFilledPositionForSell(traderAddress: string, conditionId: string, tokenId: string): Promise<{ id: number; fillSize: number; fillPrice: number } | null> {
    const result = await this.pool.query(
      `SELECT id, COALESCE(fill_size, our_size)::float as "fillSize", COALESCE(fill_price, our_entry_price)::float as "fillPrice"
       FROM pm_live_trades
       WHERE trader_address = $1 AND condition_id = $2 AND token_id = $3
         AND execution_status = 'filled' AND resolved = false AND side = 'BUY'
       ORDER BY observed_at DESC LIMIT 1`,
      [traderAddress, conditionId, tokenId],
    );
    return result.rows[0] || null;
  }

  async markLiveTradeSold(id: number, exitPrice: number, realPnl: number, orderId: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE pm_live_trades SET resolved = true, resolution_price = $1, real_pnl = $2, order_id = COALESCE($3, order_id),
        execution_status = 'sold', resolved_at = NOW() WHERE id = $4`,
      [exitPrice, realPnl, orderId, id],
    );
  }

  async getTraderRecencyStats(traderAddress: string, window: number): Promise<{ trades: number; winRate: number; profitFactor: number }> {
    const result = await this.pool.query(
      `SELECT pnl_if_copied::float as pnl
       FROM pm_shadow_trades
       WHERE trader_address = $1 AND resolved = true AND side = 'BUY' AND our_entry_price > 0
       ORDER BY trader_timestamp DESC LIMIT $2`,
      [traderAddress, window],
    );
    const pnls = result.rows.map((r: { pnl: number }) => r.pnl);
    if (pnls.length < window) return { trades: pnls.length, winRate: 1, profitFactor: 99 };
    const wins = pnls.filter((p: number) => p > 0).length;
    const grossWins = pnls.filter((p: number) => p > 0).reduce((a: number, b: number) => a + b, 0);
    const grossLosses = Math.abs(pnls.filter((p: number) => p < 0).reduce((a: number, b: number) => a + b, 0));
    return {
      trades: pnls.length,
      winRate: wins / pnls.length,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 0,
    };
  }

  async getTraderLiveStats(traderAddress: string): Promise<{ trades: number; pnl: number; consecutiveLosses: number }> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int as trades, COALESCE(SUM(pnl), 0)::float as pnl
       FROM pm_live_trades WHERE trader_address = $1 AND resolved = true`,
      [traderAddress],
    );
    const streakResult = await this.pool.query(
      `WITH numbered AS (
        SELECT pnl, ROW_NUMBER() OVER (ORDER BY resolved_at DESC) as rn
        FROM pm_live_trades WHERE trader_address = $1 AND resolved = true
       )
       SELECT COUNT(*) as streak FROM numbered
       WHERE pnl <= 0 AND rn <= (
         SELECT COALESCE(MIN(rn) - 1, COUNT(*)) FROM numbered WHERE pnl > 0
       )`,
      [traderAddress],
    );
    return {
      trades: result.rows[0]?.trades || 0,
      pnl: result.rows[0]?.pnl || 0,
      consecutiveLosses: streakResult.rows[0]?.streak || 0,
    };
  }

  async getTraderShadowStats(): Promise<Map<string, TraderStats>> {
    const halflife = Number(process.env.PM_RECENCY_HALFLIFE || 0.2);

    const metaResult = await this.pool.query(
      `WITH cumulative AS (
        SELECT trader_address, trader_timestamp,
          SUM(pnl_if_copied) OVER (PARTITION BY trader_address ORDER BY trader_timestamp) AS equity
        FROM pm_shadow_trades
        WHERE resolved = true AND side = 'BUY' AND our_entry_price > 0
      ),
      with_hw AS (
        SELECT trader_address,
          equity - MAX(equity) OVER (PARTITION BY trader_address ORDER BY trader_timestamp) AS dd
        FROM cumulative
      )
      SELECT trader_address, MIN(dd)::float as max_dd FROM with_hw GROUP BY trader_address`,
    );
    const ddMap = new Map<string, number>();
    for (const row of metaResult.rows) {
      ddMap.set(row.trader_address, row.max_dd);
    }

    const pnlResult = await this.pool.query(
      `SELECT trader_address, pnl_if_copied::float as pnl,
              our_entry_price::float as entry_price,
              to_timestamp(trader_timestamp/1000)::date as trade_date
       FROM pm_shadow_trades
       WHERE resolved = true AND side = 'BUY' AND our_entry_price > 0
       ORDER BY trader_address, trader_timestamp`,
    );

    const byTrader = new Map<string, { pnls: number[]; entryPrices: number[]; dates: Set<string> }>();
    for (const row of pnlResult.rows) {
      let entry = byTrader.get(row.trader_address);
      if (!entry) {
        entry = { pnls: [], entryPrices: [], dates: new Set() };
        byTrader.set(row.trader_address, entry);
      }
      entry.pnls.push(row.pnl);
      entry.entryPrices.push(row.entry_price);
      entry.dates.add(String(row.trade_date));
    }

    const map = new Map<string, TraderStats>();
    for (const [addr, data] of byTrader) {
      const { pnls, entryPrices, dates } = data;
      const n = pnls.length;
      if (n < 2) continue;

      const hl = Math.max(Math.floor(n * halflife), 5);
      const weights: number[] = [];
      for (let i = 0; i < n; i++) {
        weights.push(Math.exp(-Math.LN2 / hl * (n - 1 - i)));
      }
      const wSum = weights.reduce((a, b) => a + b, 0);
      const normWeights = weights.map(w => w / wSum * n);

      let wAvg = 0;
      for (let i = 0; i < n; i++) wAvg += pnls[i] * normWeights[i];
      wAvg /= n;

      let wVar = 0;
      for (let i = 0; i < n; i++) wVar += normWeights[i] * (pnls[i] - wAvg) ** 2;
      wVar /= n;
      const wStd = Math.sqrt(wVar);

      const sharpe = wStd > 0 ? wAvg / wStd : 0;

      let wWins = 0;
      let wLosses = 0;
      for (let i = 0; i < n; i++) {
        if (pnls[i] > 0) wWins += pnls[i] * normWeights[i];
        else wLosses += Math.abs(pnls[i]) * normWeights[i];
      }
      const profitFactor = wLosses > 0 ? wWins / wLosses : (wWins > 0 ? 99 : 0);

      const wins = pnls.filter(p => p > 0).length;
      const totalPnl = pnls.reduce((a, b) => a + b, 0);

      let cfWins = 0;
      let cfTotal = 0;
      for (let i = 0; i < n; i++) {
        if (entryPrices[i] >= 0.30 && entryPrices[i] <= 0.70) {
          cfTotal++;
          if (pnls[i] > 0) cfWins++;
        }
      }
      const coinflipWR = cfTotal >= 10 ? cfWins / cfTotal : 0;

      map.set(addr, {
        trades: n,
        wins,
        pnl: totalPnl,
        activeDays: dates.size,
        maxDrawdown: ddMap.get(addr) ?? 0,
        sharpe,
        profitFactor,
        coinflipWR,
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
