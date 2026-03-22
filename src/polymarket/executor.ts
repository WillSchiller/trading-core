import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createChildLogger } from '../utils/logger.js';
import { PolymarketPersistence } from './persistence.js';
import type { PolymarketConfig, TrackedTrader, TraderActivity } from './types.js';

const log = createChildLogger({ component: 'pm-executor' });

const MAX_SLIPPAGE_CENTS = 3;

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
      const size = sizeUsd / Math.max(roundedPrice, 0.001);
      const roundedSize = Math.round(size * 100) / 100;

      if (roundedSize < 1) {
        log.warn({ trader: trader.alias, market: activity.marketSlug, size: roundedSize }, 'Order too small, skipping');
        await this.persistence.updateLiveTradeExecution(liveTradeId, null, null, null, 'skipped_small');
        return { status: 'skipped_small' };
      }

      const result = await this.clobClient.createAndPostOrder(
        {
          tokenID: activity.tokenId,
          price: roundedPrice,
          side: this.Side.BUY,
          size: roundedSize,
        },
        { tickSize, negRisk: activity.negRisk },
        this.OrderType.GTC,
      );

      log.info({ clobResponse: JSON.stringify(result) }, 'CLOB createAndPostOrder response');

      if (result.success === false || result.errorMsg) {
        log.warn({
          trader: trader.alias,
          market: activity.marketSlug,
          error: result.errorMsg,
          result: JSON.stringify(result),
        }, 'CLOB order rejected');
        await this.persistence.updateLiveTradeExecution(
          liveTradeId, null, null, null, 'rejected',
        );
        return { status: 'rejected' };
      }

      const orderId = result.orderID || result.orderIds?.[0] || result.order_id || null;

      log.info({
        orderId,
        trader: trader.alias,
        market: activity.marketSlug,
        outcome: activity.outcome,
        sizeUsd: sizeUsd.toFixed(2),
        orderPrice: roundedPrice,
        traderPrice: activity.price,
      }, 'Live CLOB order placed');

      await this.persistence.updateLiveTradeExecution(
        liveTradeId, orderId, roundedPrice, roundedSize, 'placed',
      );

      return {
        orderId,
        fillPrice: roundedPrice,
        fillSize: roundedSize,
        status: 'placed',
      };
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
