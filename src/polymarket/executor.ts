import { createChildLogger } from '../utils/logger.js';
import { PolymarketPersistence } from './persistence.js';
import type { PolymarketConfig, TrackedTrader, TraderActivity, CopyTrade, CopyPosition } from './types.js';

const log = createChildLogger({ component: 'pm-executor' });

interface ClobClient {
  createOrder(params: {
    tokenID: string;
    price: number;
    side: string;
    size: number;
    feeRateBps?: number;
    nonce?: number;
    expiration?: number;
  }): Promise<{ orderID: string; status: string }>;

  getTickSize(tokenId: string): Promise<number>;
}

export class CopyExecutor {
  private clobClient: ClobClient | null = null;
  private positions = new Map<string, CopyPosition & { id: number }>();

  constructor(
    private readonly config: PolymarketConfig,
    private readonly persistence: PolymarketPersistence,
  ) {}

  async start(): Promise<void> {
    if (!this.config.paperMode && this.config.privateKey) {
      this.clobClient = await this.initClobClient();
      log.info('CLOB client initialized for live trading');
    } else {
      log.info('Running in paper mode — no CLOB client');
    }

    const openPositions = await this.persistence.getOpenPositions();
    for (const pos of openPositions) {
      this.positions.set(pos.tokenId, pos);
    }
    log.info({ positions: this.positions.size }, 'Loaded open positions');
  }

  async executeCopy(trader: TrackedTrader, activity: TraderActivity): Promise<void> {
    const proportionalSize = (activity.size / Math.max(trader.bankrollEstimate, 1)) * this.config.bankrollUsd;
    const clampedSize = Math.min(proportionalSize, this.config.riskLimits.maxPositionUsd);
    const sizeUsd = Math.max(1, Math.round(clampedSize * 100) / 100);

    const size = sizeUsd / Math.max(activity.price, 0.001);

    log.info({
      trader: trader.alias,
      market: activity.marketSlug,
      outcome: activity.outcome,
      traderSize: activity.size,
      ourSize: sizeUsd,
      price: activity.price,
    }, 'Executing copy trade');

    if (this.config.paperMode) {
      await this.executePaper(trader, activity, size, sizeUsd);
    } else {
      await this.executeLive(trader, activity, size, sizeUsd);
    }
  }

  private async executePaper(trader: TrackedTrader, activity: TraderActivity, size: number, sizeUsd: number): Promise<void> {
    const midPrice = await this.fetchMidPrice(activity.conditionId, activity.tokenId);
    const fillPrice = (midPrice != null && midPrice > 0) ? midPrice : activity.price;

    const trade: CopyTrade = {
      traderAddress: trader.address,
      conditionId: activity.conditionId,
      tokenId: activity.tokenId,
      side: activity.side,
      size,
      price: fillPrice,
      outcome: activity.outcome,
      marketSlug: activity.marketSlug,
      status: 'paper',
      paper: true,
      fillPrice,
    };

    await this.persistence.saveCopyTrade(trade);
    await this.updatePositionFromTrade(activity, fillPrice, size, true);

    log.info({
      trader: trader.alias,
      market: activity.marketSlug,
      outcome: activity.outcome,
      size: sizeUsd.toFixed(2),
      fillPrice,
    }, 'Paper copy trade executed');
  }

  private async executeLive(trader: TrackedTrader, activity: TraderActivity, size: number, sizeUsd: number): Promise<void> {
    if (!this.clobClient) {
      log.error('CLOB client not initialized');
      return;
    }

    const trade: CopyTrade = {
      traderAddress: trader.address,
      conditionId: activity.conditionId,
      tokenId: activity.tokenId,
      side: activity.side,
      size,
      price: activity.price,
      outcome: activity.outcome,
      marketSlug: activity.marketSlug,
      status: 'pending',
      paper: false,
    };

    const tradeId = await this.persistence.saveCopyTrade(trade);

    try {
      let tickSize = 0.01;
      try {
        tickSize = await this.clobClient.getTickSize(activity.tokenId);
      } catch { /* use default */ }

      const price = this.roundToTick(activity.price, tickSize);

      const result = await this.clobClient.createOrder({
        tokenID: activity.tokenId,
        price,
        side: 'BUY',
        size: Math.round(size * 100) / 100,
      });

      await this.persistence.updateCopyTrade(tradeId, {
        status: 'filled',
        orderId: result.orderID,
        fillPrice: price,
      });

      await this.updatePositionFromTrade(activity, price, size, false);

      log.info({
        orderId: result.orderID,
        trader: trader.alias,
        market: activity.marketSlug,
        size: sizeUsd.toFixed(2),
        price,
      }, 'Live copy trade filled');
    } catch (err) {
      await this.persistence.updateCopyTrade(tradeId, {
        status: 'failed',
        errorMessage: (err as Error).message,
      });
      log.error({ trader: trader.alias, market: activity.marketSlug, error: (err as Error).message }, 'Live copy trade failed');
    }
  }

  private async updatePositionFromTrade(activity: TraderActivity, fillPrice: number, size: number, paper: boolean): Promise<void> {
    const existing = this.positions.get(activity.tokenId);

    if (existing && activity.side === 'BUY') {
      const totalSize = existing.size + size;
      const avgEntry = (existing.avgEntry * existing.size + fillPrice * size) / totalSize;
      await this.persistence.updatePosition(existing.id, { size: totalSize, avgEntry });
      existing.size = totalSize;
      existing.avgEntry = avgEntry;
    } else if (activity.side === 'BUY') {
      const pos: CopyPosition = {
        conditionId: activity.conditionId,
        tokenId: activity.tokenId,
        side: 'BUY',
        outcome: activity.outcome,
        marketSlug: activity.marketSlug,
        marketQuestion: activity.marketQuestion,
        avgEntry: fillPrice,
        size,
        currentPrice: fillPrice,
        unrealizedPnl: 0,
        realizedPnl: 0,
        status: 'open',
        paper,
      };
      const id = await this.persistence.savePosition(pos);
      this.positions.set(activity.tokenId, { ...pos, id });
    }
  }

  async updatePositionPrices(): Promise<void> {
    for (const [tokenId, pos] of this.positions) {
      if (pos.status !== 'open') continue;

      const resolved = await this.checkResolution(pos.conditionId, tokenId, pos.marketSlug);
      if (resolved !== null) {
        const pnl = (resolved - pos.avgEntry) * pos.size;
        await this.persistence.closePosition(pos.id, pnl);
        pos.status = 'closed';
        this.positions.delete(tokenId);
        log.info({ market: pos.marketSlug, outcome: pos.outcome, entry: pos.avgEntry, resolution: resolved, pnl: pnl.toFixed(2) }, 'Position resolved');
        continue;
      }

      const price = await this.fetchMidPrice(pos.conditionId, tokenId, pos.marketSlug);
      if (price === null) continue;

      const unrealizedPnl = (price - pos.avgEntry) * pos.size;
      await this.persistence.updatePosition(pos.id, { currentPrice: price, unrealizedPnl });
      pos.currentPrice = price;
      pos.unrealizedPnl = unrealizedPnl;
    }
  }

  private async checkResolution(conditionId: string, tokenId: string, slug?: string): Promise<number | null> {
    const tryResolve = (data: Array<{ conditionId?: string; outcomePrices?: string; clobTokenIds?: string; closed?: boolean }>): number | null => {
      if (!data.length || !data[0].closed) return null;
      const prices = (JSON.parse(data[0].outcomePrices || '[]') as (string | number)[]).map(Number);
      const tokenIds = JSON.parse(data[0].clobTokenIds || '[]') as string[];
      const idx = tokenIds.indexOf(tokenId);
      return idx >= 0 ? prices[idx] : null;
    };

    try {
      const resp = await fetch(`${this.config.gammaApiUrl}/markets?condition_id=${conditionId}`);
      if (resp.ok) {
        const data = await resp.json() as Array<{ conditionId?: string; outcomePrices?: string; clobTokenIds?: string; closed?: boolean }>;
        if (data.length && data[0].conditionId === conditionId) return tryResolve(data);
      }
    } catch { /* fall through */ }

    if (!slug) return null;
    try {
      const resp = await fetch(`${this.config.gammaApiUrl}/markets?slug=${slug}`);
      if (!resp.ok) return null;
      return tryResolve(await resp.json() as Array<{ conditionId?: string; outcomePrices?: string; clobTokenIds?: string; closed?: boolean }>);
    } catch { return null; }
  }

  getOpenPositions(): (CopyPosition & { id: number })[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'open');
  }

  private async fetchMidPrice(conditionId: string, tokenId: string, slug?: string): Promise<number | null> {
    const tryParse = (data: Array<{ conditionId?: string; outcomePrices?: string; clobTokenIds?: string; closed?: boolean }>): number | null => {
      if (!data.length || data[0].closed) return null;
      const prices = (JSON.parse(data[0].outcomePrices || '[]') as (string | number)[]).map(Number);
      const tokenIds = JSON.parse(data[0].clobTokenIds || '[]') as string[];
      const idx = tokenIds.indexOf(tokenId);
      const price = idx >= 0 ? prices[idx] : prices[0];
      return (price != null && price > 0 && !isNaN(price)) ? price : null;
    };

    try {
      const resp = await fetch(`${this.config.gammaApiUrl}/markets?condition_id=${conditionId}`);
      if (resp.ok) {
        const data = await resp.json() as Array<{ conditionId?: string; outcomePrices?: string; clobTokenIds?: string; closed?: boolean }>;
        if (data.length && data[0].conditionId === conditionId) return tryParse(data);
      }
    } catch { /* fall through */ }

    if (!slug) return null;
    try {
      const resp = await fetch(`${this.config.gammaApiUrl}/markets?slug=${slug}`);
      if (!resp.ok) return null;
      return tryParse(await resp.json() as Array<{ conditionId?: string; outcomePrices?: string; clobTokenIds?: string; closed?: boolean }>);
    } catch { return null; }
  }

  private roundToTick(price: number, tickSize: number): number {
    return Math.round(price / tickSize) * tickSize;
  }

  private async initClobClient(): Promise<ClobClient> {
    try {
      const { ClobClient: Client } = await import('@polymarket/clob-client' as string);
      const creds = this.config.apiKey ? {
        key: this.config.apiKey,
        secret: this.config.apiSecret,
        passphrase: this.config.passphrase,
      } : undefined;
      const client = new Client(
        this.config.clobApiUrl,
        137,
        this.config.privateKey ? { key: this.config.privateKey } : undefined,
        creds,
      );
      return client as unknown as ClobClient;
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to initialize CLOB client');
      throw err;
    }
  }
}
