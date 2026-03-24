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

      // Try FOK first for instant fill
      const fokResult = await this.clobClient.createAndPostMarketOrder(
        {
          tokenID: activity.tokenId,
          amount: sizeUsd,
          side: this.Side.BUY,
          price: roundedPrice,
        },
        { tickSize, negRisk: activity.negRisk },
        this.OrderType.FOK,
      );

      const fokError = fokResult?.error || fokResult?.errorMsg;
      const fokFilled = fokResult?.success && !fokError;

      if (fokFilled) {
        const orderId = fokResult.orderID || fokResult.orderIds?.[0] || null;
        await new Promise(r => setTimeout(r, FILL_CHECK_DELAY_MS));
        const fill = await this.checkFill(orderId, activity.tokenId);
        if (fill) {
          log.info({ orderId, trader: trader.alias, market: activity.marketSlug, outcome: activity.outcome, sizeUsd: sizeUsd.toFixed(2), fillPrice: fill.price }, 'FOK order FILLED');
          await this.persistence.updateLiveTradeExecution(liveTradeId, orderId, fill.price, fill.size, 'filled');
          return { orderId, fillPrice: fill.price, fillSize: fill.size, status: 'filled' };
        }
      }

      // FOK failed — fall back to GTC limit at ask with 60s timeout
      log.info({ trader: trader.alias, market: activity.marketSlug, fokError }, 'FOK missed, trying GTC fallback');

      const size = Math.max(5, Math.round(sizeUsd / roundedPrice));
      const gtcResult = await this.clobClient.createAndPostOrder(
        { tokenID: activity.tokenId, price: roundedPrice, side: this.Side.BUY, size },
        { tickSize, negRisk: activity.negRisk },
        this.OrderType.GTC,
      );

      const gtcError = gtcResult?.error || gtcResult?.errorMsg;
      if (!gtcResult?.success || gtcError) {
        log.warn({ trader: trader.alias, market: activity.marketSlug, error: gtcError }, 'GTC order rejected');
        await this.persistence.updateLiveTradeExecution(liveTradeId, null, null, null, 'rejected');
        return { status: 'rejected' };
      }

      const orderId = gtcResult.orderID || gtcResult.orderIds?.[0] || null;
      log.info({ orderId, trader: trader.alias, market: activity.marketSlug, price: roundedPrice, size }, 'GTC order placed, waiting 60s');

      // Poll for fill over 60 seconds
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 10_000));
        const fill = await this.checkFill(orderId, activity.tokenId);
        if (fill) {
          log.info({ orderId, trader: trader.alias, market: activity.marketSlug, fillPrice: fill.price, fillSize: fill.size }, 'GTC order FILLED');
          await this.persistence.updateLiveTradeExecution(liveTradeId, orderId, fill.price, fill.size, 'filled');
          return { orderId, fillPrice: fill.price, fillSize: fill.size, status: 'filled' };
        }
      }

      // 60s elapsed, cancel unfilled GTC
      try { await this.clobClient.cancelOrder({ orderID: orderId }); } catch { /* ok */ }
      log.warn({ orderId, trader: trader.alias, market: activity.marketSlug }, 'GTC order cancelled after 60s timeout');
      await this.persistence.updateLiveTradeExecution(liveTradeId, orderId, null, null, 'unfilled');
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
