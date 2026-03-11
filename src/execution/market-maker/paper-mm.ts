import WebSocket from 'ws';
import type { Pool } from 'pg';
import { createChildLogger } from '../../utils/logger.js';
import { BookFeed } from './book-feed.js';
import type { MMConfig, MMFill, MMPosition, BookSnapshot, MMStats } from './types.js';

const log = createChildLogger({ component: 'paper-mm' });

const MAKER_REBATE_BPS = 1.0;
const ADVERSE_CHECK_MS = 60_000;
const STATS_INTERVAL_MS = 300_000;
const PERSIST_INTERVAL_MS = 60_000;
const OFI_WINDOW_MS = 60_000;
const VPIN_BUCKET_USD = 5_000;
const VPIN_LOOKBACK = 50;
const VOL_EWMA_ALPHA = 0.06;  // ~30 sample half-life

interface TradeRecord {
  time: number;
  side: 'B' | 'S';
  vol: number;
}

interface VPINState {
  currentBucket: { buyVol: number; sellVol: number; totalVol: number };
  bucketHistory: number[];  // |buyVol - sellVol| / totalVol for each completed bucket
}

export class PaperMarketMaker {
  private config: MMConfig;
  private pool: Pool;
  private bookFeed: BookFeed;
  private tradeWs: WebSocket | null = null;

  private positions: Map<string, MMPosition> = new Map();
  private fills: MMFill[] = [];
  private pendingAdverseChecks: Array<{ fill: MMFill; checkAt: number }> = [];
  private lastPersistedFillIdx = 0;

  private statsTimer: NodeJS.Timeout | null = null;
  private adverseTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private startTime = 0;
  private tradeReconnectAttempts = 0;

  // Adaptive filter state
  private midPriceHistory: Map<string, Array<{ time: number; mid: number }>> = new Map();
  private tradeFlow: Map<string, TradeRecord[]> = new Map();
  private vpinState: Map<string, VPINState> = new Map();
  private ewmaVol: Map<string, number> = new Map();
  private volHistory: number[] = [];  // all assets' vol readings for percentile calc

  constructor(config: MMConfig, pool: Pool) {
    this.config = config;
    this.pool = pool;
    this.bookFeed = new BookFeed(config.assets, (book) => this.onBookUpdate(book));
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.startTime = Date.now();

    for (const asset of this.config.assets) {
      this.positions.set(asset, {
        asset, netQty: 0, netNotional: 0, avgEntryPrice: 0, fills: 0, realizedPnl: 0,
      });
      this.tradeFlow.set(asset, []);
      this.vpinState.set(asset, {
        currentBucket: { buyVol: 0, sellVol: 0, totalVol: 0 },
        bucketHistory: [],
      });
    }

    this.bookFeed.start();
    this.connectTradeWs();

    this.statsTimer = setInterval(() => this.printStats(), STATS_INTERVAL_MS);
    this.adverseTimer = setInterval(() => this.checkAdverseSelection(), 10_000);
    this.persistTimer = setInterval(() => this.persist(), PERSIST_INTERVAL_MS);

    log.info({
      assets: this.config.assets,
      posSize: this.config.positionSizeUsd,
      minSpreadBps: this.config.minSpreadBps,
      gamma: this.config.gamma,
      ofiThreshold: this.config.ofiThreshold,
      vpinThreshold: this.config.vpinThreshold,
    }, 'Paper MM started');
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

  // --- Adaptive filter computations ---

  private getOFI(asset: string): number {
    const flows = this.tradeFlow.get(asset);
    if (!flows || flows.length === 0) return 0;
    const cutoff = Date.now() - OFI_WINDOW_MS;
    let buyVol = 0, sellVol = 0;
    for (const f of flows) {
      if (f.time >= cutoff) {
        if (f.side === 'B') buyVol += f.vol; else sellVol += f.vol;
      }
    }
    const total = buyVol + sellVol;
    return total > 0 ? (buyVol - sellVol) / total : 0;
  }

  private getVPIN(asset: string): number {
    const state = this.vpinState.get(asset);
    if (!state || state.bucketHistory.length === 0) return 0;
    const n = Math.min(state.bucketHistory.length, VPIN_LOOKBACK);
    const recent = state.bucketHistory.slice(-n);
    return recent.reduce((s, v) => s + v, 0) / n;
  }

  private getBookImbalance(book: BookSnapshot): number {
    const bidVol = book.bids.slice(0, 3).reduce((s, l) => s + l.sz * l.px, 0);
    const askVol = book.asks.slice(0, 3).reduce((s, l) => s + l.sz * l.px, 0);
    const total = bidVol + askVol;
    return total > 0 ? (bidVol - askVol) / total : 0;
  }

  private getVolPercentile(vol: number): number {
    if (this.volHistory.length < 10) return 50;
    const sorted = [...this.volHistory].sort((a, b) => a - b);
    let rank = 0;
    for (const v of sorted) { if (v <= vol) rank++; else break; }
    return (rank / sorted.length) * 100;
  }

  private recordTradeFlow(asset: string, side: 'B' | 'S', volUsd: number): void {
    const now = Date.now();
    const flows = this.tradeFlow.get(asset)!;
    flows.push({ time: now, side, vol: volUsd });
    // Trim to 5 min
    const cutoff = now - 300_000;
    while (flows.length > 0 && flows[0].time < cutoff) flows.shift();

    // Update VPIN bucket
    const state = this.vpinState.get(asset)!;
    const bucket = state.currentBucket;
    if (side === 'B') bucket.buyVol += volUsd; else bucket.sellVol += volUsd;
    bucket.totalVol += volUsd;

    if (bucket.totalVol >= VPIN_BUCKET_USD) {
      const imbalance = Math.abs(bucket.buyVol - bucket.sellVol) / bucket.totalVol;
      state.bucketHistory.push(imbalance);
      if (state.bucketHistory.length > VPIN_LOOKBACK * 2) {
        state.bucketHistory.splice(0, state.bucketHistory.length - VPIN_LOOKBACK);
      }
      state.currentBucket = { buyVol: 0, sellVol: 0, totalVol: 0 };
    }
  }

  // --- Book update: track mid-price history + EWMA vol ---

  private onBookUpdate(book: BookSnapshot): void {
    let history = this.midPriceHistory.get(book.asset);
    if (!history) {
      history = [];
      this.midPriceHistory.set(book.asset, history);
    }

    // Compute return for EWMA vol
    if (history.length > 0) {
      const prev = history[history.length - 1];
      const dt = (Date.now() - prev.time) / 1000;
      if (dt > 0.1 && dt < 60) {
        const ret = Math.log(book.midPrice / prev.mid);
        const retPerSec = (ret * ret) / dt;
        const prevVol = this.ewmaVol.get(book.asset) || retPerSec;
        const newVol = VOL_EWMA_ALPHA * retPerSec + (1 - VOL_EWMA_ALPHA) * prevVol;
        this.ewmaVol.set(book.asset, newVol);
        this.volHistory.push(newVol);
        if (this.volHistory.length > 5000) this.volHistory.splice(0, 1000);
      }
    }

    history.push({ time: Date.now(), mid: book.midPrice });
    const cutoff = Date.now() - 600_000;
    while (history.length > 0 && history[0].time < cutoff) history.shift();
  }

  // --- Avellaneda-Stoikov theoretical quote ---

  private computeASQuote(asset: string, book: BookSnapshot): { bid: number; ask: number; halfSpread: number } {
    const pos = this.positions.get(asset)!;
    const mid = book.midPrice;
    const gamma = this.config.gamma;

    // sigma^2 as annualized vol from EWMA (per-second variance * seconds in day)
    const varPerSec = this.ewmaVol.get(asset) || 0;
    const sigma2 = varPerSec;

    // Inventory in units of position size
    const q = pos.netNotional / this.config.positionSizeUsd;

    // tau = time horizon (~300s for short-term MM)
    const tau = 300;

    // Reservation price: r = mid - q * gamma * sigma^2 * tau
    const reservation = mid * (1 - q * gamma * sigma2 * tau);

    // Half-spread: at minimum our configured minSpreadBps
    // A-S optimal: gamma * sigma^2 * tau + (2/gamma) * ln(1 + gamma/kappa)
    // Simplified: scale spread by volatility, with floor
    const volSpreadBps = Math.sqrt(sigma2 * tau) * 10000;
    const halfSpreadBps = Math.max(this.config.minSpreadBps / 2, volSpreadBps);

    const halfSpread = mid * halfSpreadBps / 10000;
    const bid = reservation - halfSpread;
    const ask = reservation + halfSpread;

    return { bid, ask, halfSpread };
  }

  // --- Adaptive filter: should we skip this fill? ---

  private shouldSkipFill(asset: string, side: 'buy' | 'sell', _book: BookSnapshot): { skip: boolean; reason: string } {
    const ofi = this.getOFI(asset);
    const vpin = this.getVPIN(asset);
    const vol = this.ewmaVol.get(asset) || 0;
    const volPct = this.getVolPercentile(vol);

    // OFI filter: don't sell into strong buying flow, don't buy into strong selling flow
    if (side === 'sell' && ofi > this.config.ofiThreshold) {
      return { skip: true, reason: 'ofi_buy_pressure' };
    }
    if (side === 'buy' && ofi < -this.config.ofiThreshold) {
      return { skip: true, reason: 'ofi_sell_pressure' };
    }

    // VPIN filter: high toxicity probability
    if (vpin > this.config.vpinThreshold) {
      return { skip: true, reason: 'vpin_high' };
    }

    // Vol filter: extreme volatility
    if (volPct > this.config.volCutoffPct) {
      return { skip: true, reason: 'vol_extreme' };
    }

    return { skip: false, reason: '' };
  }

  // --- Trade handling ---

  private handleTrades(trades: Array<{ coin: string; side: string; px: string; sz: string; time: number }>): void {
    if (!Array.isArray(trades)) return;

    for (const t of trades) {
      const asset = t.coin;
      if (!this.config.assets.includes(asset)) continue;

      const tradePx = parseFloat(t.px);
      const tradeSz = parseFloat(t.sz);
      const tradeNotional = tradePx * tradeSz;
      const isBuy = t.side === 'B';

      // Record trade flow for OFI + VPIN
      this.recordTradeFlow(asset, isBuy ? 'B' : 'S', tradeNotional);

      const book = this.bookFeed.getBook(asset);
      if (!book) continue;

      const pos = this.positions.get(asset);
      if (!pos) continue;

      const inventoryUsd = Math.abs(pos.netNotional);
      if (inventoryUsd >= this.config.maxInventoryUsd) continue;

      // Avellaneda-Stoikov theoretical quote
      const { bid: ourBid, ask: ourAsk } = this.computeASQuote(asset, book);

      // Simulate fill
      const ourSizeUsd = this.config.positionSizeUsd;

      // Gather context at fill time
      const ofi = this.getOFI(asset);
      const vpin = this.getVPIN(asset);
      const vol = this.ewmaVol.get(asset) || 0;
      const bookImb = this.getBookImbalance(book);

      if (isBuy && tradePx >= ourAsk) {
        const levelTotal = (book.asks[0]?.sz || 0) * tradePx;
        if (levelTotal <= 0) continue;
        const fillProb = Math.min(1, ourSizeUsd / (levelTotal + ourSizeUsd));
        if (tradeNotional < 50 || Math.random() > fillProb) continue;

        const fillSz = Math.min(ourSizeUsd / tradePx, tradeSz * fillProb);
        const fillNotional = fillSz * ourAsk;
        const edgeBps = Math.abs(ourAsk - book.midPrice) / book.midPrice * 10000;

        // Check adaptive filter
        const { skip, reason } = this.shouldSkipFill(asset, 'sell', book);

        this.recordFill(asset, 'sell', ourAsk, fillSz, fillNotional, book.midPrice, edgeBps,
          { ofi, vpin, ewmaVol: vol, bookImbalance: bookImb, skipped: skip, skipReason: reason });

      } else if (!isBuy && tradePx <= ourBid) {
        const levelTotal = (book.bids[0]?.sz || 0) * tradePx;
        if (levelTotal <= 0) continue;
        const fillProb = Math.min(1, ourSizeUsd / (levelTotal + ourSizeUsd));
        if (tradeNotional < 50 || Math.random() > fillProb) continue;

        const fillSz = Math.min(ourSizeUsd / tradePx, tradeSz * fillProb);
        const fillNotional = fillSz * ourBid;
        const edgeBps = Math.abs(book.midPrice - ourBid) / book.midPrice * 10000;

        const { skip, reason } = this.shouldSkipFill(asset, 'buy', book);

        this.recordFill(asset, 'buy', ourBid, fillSz, fillNotional, book.midPrice, edgeBps,
          { ofi, vpin, ewmaVol: vol, bookImbalance: bookImb, skipped: skip, skipReason: reason });
      }
    }
  }

  private recordFill(
    asset: string, side: 'buy' | 'sell', price: number, size: number,
    notional: number, midAtFill: number, edgeBps: number,
    context: { ofi: number; vpin: number; ewmaVol: number; bookImbalance: number; skipped: boolean; skipReason: string },
  ): void {
    const fill: MMFill = {
      asset, side, price, size, notional,
      timestamp: Date.now(), midAtFill, edgeBps,
      filtered: false,
      ofi: context.ofi,
      vpin: context.vpin,
      ewmaVol: context.ewmaVol,
      bookImbalance: context.bookImbalance,
      skipped: context.skipped,
      skipReason: context.skipReason,
    };

    this.fills.push(fill);
    this.pendingAdverseChecks.push({ fill, checkAt: Date.now() + ADVERSE_CHECK_MS });

    if (context.skipped) {
      log.debug({
        asset, side, edgeBps: edgeBps.toFixed(2),
        reason: context.skipReason, ofi: context.ofi.toFixed(3), vpin: context.vpin.toFixed(3),
      }, 'Fill skipped by adaptive filter (shadow)');
      return;
    }

    // Update position
    const pos = this.positions.get(asset)!;
    const signedQty = side === 'buy' ? size : -size;
    const oldQty = pos.netQty;
    pos.netQty += signedQty;
    pos.netNotional = pos.netQty * price;
    pos.fills++;

    if ((oldQty > 0 && signedQty < 0) || (oldQty < 0 && signedQty > 0)) {
      const closedQty = Math.min(Math.abs(oldQty), Math.abs(signedQty));
      const entryPx = pos.avgEntryPrice || price;
      const pnl = side === 'sell'
        ? (price - entryPx) * closedQty
        : (entryPx - price) * closedQty;
      pos.realizedPnl += pnl;
    }

    if (Math.abs(pos.netQty) > Math.abs(oldQty)) {
      pos.avgEntryPrice = price;
    }

    log.info({
      asset, side, price: price.toFixed(6), notional: notional.toFixed(2),
      edgeBps: edgeBps.toFixed(2), ofi: context.ofi.toFixed(3), vpin: context.vpin.toFixed(3),
      netQty: pos.netQty.toFixed(4),
    }, 'Paper MM fill');
  }

  private checkAdverseSelection(): void {
    const now = Date.now();
    const remaining: typeof this.pendingAdverseChecks = [];

    for (const { fill, checkAt } of this.pendingAdverseChecks) {
      if (now < checkAt) {
        remaining.push({ fill, checkAt });
        continue;
      }

      const history = this.midPriceHistory.get(fill.asset);
      if (!history || history.length === 0) {
        remaining.push({ fill, checkAt: checkAt + 10_000 });
        continue;
      }

      const currentMid = history[history.length - 1].mid;
      fill.priceAfter1m = currentMid;

      if (fill.side === 'buy') {
        fill.adverseSelectionBps = (fill.midAtFill - currentMid) / fill.midAtFill * 10000;
      } else {
        fill.adverseSelectionBps = (currentMid - fill.midAtFill) / fill.midAtFill * 10000;
      }
    }

    this.pendingAdverseChecks = remaining;
  }

  private getStats(includeSkipped = false): MMStats {
    const fills = includeSkipped ? this.fills : this.fills.filter(f => !f.skipped);
    const completed = fills.filter(f => f.adverseSelectionBps !== undefined);
    const totalFills = fills.length;
    const totalVolume = fills.reduce((sum, f) => sum + f.notional, 0);

    const rebates = totalFills * MAKER_REBATE_BPS * this.config.positionSizeUsd / 10000;
    const avgEdge = totalFills > 0
      ? fills.reduce((sum, f) => sum + f.edgeBps, 0) / totalFills
      : 0;

    const adverseCost = completed.reduce((sum, f) => {
      const adv = f.adverseSelectionBps || 0;
      return sum + (adv > 0 ? adv * f.notional / 10000 : 0);
    }, 0);

    const toxicFills = completed.filter(f => (f.adverseSelectionBps || 0) > 0).length;
    const toxicPct = completed.length > 0 ? toxicFills / completed.length : 0;

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
    const active = this.getStats(false);
    const all = this.getStats(true);
    const runHours = (Date.now() - this.startTime) / 3600_000;
    const skippedCount = this.fills.filter(f => f.skipped).length;

    log.info({
      runHours: runHours.toFixed(1),
      activeFills: active.totalFills,
      skippedFills: skippedCount,
      fillsPerHour: active.fillsPerHour.toFixed(1),
      volumeUsd: active.totalVolumeUsd.toFixed(0),
      spreadPnl: active.grossPnl.toFixed(4),
      rebates: active.rebatesPnl.toFixed(4),
      adverseCost: active.adverseSelectionCost.toFixed(4),
      netPnl: active.netPnl.toFixed(4),
      avgEdgeBps: active.avgEdgeBps.toFixed(2),
      toxicPct: (active.toxicFillPct * 100).toFixed(1) + '%',
      allNetPnl: all.netPnl.toFixed(4),
      allToxicPct: (all.toxicFillPct * 100).toFixed(1) + '%',
    }, 'Paper MM stats');

    for (const [asset, pos] of this.positions) {
      if (pos.fills === 0) continue;
      const assetFills = this.fills.filter(f => f.asset === asset && !f.skipped);
      const vol = assetFills.reduce((s, f) => s + f.notional, 0);
      const checked = assetFills.filter(f => f.adverseSelectionBps !== undefined);
      const toxic = checked.filter(f => (f.adverseSelectionBps || 0) > 0).length;
      log.info({
        asset, fills: pos.fills,
        netQty: pos.netQty.toFixed(4),
        realizedPnl: pos.realizedPnl.toFixed(4),
        volume: vol.toFixed(0),
        toxicPct: checked.length > 0 ? ((toxic / checked.length * 100).toFixed(1) + '%') : 'n/a',
      }, 'Asset stats');
    }
  }

  private async persist(): Promise<void> {
    if (this.fills.length === 0) return;

    // Stats snapshot
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

    // Only persist fills that are new AND have adverse selection computed
    const newFills = this.fills.slice(this.lastPersistedFillIdx)
      .filter(f => f.adverseSelectionBps !== undefined);
    if (newFills.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const f of newFills) {
      placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6}, $${idx+7}, $${idx+8}, $${idx+9}, $${idx+10}, $${idx+11}, $${idx+12}, $${idx+13})`);
      values.push(
        f.timestamp, f.asset, f.side, f.price, f.notional, f.edgeBps,
        f.adverseSelectionBps, f.midAtFill,
        f.ofi ?? null, f.vpin ?? null, f.ewmaVol ?? null, f.bookImbalance ?? null,
        f.skipped ?? false, f.skipReason ?? null,
      );
      idx += 14;
    }

    try {
      await this.pool.query(
        `INSERT INTO mm_paper_fills (timestamp, asset, side, price, notional, edge_bps, adverse_bps, mid_at_fill,
          ofi, vpin, ewma_vol, book_imbalance, skipped, skip_reason)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (timestamp, asset, side, price) DO NOTHING`,
        values
      );
      // Move the cursor past ALL fills we've examined (including those without adverse yet)
      this.lastPersistedFillIdx = this.fills.length;
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to persist MM fills');
    }
  }
}
