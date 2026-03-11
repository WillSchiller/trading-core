import WebSocket from 'ws';
import type { Pool } from 'pg';
import { createChildLogger } from '../../utils/logger.js';
import { BookFeed } from './book-feed.js';
import type { MMConfig, MMFill, MMPosition, BookSnapshot, MMStats } from './types.js';

const log = createChildLogger({ component: 'paper-mm' });

const MAKER_REBATE_BPS = 1.0;
const ADVERSE_CHECK_MS = 60_000;  // check price 1 min after fill
const STATS_INTERVAL_MS = 300_000;  // print stats every 5 min
const PERSIST_INTERVAL_MS = 60_000;

export class PaperMarketMaker {
  private config: MMConfig;
  private pool: Pool;
  private bookFeed: BookFeed;
  private tradeWs: WebSocket | null = null;

  private positions: Map<string, MMPosition> = new Map();
  private fills: MMFill[] = [];
  private pendingAdverseChecks: Array<{ fill: MMFill; checkAt: number }> = [];

  private statsTimer: NodeJS.Timeout | null = null;
  private adverseTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private startTime = 0;
  private tradeReconnectAttempts = 0;

  // Track mid prices for adverse selection measurement
  private midPriceHistory: Map<string, Array<{ time: number; mid: number }>> = new Map();

  constructor(config: MMConfig, pool: Pool) {
    this.config = config;
    this.pool = pool;
    this.bookFeed = new BookFeed(config.assets, (book) => this.onBookUpdate(book));
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.startTime = Date.now();

    // Init positions
    for (const asset of this.config.assets) {
      this.positions.set(asset, {
        asset, netQty: 0, netNotional: 0, avgEntryPrice: 0, fills: 0, realizedPnl: 0,
      });
    }

    // Start book feed
    this.bookFeed.start();

    // Start trade feed (to simulate fills)
    this.connectTradeWs();

    // Start timers
    this.statsTimer = setInterval(() => this.printStats(), STATS_INTERVAL_MS);
    this.adverseTimer = setInterval(() => this.checkAdverseSelection(), 10_000);
    this.persistTimer = setInterval(() => this.persist(), PERSIST_INTERVAL_MS);

    log.info({ assets: this.config.assets, posSize: this.config.positionSizeUsd }, 'Paper MM started');
  }

  stop(): void {
    this.stopping = true;
    this.bookFeed.stop();
    if (this.tradeWs) { this.tradeWs.close(); this.tradeWs = null; }
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.adverseTimer) clearInterval(this.adverseTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.printStats();
    this.persist();
  }

  private connectTradeWs(): void {
    if (this.stopping) return;
    this.tradeWs = new WebSocket('wss://api.hyperliquid.xyz/ws');

    this.tradeWs.on('open', () => {
      log.info('Trade feed WS connected');
      this.tradeReconnectAttempts = 0;
      for (const asset of this.config.assets) {
        this.tradeWs!.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'trades', coin: asset },
        }));
      }
    });

    this.tradeWs.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.channel === 'trades') {
          this.handleTrades(msg.data);
        }
      } catch {}
    });

    this.tradeWs.on('close', () => {
      if (!this.stopping) {
        this.tradeReconnectAttempts++;
        const delay = Math.min(1000 * 2 ** this.tradeReconnectAttempts, 30000);
        setTimeout(() => this.connectTradeWs(), delay);
      }
    });

    this.tradeWs.on('error', (err: Error) => {
      log.warn({ error: err.message }, 'Trade feed WS error');
    });
  }

  private onBookUpdate(book: BookSnapshot): void {
    // Track mid price history for adverse selection
    let history = this.midPriceHistory.get(book.asset);
    if (!history) {
      history = [];
      this.midPriceHistory.set(book.asset, history);
    }
    history.push({ time: Date.now(), mid: book.midPrice });
    // Keep 10 min of history
    const cutoff = Date.now() - 600_000;
    while (history.length > 0 && history[0].time < cutoff) {
      history.shift();
    }
  }

  private handleTrades(trades: Array<{ coin: string; side: string; px: string; sz: string; time: number }>): void {
    if (!Array.isArray(trades)) return;

    for (const t of trades) {
      const asset = t.coin;
      if (!this.config.assets.includes(asset)) continue;

      const book = this.bookFeed.getBook(asset);
      if (!book) continue;

      const tradePx = parseFloat(t.px);
      const tradeSz = parseFloat(t.sz);
      const tradeNotional = tradePx * tradeSz;
      const isBuy = t.side === 'B';  // buyer is aggressor

      // Paper MM logic:
      // If a buy trade happens at or above our ask, our ask got lifted (we sold)
      // If a sell trade happens at or below our bid, our bid got hit (we bought)
      // We simulate being at best bid/ask with our position size

      const pos = this.positions.get(asset);
      if (!pos) continue;

      const inventoryUsd = Math.abs(pos.netNotional);
      if (inventoryUsd >= this.config.maxInventoryUsd) continue;

      // Our quote prices: best bid/ask with inventory skew
      const skewBps = (pos.netNotional / this.config.positionSizeUsd) * this.config.skewBpsPerUnit;
      const ourBid = book.bestBid * (1 - skewBps / 10000);
      const ourAsk = book.bestAsk * (1 + skewBps / 10000);

      // Simulate fill probability: we get filled proportional to our size vs total at that level
      // Simple model: if trade notional > $50, we get a proportional fill
      const ourSizeUsd = this.config.positionSizeUsd;

      const sideFilter = this.config.assetSideFilter?.[asset] ?? 'both';

      if (isBuy && tradePx >= ourAsk) {
        const levelTotal = (book.asks[0]?.sz || 0) * tradePx;
        if (levelTotal <= 0) continue;
        const fillProbability = Math.min(1, ourSizeUsd / (levelTotal + ourSizeUsd));
        if (tradeNotional < 50 || Math.random() > fillProbability) continue;

        const fillSz = Math.min(ourSizeUsd / tradePx, tradeSz * fillProbability);
        const fillNotional = fillSz * ourAsk;
        const filtered = sideFilter !== 'both' && sideFilter !== 'sell';
        this.recordFill(asset, 'sell', ourAsk, fillSz, fillNotional, book.midPrice, filtered);
      } else if (!isBuy && tradePx <= ourBid) {
        const levelTotal = (book.bids[0]?.sz || 0) * tradePx;
        if (levelTotal <= 0) continue;
        const fillProbability = Math.min(1, ourSizeUsd / (levelTotal + ourSizeUsd));
        if (tradeNotional < 50 || Math.random() > fillProbability) continue;

        const fillSz = Math.min(ourSizeUsd / tradePx, tradeSz * fillProbability);
        const fillNotional = fillSz * ourBid;
        const filtered = sideFilter !== 'both' && sideFilter !== 'buy';
        this.recordFill(asset, 'buy', ourBid, fillSz, fillNotional, book.midPrice, filtered);
      }
    }
  }

  private recordFill(asset: string, side: 'buy' | 'sell', price: number, size: number, notional: number, midAtFill: number, filtered = false): void {
    const edgeBps = Math.abs(price - midAtFill) / midAtFill * 10000;
    const fill: MMFill = {
      asset, side, price, size, notional,
      timestamp: Date.now(), midAtFill, edgeBps, filtered,
    };

    this.fills.push(fill);
    this.pendingAdverseChecks.push({ fill, checkAt: Date.now() + ADVERSE_CHECK_MS });

    if (filtered) {
      log.debug({ asset, side, edgeBps: edgeBps.toFixed(2) }, 'Fill blocked by side filter (shadow only)');
      return;
    }

    // Update position only for non-filtered fills
    const pos = this.positions.get(asset)!;
    const signedQty = side === 'buy' ? size : -size;
    const oldQty = pos.netQty;
    pos.netQty += signedQty;
    pos.netNotional = pos.netQty * price;
    pos.fills++;

    // Check if we're flattening (partial PnL realization)
    if ((oldQty > 0 && signedQty < 0) || (oldQty < 0 && signedQty > 0)) {
      const closedQty = Math.min(Math.abs(oldQty), Math.abs(signedQty));
      const entryPx = pos.avgEntryPrice || price;
      const exitPx = price;
      const pnl = side === 'sell'
        ? (exitPx - entryPx) * closedQty
        : (entryPx - exitPx) * closedQty;
      pos.realizedPnl += pnl;
    }

    if (Math.abs(pos.netQty) > Math.abs(oldQty)) {
      // Adding to position — update avg entry
      pos.avgEntryPrice = price;
    }

    log.info({
      asset, side, price: price.toFixed(6), size: size.toFixed(4),
      notional: notional.toFixed(2), edgeBps: edgeBps.toFixed(2),
      netQty: pos.netQty.toFixed(4), fills: pos.fills,
    }, 'Paper MM fill');
  }

  private checkAdverseSelection(): void {
    const now = Date.now();
    const pending = this.pendingAdverseChecks;
    const remaining: typeof pending = [];

    for (const { fill, checkAt } of pending) {
      if (now < checkAt) {
        remaining.push({ fill, checkAt });
        continue;
      }

      // Find mid price ~1 min after fill
      const history = this.midPriceHistory.get(fill.asset);
      if (!history || history.length === 0) {
        remaining.push({ fill, checkAt: checkAt + 10_000 });
        continue;
      }

      // Get current mid as approximation
      const currentMid = history[history.length - 1].mid;
      fill.priceAfter1m = currentMid;

      // Adverse selection: how much did price move against us after fill?
      if (fill.side === 'buy') {
        // We bought — adverse if price dropped
        fill.adverseSelectionBps = (fill.midAtFill - currentMid) / fill.midAtFill * 10000;
      } else {
        // We sold — adverse if price rose
        fill.adverseSelectionBps = (currentMid - fill.midAtFill) / fill.midAtFill * 10000;
      }
    }

    this.pendingAdverseChecks = remaining;
  }

  private getStats(onlyActive = true): MMStats {
    const fills = onlyActive ? this.fills.filter(f => !f.filtered) : this.fills;
    const completedFills = fills.filter(f => f.adverseSelectionBps !== undefined);
    const totalFills = fills.length;
    const totalVolume = fills.reduce((sum, f) => sum + f.notional, 0);

    const rebates = totalFills * MAKER_REBATE_BPS * this.config.positionSizeUsd / 10000;
    const avgEdge = totalFills > 0
      ? fills.reduce((sum, f) => sum + f.edgeBps, 0) / totalFills
      : 0;

    const adverseCost = completedFills.reduce((sum, f) => {
      const adv = f.adverseSelectionBps || 0;
      return sum + (adv > 0 ? adv * f.notional / 10000 : 0);
    }, 0);

    const toxicFills = completedFills.filter(f => (f.adverseSelectionBps || 0) > 0).length;
    const toxicPct = completedFills.length > 0 ? toxicFills / completedFills.length : 0;

    const spreadPnl = fills.reduce((sum, f) => sum + f.edgeBps * f.notional / 10000, 0);
    const runHours = (Date.now() - this.startTime) / 3600_000;

    return {
      totalFills,
      totalVolumeUsd: totalVolume,
      grossPnl: spreadPnl,
      rebatesPnl: rebates,
      adverseSelectionCost: adverseCost,
      netPnl: spreadPnl + rebates - adverseCost,
      avgEdgeBps: avgEdge,
      fillsPerHour: runHours > 0 ? totalFills / runHours : 0,
      toxicFillPct: toxicPct,
    };
  }

  private printStats(): void {
    const active = this.getStats(true);
    const all = this.getStats(false);
    const runHours = (Date.now() - this.startTime) / 3600_000;

    log.info({
      runHours: runHours.toFixed(1),
      activeFills: active.totalFills,
      filteredFills: all.totalFills - active.totalFills,
      fillsPerHour: active.fillsPerHour.toFixed(1),
      volumeUsd: active.totalVolumeUsd.toFixed(0),
      spreadPnl: active.grossPnl.toFixed(4),
      rebates: active.rebatesPnl.toFixed(4),
      adverseCost: active.adverseSelectionCost.toFixed(4),
      netPnl: active.netPnl.toFixed(4),
      avgEdgeBps: active.avgEdgeBps.toFixed(2),
      toxicPct: (active.toxicFillPct * 100).toFixed(1) + '%',
      unfilteredNetPnl: all.netPnl.toFixed(4),
      unfilteredToxicPct: (all.toxicFillPct * 100).toFixed(1) + '%',
    }, 'Paper MM stats');

    // Per-asset breakdown
    for (const [asset, pos] of this.positions) {
      if (pos.fills === 0) continue;
      const assetFills = this.fills.filter(f => f.asset === asset);
      const vol = assetFills.reduce((s, f) => s + f.notional, 0);
      const toxic = assetFills.filter(f => (f.adverseSelectionBps || 0) > 0).length;
      const checked = assetFills.filter(f => f.adverseSelectionBps !== undefined).length;
      log.info({
        asset,
        fills: pos.fills,
        netQty: pos.netQty.toFixed(4),
        realizedPnl: pos.realizedPnl.toFixed(4),
        volume: vol.toFixed(0),
        toxicPct: checked > 0 ? ((toxic / checked * 100).toFixed(1) + '%') : 'n/a',
      }, 'Asset stats');
    }
  }

  private async persist(): Promise<void> {
    if (this.fills.length === 0) return;

    const stats = this.getStats();
    try {
      await this.pool.query(
        `INSERT INTO mm_paper_stats (timestamp, run_hours, total_fills, total_volume_usd,
          spread_pnl, rebates_pnl, adverse_cost, net_pnl, avg_edge_bps, fills_per_hour, toxic_pct)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT DO NOTHING`,
        [
          Date.now(),
          (Date.now() - this.startTime) / 3600_000,
          stats.totalFills,
          stats.totalVolumeUsd,
          stats.grossPnl,
          stats.rebatesPnl,
          stats.adverseSelectionCost,
          stats.netPnl,
          stats.avgEdgeBps,
          stats.fillsPerHour,
          stats.toxicFillPct,
        ]
      );
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to persist MM stats');
    }

    // Persist fills
    const unpersisted = this.fills.filter(f => f.adverseSelectionBps !== undefined);
    if (unpersisted.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const f of unpersisted) {
      placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6}, $${idx+7}, $${idx+8})`);
      values.push(f.timestamp, f.asset, f.side, f.price, f.notional, f.edgeBps, f.adverseSelectionBps, f.midAtFill, f.filtered);
      idx += 9;
    }

    try {
      await this.pool.query(
        `INSERT INTO mm_paper_fills (timestamp, asset, side, price, notional, edge_bps, adverse_bps, mid_at_fill, filtered)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT DO NOTHING`,
        values
      );
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to persist MM fills');
    }
  }
}
