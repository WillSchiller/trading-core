import type { Pool } from 'pg';
import { createChildLogger } from '../../utils/logger.js';
import { PMMBookFeed } from './book-feed.js';
import { computeQuote, updateLogitVol, type LogitVolState } from './quoter.js';
import { PMMPersistence } from './persistence.js';
import type {
  PMMConfig, PMMFill, PMMPosition, PMMBookSnapshot, PMMStats, PMMActiveMarket, PMMMarket,
} from './types.js';

const log = createChildLogger({ component: 'pmm-paper' });

const ADVERSE_CHECK_MS = 60_000;
const STATS_INTERVAL_MS = 300_000;
const PERSIST_INTERVAL_MS = 60_000;
const OFI_WINDOW_MS = 60_000;
const VPIN_BUCKET_USD = 500;
const VPIN_LOOKBACK = 50;

interface TradeRecord {
  time: number;
  side: 'BUY' | 'SELL';
  vol: number;
}

interface VPINState {
  currentBucket: { buyVol: number; sellVol: number; totalVol: number };
  bucketHistory: number[];
}

export class PMMPaperMM {
  private config: PMMConfig;
  private bookFeed: PMMBookFeed;
  private persistence: PMMPersistence;

  private positions: Map<string, PMMPosition> = new Map(); // tokenId -> position
  private fills: PMMFill[] = [];
  private pendingAdverseChecks: Array<{ fill: PMMFill; checkAt: number }> = [];
  private lastPersistedFillIdx = 0;

  private volStates: Map<string, LogitVolState> = new Map();
  private tradeFlow: Map<string, TradeRecord[]> = new Map();
  private vpinState: Map<string, VPINState> = new Map();

  private activeMarkets: Map<string, PMMActiveMarket> = new Map(); // conditionId -> market
  private marketEndDates: Map<string, number> = new Map(); // conditionId -> endMs

  private statsTimer: NodeJS.Timeout | null = null;
  private adverseTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private requoteTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private startTime = 0;

  constructor(config: PMMConfig, pool: Pool) {
    this.config = config;
    this.bookFeed = new PMMBookFeed(config.clobWsUrl, (book) => this.onBookUpdate(book));
    this.persistence = new PMMPersistence(pool);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.startTime = Date.now();
    this.bookFeed.start();

    this.statsTimer = setInterval(() => this.printStats(), STATS_INTERVAL_MS);
    this.adverseTimer = setInterval(() => this.checkAdverseSelection(), 10_000);
    this.persistTimer = setInterval(() => this.persist(), PERSIST_INTERVAL_MS);
    this.requoteTimer = setInterval(() => this.requoteCycle(), this.config.requoteIntervalMs);

    log.info({
      paperMode: true,
      posSize: this.config.positionSizeUsd,
      maxInv: this.config.maxInventoryUsd,
      minSpreadCents: this.config.minSpreadCents,
      gamma: this.config.gamma,
    }, 'PMM paper mode started');
  }

  stop(): void {
    this.stopping = true;
    this.bookFeed.stop();
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.adverseTimer) clearInterval(this.adverseTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    if (this.requoteTimer) clearInterval(this.requoteTimer);
    this.printStats();
    this.persist();
  }

  async addMarket(market: PMMMarket): Promise<void> {
    if (this.activeMarkets.has(market.conditionId)) return;

    const activeMarket: PMMActiveMarket = {
      conditionId: market.conditionId,
      question: market.question,
      slug: market.slug,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      midPrice: market.midPrice,
      volume24h: market.volume24h,
      liquidity: market.liquidity,
      endDate: market.endDate,
      score: market.score,
      startedAt: Date.now(),
    };

    this.activeMarkets.set(market.conditionId, activeMarket);
    this.marketEndDates.set(market.conditionId, new Date(market.endDate).getTime());

    // Init state for Yes token
    this.initTokenState(market.yesTokenId, market.conditionId, market);
    // Subscribe to Yes token book (No derived from Yes)
    this.bookFeed.subscribe(market.yesTokenId, market.conditionId);

    await this.persistence.upsertActiveMarket(activeMarket);

    log.info({
      conditionId: market.conditionId,
      slug: market.slug.slice(0, 40),
      mid: market.midPrice.toFixed(2),
      vol24h: market.volume24h.toFixed(0),
    }, 'Market added to PMM');
  }

  async removeMarket(conditionId: string): Promise<void> {
    const market = this.activeMarkets.get(conditionId);
    if (!market) return;

    this.bookFeed.unsubscribe(market.yesTokenId);
    this.positions.delete(market.yesTokenId);
    this.volStates.delete(market.yesTokenId);
    this.tradeFlow.delete(market.yesTokenId);
    this.vpinState.delete(market.yesTokenId);
    this.activeMarkets.delete(conditionId);
    this.marketEndDates.delete(conditionId);

    await this.persistence.removeActiveMarket(conditionId);

    log.info({ conditionId, slug: market.slug.slice(0, 40) }, 'Market removed from PMM');
  }

  getActiveMarketCount(): number {
    return this.activeMarkets.size;
  }

  private initTokenState(tokenId: string, conditionId: string, market: PMMMarket): void {
    this.volStates.set(tokenId, { ewmaVar: 0.01, lastLogitMid: null, lastUpdateMs: 0 });
    this.tradeFlow.set(tokenId, []);
    this.vpinState.set(tokenId, {
      currentBucket: { buyVol: 0, sellVol: 0, totalVol: 0 },
      bucketHistory: [],
    });
    this.positions.set(tokenId, {
      conditionId,
      tokenId,
      outcome: 'Yes',
      question: market.question,
      netShares: 0,
      avgEntry: 0,
      realizedPnl: 0,
      fills: 0,
      lastFillAt: 0,
    });
  }

  // --- Book update: track logit vol ---

  private onBookUpdate(book: PMMBookSnapshot): void {
    const volState = this.volStates.get(book.tokenId);
    if (!volState) return;
    updateLogitVol(volState, book.midPrice, Date.now());
  }

  // --- Requote cycle: simulate fills against current book ---

  private requoteCycle(): void {
    if (this.stopping) return;
    const now = Date.now();

    for (const [conditionId, market] of this.activeMarkets) {
      // Check if we should exit before resolution
      const endMs = this.marketEndDates.get(conditionId) || 0;
      const hoursLeft = (endMs - now) / 3600_000;
      if (hoursLeft < this.config.exitBeforeResolutionH) {
        this.removeMarket(conditionId).catch(e => log.error({ err: e }, 'Remove market error'));
        continue;
      }

      const tokenId = market.yesTokenId;
      const book = this.bookFeed.getBook(tokenId);
      if (!book) continue;

      const volState = this.volStates.get(tokenId);
      if (!volState) continue;
      const position = this.positions.get(tokenId);

      const quote = computeQuote(book, this.config, position, volState, endMs, now);
      if (!quote) continue;

      // Simulate fills: check if market price would fill our quotes
      this.simulateFills(book, quote, tokenId, conditionId);
    }
  }

  private simulateFills(
    book: PMMBookSnapshot,
    quote: { bidPrice: number; askPrice: number; midPrice: number; ewmaVol: number },
    tokenId: string,
    conditionId: string,
  ): void {
    const pos = this.positions.get(tokenId);
    if (!pos) return;

    const invUsd = Math.abs(pos.netShares * (pos.avgEntry || book.midPrice));
    if (invUsd >= this.config.maxInventoryUsd) return;

    const ofi = this.getOFI(tokenId);
    const vpin = this.getVPIN(tokenId);
    const bookImb = this.getBookImbalance(book);

    // Check if best ask <= our bid (we can buy)
    if (book.bestAsk <= quote.bidPrice && book.asks.length > 0) {
      const levelSize = book.asks[0].size;
      if (levelSize <= 0) return;
      const fillSize = Math.min(this.config.positionSizeUsd / book.bestAsk, levelSize * 0.3);
      const notional = fillSize * book.bestAsk;
      const edgeCents = (book.midPrice - book.bestAsk) * 100;

      const { skip, reason } = this.shouldSkip(tokenId, 'BUY');

      this.recordFill({
        conditionId, tokenId, side: 'BUY',
        price: book.bestAsk, size: fillSize, notionalUsd: notional,
        timestamp: Date.now(), midAtFill: book.midPrice, edgeCents,
        ofi, vpin, ewmaVol: quote.ewmaVol, bookImbalance: bookImb,
        skipped: skip, skipReason: reason,
      });
    }

    // Check if best bid >= our ask (we can sell)
    if (book.bestBid >= quote.askPrice && book.bids.length > 0) {
      const levelSize = book.bids[0].size;
      if (levelSize <= 0) return;
      const fillSize = Math.min(this.config.positionSizeUsd / book.bestBid, levelSize * 0.3);
      const notional = fillSize * book.bestBid;
      const edgeCents = (book.bestBid - book.midPrice) * 100;

      const { skip, reason } = this.shouldSkip(tokenId, 'SELL');

      this.recordFill({
        conditionId, tokenId, side: 'SELL',
        price: book.bestBid, size: fillSize, notionalUsd: notional,
        timestamp: Date.now(), midAtFill: book.midPrice, edgeCents,
        ofi, vpin, ewmaVol: quote.ewmaVol, bookImbalance: bookImb,
        skipped: skip, skipReason: reason,
      });
    }
  }

  private recordFill(fill: PMMFill): void {
    this.fills.push(fill);
    this.pendingAdverseChecks.push({ fill, checkAt: Date.now() + ADVERSE_CHECK_MS });

    // Update trade flow for OFI/VPIN
    this.recordTradeFlow(fill.tokenId, fill.side, fill.notionalUsd);

    if (fill.skipped) {
      log.debug({
        tokenId: fill.tokenId.slice(0, 8),
        side: fill.side,
        edge: fill.edgeCents.toFixed(2),
        reason: fill.skipReason,
      }, 'PMM fill skipped');
      return;
    }

    const pos = this.positions.get(fill.tokenId);
    if (!pos) return;

    const signedQty = fill.side === 'BUY' ? fill.size : -fill.size;
    const oldQty = pos.netShares;
    pos.netShares += signedQty;
    pos.fills++;
    pos.lastFillAt = fill.timestamp;

    // Realize PnL on position reduction
    if ((oldQty > 0 && signedQty < 0) || (oldQty < 0 && signedQty > 0)) {
      const closedQty = Math.min(Math.abs(oldQty), Math.abs(signedQty));
      const pnl = fill.side === 'SELL'
        ? (fill.price - pos.avgEntry) * closedQty
        : (pos.avgEntry - fill.price) * closedQty;
      pos.realizedPnl += pnl;
    }

    if (Math.abs(pos.netShares) > Math.abs(oldQty)) {
      pos.avgEntry = fill.price;
    }

    log.info({
      conditionId: fill.conditionId.slice(0, 8),
      side: fill.side,
      price: fill.price.toFixed(3),
      notional: fill.notionalUsd.toFixed(2),
      edgeCents: fill.edgeCents.toFixed(2),
      netShares: pos.netShares.toFixed(1),
      realizedPnl: pos.realizedPnl.toFixed(4),
    }, 'PMM paper fill');
  }

  // --- Adaptive filters ---

  private getOFI(tokenId: string): number {
    const flows = this.tradeFlow.get(tokenId);
    if (!flows || flows.length === 0) return 0;
    const cutoff = Date.now() - OFI_WINDOW_MS;
    let buyVol = 0, sellVol = 0;
    for (const f of flows) {
      if (f.time >= cutoff) {
        if (f.side === 'BUY') buyVol += f.vol; else sellVol += f.vol;
      }
    }
    const total = buyVol + sellVol;
    return total > 0 ? (buyVol - sellVol) / total : 0;
  }

  private getVPIN(tokenId: string): number {
    const state = this.vpinState.get(tokenId);
    if (!state || state.bucketHistory.length === 0) return 0;
    const n = Math.min(state.bucketHistory.length, VPIN_LOOKBACK);
    const recent = state.bucketHistory.slice(-n);
    return recent.reduce((s, v) => s + v, 0) / n;
  }

  private getBookImbalance(book: PMMBookSnapshot): number {
    const bidVol = book.bids.slice(0, 3).reduce((s, l) => s + l.size * l.price, 0);
    const askVol = book.asks.slice(0, 3).reduce((s, l) => s + l.size * l.price, 0);
    const total = bidVol + askVol;
    return total > 0 ? (bidVol - askVol) / total : 0;
  }

  private shouldSkip(tokenId: string, side: 'BUY' | 'SELL'): { skip: boolean; reason: string } {
    const ofi = this.getOFI(tokenId);
    const vpin = this.getVPIN(tokenId);

    if (side === 'SELL' && ofi > 0.6) return { skip: true, reason: 'ofi_buy_pressure' };
    if (side === 'BUY' && ofi < -0.6) return { skip: true, reason: 'ofi_sell_pressure' };
    if (vpin > 0.7) return { skip: true, reason: 'vpin_high' };

    return { skip: false, reason: '' };
  }

  private recordTradeFlow(tokenId: string, side: 'BUY' | 'SELL', volUsd: number): void {
    const now = Date.now();
    const flows = this.tradeFlow.get(tokenId);
    if (!flows) return;
    flows.push({ time: now, side, vol: volUsd });
    const cutoff = now - 300_000;
    while (flows.length > 0 && flows[0].time < cutoff) flows.shift();

    const state = this.vpinState.get(tokenId);
    if (!state) return;
    const bucket = state.currentBucket;
    if (side === 'BUY') bucket.buyVol += volUsd; else bucket.sellVol += volUsd;
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

  // --- Adverse selection ---

  private checkAdverseSelection(): void {
    const now = Date.now();
    const remaining: typeof this.pendingAdverseChecks = [];

    for (const { fill, checkAt } of this.pendingAdverseChecks) {
      if (now < checkAt) {
        remaining.push({ fill, checkAt });
        continue;
      }

      const book = this.bookFeed.getBook(fill.tokenId);
      if (!book) {
        remaining.push({ fill, checkAt: checkAt + 10_000 });
        continue;
      }

      const currentMid = book.midPrice;
      if (fill.side === 'BUY') {
        fill.adverseSelectionCents = (fill.midAtFill - currentMid) * 100;
      } else {
        fill.adverseSelectionCents = (currentMid - fill.midAtFill) * 100;
      }
    }

    this.pendingAdverseChecks = remaining;
  }

  // --- Stats ---

  private getStats(): PMMStats {
    const activeFills = this.fills.filter(f => !f.skipped);
    const completed = activeFills.filter(f => f.adverseSelectionCents !== undefined);
    const totalFills = activeFills.length;
    const totalVolume = activeFills.reduce((sum, f) => sum + f.notionalUsd, 0);

    const avgEdge = totalFills > 0
      ? activeFills.reduce((sum, f) => sum + f.edgeCents, 0) / totalFills
      : 0;

    const adverseCost = completed.reduce((sum, f) => {
      const adv = f.adverseSelectionCents || 0;
      return sum + (adv > 0 ? adv * f.notionalUsd / 100 : 0);
    }, 0);

    const toxicFills = completed.filter(f => (f.adverseSelectionCents || 0) > 0).length;
    const toxicPct = completed.length > 0 ? toxicFills / completed.length : 0;

    const spreadPnl = activeFills.reduce((sum, f) => sum + f.edgeCents * f.notionalUsd / 100, 0);
    const runHours = (Date.now() - this.startTime) / 3600_000;

    return {
      totalFills,
      totalVolumeUsd: totalVolume,
      spreadPnl,
      adverseCost,
      netPnl: spreadPnl - adverseCost,
      avgEdgeCents: avgEdge,
      fillsPerHour: runHours > 0 ? totalFills / runHours : 0,
      toxicFillPct: toxicPct,
      marketsActive: this.activeMarkets.size,
    };
  }

  private printStats(): void {
    const stats = this.getStats();
    const runHours = (Date.now() - this.startTime) / 3600_000;
    const skipped = this.fills.filter(f => f.skipped).length;

    log.info({
      runHours: runHours.toFixed(1),
      markets: stats.marketsActive,
      fills: stats.totalFills,
      skipped,
      volumeUsd: stats.totalVolumeUsd.toFixed(0),
      spreadPnl: stats.spreadPnl.toFixed(4),
      adverseCost: stats.adverseCost.toFixed(4),
      netPnl: stats.netPnl.toFixed(4),
      avgEdgeCents: stats.avgEdgeCents.toFixed(2),
      toxicPct: (stats.toxicFillPct * 100).toFixed(1) + '%',
      fillsPerHour: stats.fillsPerHour.toFixed(1),
    }, 'PMM paper stats');

    for (const [, pos] of this.positions) {
      if (pos.fills === 0) continue;
      log.info({
        conditionId: pos.conditionId.slice(0, 8),
        outcome: pos.outcome,
        fills: pos.fills,
        netShares: pos.netShares.toFixed(1),
        realizedPnl: pos.realizedPnl.toFixed(4),
      }, 'PMM position');
    }
  }

  private async persist(): Promise<void> {
    if (this.fills.length === 0) return;

    const stats = this.getStats();
    const runHours = (Date.now() - this.startTime) / 3600_000;
    await this.persistence.saveStats(stats, runHours);

    const newFills = this.fills.slice(this.lastPersistedFillIdx)
      .filter(f => f.adverseSelectionCents !== undefined && !f.skipped);
    if (newFills.length > 0) {
      await this.persistence.saveFills(newFills);
    }
    this.lastPersistedFillIdx = this.fills.length;
  }
}
