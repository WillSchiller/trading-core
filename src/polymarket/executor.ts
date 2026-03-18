import { createChildLogger } from '../utils/logger.js';
import { PolymarketPersistence } from './persistence.js';
import type { PolymarketConfig, TrackedTrader, TraderActivity } from './types.js';

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
  }

  async executeCopy(trader: TrackedTrader, activity: TraderActivity): Promise<void> {
    const existing = await this.persistence.getPositionByCondition(activity.conditionId);
    const currentExposure = existing ? existing.size * existing.avgEntry : 0;
    const maxPerMarket = this.config.riskLimits.maxPositionUsd;

    if (currentExposure >= maxPerMarket) {
      log.info({ trader: trader.alias, market: activity.marketSlug, exposure: currentExposure.toFixed(2), max: maxPerMarket }, 'Skipped — market position cap reached');
      return;
    }

    const proportionalSize = (activity.size / Math.max(trader.bankrollEstimate, 1)) * this.config.bankrollUsd;
    const remainingRoom = maxPerMarket - currentExposure;
    const clampedSize = Math.min(proportionalSize, remainingRoom);
    const sizeUsd = Math.max(1, Math.round(clampedSize * 100) / 100);

    const size = sizeUsd / Math.max(activity.price, 0.001);

    log.info({
      trader: trader.alias,
      market: activity.marketSlug,
      outcome: activity.outcome,
      traderSize: activity.size,
      ourSize: sizeUsd,
      price: activity.price,
      existingExposure: currentExposure.toFixed(2),
    }, 'Executing copy trade');

    if (this.config.paperMode) {
      await this.executePaper(trader, activity, size, sizeUsd);
    } else {
      await this.executeLive(trader, activity, size, sizeUsd);
    }
  }

  private async executePaper(trader: TrackedTrader, activity: TraderActivity, _size: number, sizeUsd: number): Promise<void> {
    const midPrice = await this.fetchMidPrice(activity.conditionId, activity.tokenId);
    const fillPrice = (midPrice != null && midPrice > 0) ? midPrice : activity.price;

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

    try {
      let tickSize = 0.01;
      try {
        tickSize = await this.clobClient.getTickSize(activity.tokenId);
      } catch { /* use default */ }

      const price = this.roundToTick(activity.price, tickSize);

      const orderParams = {
        tokenID: activity.tokenId,
        price,
        side: 'BUY',
        size: Math.round(size * 100) / 100,
      };

      let result: { orderID: string; status: string };
      try {
        result = await this.clobClient.createOrder(orderParams);
      } catch (firstErr) {
        log.warn({ error: (firstErr as Error).message }, 'Order failed, retrying in 1s');
        await new Promise(r => setTimeout(r, 1000));
        result = await this.clobClient.createOrder(orderParams);
      }

      log.info({
        orderId: result.orderID,
        trader: trader.alias,
        market: activity.marketSlug,
        size: sizeUsd.toFixed(2),
        price,
      }, 'Live copy trade filled');
    } catch (err) {
      log.error({ trader: trader.alias, market: activity.marketSlug, error: (err as Error).message }, 'Live copy trade failed');
    }
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
