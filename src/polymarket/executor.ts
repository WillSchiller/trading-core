import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createChildLogger } from '../utils/logger.js';
import { PolymarketPersistence } from './persistence.js';
import type { PolymarketConfig, TrackedTrader, TraderActivity } from './types.js';

const log = createChildLogger({ component: 'pm-executor' });

const MAX_SLIPPAGE_CENTS = 3;
const FILL_CHECK_DELAY_MS = 3000;

export class CopyExecutor {
  private clobClient: any = null;
  private Side: any = null;
  private OrderType: any = null;

  constructor(
    private readonly config: PolymarketConfig,
    private readonly persistence: PolymarketPersistence,
  ) {}

  async start(): Promise<void> {
    if (this.config.privateKey) {
      this.clobClient = await this.initClobClient();
      log.info('CLOB client initialized for live execution');
    } else {
      log.info('No private key — live execution disabled');
    }
  }

  isLive(): boolean {
    return this.clobClient !== null;
  }

  async executeLiveOrder(
    liveTradeId: number,
    trader: TrackedTrader,
    activity: TraderActivity,
    sizeUsd: number,
  ): Promise<{ orderId?: string; fillPrice?: number; fillSize?: number; status: string }> {
    if (!this.clobClient) {
      return { status: 'no_client' };
    }

    try {
      const midPrice = await this.fetchMidPrice(activity.conditionId, activity.tokenId);
      const orderPrice = midPrice ?? activity.price;

      const slippage = Math.abs(orderPrice - activity.price);
      if (slippage > MAX_SLIPPAGE_CENTS / 100) {
        log.warn({
          trader: trader.alias,
          market: activity.marketSlug,
          traderPrice: activity.price,
          currentMid: orderPrice,
          slippage: (slippage * 100).toFixed(1) + 'c',
        }, 'Skipped — price moved too far from trader fill');
        await this.persistence.updateLiveTradeExecution(
          liveTradeId, null, null, null, 'skipped_slippage',
        );
        return { status: 'skipped_slippage' };
      }

      const tickSize = '0.01';
      const tick = parseFloat(tickSize);
      const roundedPrice = Math.round(orderPrice / tick) * tick;
      if (sizeUsd < 1) {
        log.warn({ trader: trader.alias, market: activity.marketSlug, sizeUsd }, 'Order below $1 minimum, skipping');
        await this.persistence.updateLiveTradeExecution(liveTradeId, null, null, null, 'skipped_small');
        return { status: 'skipped_small' };
      }

      // Use market order (FOK) — fill immediately or cancel
      const result = await this.clobClient.createAndPostMarketOrder(
        {
          tokenID: activity.tokenId,
          amount: sizeUsd,
          side: this.Side.BUY,
          price: roundedPrice,
        },
        { tickSize, negRisk: activity.negRisk },
        this.OrderType.FOK,
      );

      log.info({ clobResponse: JSON.stringify(result) }, 'CLOB market order response');

      const errorMsg = result?.error || result?.errorMsg;
      if (!result || result.success === false || errorMsg) {
        const status = errorMsg?.includes('fully filled') ? 'unfilled' : 'rejected';
        log.warn({
          trader: trader.alias,
          market: activity.marketSlug,
          error: errorMsg || 'no response',
          status,
        }, `CLOB order ${status}`);
        await this.persistence.updateLiveTradeExecution(
          liveTradeId, null, null, null, status,
        );
        return { status };
      }

      const orderId = result.orderID || result.orderIds?.[0] || result.order_id || null;

      // Wait briefly then check if we actually got a fill
      await new Promise(r => setTimeout(r, FILL_CHECK_DELAY_MS));
      const fill = await this.checkFill(orderId, activity.tokenId);

      if (fill) {
        log.info({
          orderId,
          trader: trader.alias,
          market: activity.marketSlug,
          outcome: activity.outcome,
          sizeUsd: sizeUsd.toFixed(2),
          fillPrice: fill.price,
          fillSize: fill.size,
        }, 'CLOB order FILLED');

        await this.persistence.updateLiveTradeExecution(
          liveTradeId, orderId, fill.price, fill.size, 'filled',
        );
        return { orderId, fillPrice: fill.price, fillSize: fill.size, status: 'filled' };
      }

      // FOK should either fill or cancel — if no fill, it was cancelled
      log.warn({
        orderId,
        trader: trader.alias,
        market: activity.marketSlug,
        orderPrice: roundedPrice,
      }, 'FOK order not filled — cancelled');

      await this.persistence.updateLiveTradeExecution(
        liveTradeId, orderId, null, null, 'unfilled',
      );
      return { orderId, status: 'unfilled' };

    } catch (err) {
      log.error({
        trader: trader.alias,
        market: activity.marketSlug,
        error: (err as Error).message,
      }, 'Live CLOB order failed');
      await this.persistence.updateLiveTradeExecution(
        liveTradeId, null, null, null, 'error',
      );
      return { status: 'error' };
    }
  }

  private async checkFill(orderId: string | null, tokenId: string): Promise<{ price: number; size: number } | null> {
    if (!orderId) return null;
    try {
      const trades = await this.clobClient.getTrades({ asset_id: tokenId });
      if (!trades || !Array.isArray(trades)) return null;
      const myFill = trades.find((t: any) => t.order_id === orderId || t.id === orderId);
      if (myFill) {
        return { price: parseFloat(myFill.price), size: parseFloat(myFill.size) };
      }
      // Also try getOrder directly
      const order = await this.clobClient.getOrder(orderId);
      if (order && parseFloat(order.size_matched) > 0) {
        return { price: parseFloat(order.price), size: parseFloat(order.size_matched) };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async fetchMidPrice(conditionId: string, tokenId: string): Promise<number | null> {
    try {
      const resp = await fetch(`${this.config.gammaApiUrl}/markets?condition_id=${conditionId}`);
      if (!resp.ok) return null;
      const data = await resp.json() as Array<{ outcomePrices?: string; clobTokenIds?: string; closed?: boolean }>;
      if (!data.length || data[0].closed) return null;
      const prices = (JSON.parse(data[0].outcomePrices || '[]') as (string | number)[]).map(Number);
      const tokenIds = JSON.parse(data[0].clobTokenIds || '[]') as string[];
      const idx = tokenIds.indexOf(tokenId);
      const price = idx >= 0 ? prices[idx] : prices[0];
      return (price > 0 && !isNaN(price)) ? price : null;
    } catch { return null; }
  }

  private async initClobClient(): Promise<any> {
    const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client' as string);
    this.Side = Side;
    this.OrderType = OrderType;

    const account = privateKeyToAccount(this.config.privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    const creds = this.config.apiKey ? {
      key: this.config.apiKey,
      secret: this.config.apiSecret!,
      passphrase: this.config.passphrase!,
    } : undefined;

    const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS;
    const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE || '0');

    const client = new ClobClient(
      this.config.clobApiUrl,
      137,
      walletClient,
      creds,
      signatureType,
      funderAddress,
    );

    log.info({
      signer: account.address,
      funder: funderAddress || 'none',
      signatureType,
      hasCreds: !!creds,
    }, 'CLOB client created');

    return client;
  }
}
