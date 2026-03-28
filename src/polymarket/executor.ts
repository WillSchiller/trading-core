import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createChildLogger } from '../utils/logger.js';
import { PolymarketPersistence } from './persistence.js';
import type { PolymarketConfig, TrackedTrader, TraderActivity } from './types.js';

const log = createChildLogger({ component: 'pm-executor' });

// Slippage check removed — speed matters more than price precision
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

  async getBalance(): Promise<number> {
    if (!this.clobClient) return 0;
    const bal = await this.clobClient.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    return parseFloat(bal?.balance || '0') / 1e6;
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
      const tickSize = '0.01';
      const tick = parseFloat(tickSize);
      const roundedPrice = Math.round(activity.price / tick) * tick;
      if (sizeUsd < 1) {
        log.warn({ trader: trader.alias, market: activity.marketSlug, sizeUsd }, 'Order below $1 minimum, skipping');
        await this.persistence.updateLiveTradeExecution(liveTradeId, null, null, null, 'skipped_small');
        return { status: 'skipped_small' };
      }

      // Try FAK (Fill And Kill) — takes whatever liquidity is available
      const fokResult = await this.clobClient.createAndPostMarketOrder(
        {
          tokenID: activity.tokenId,
          amount: sizeUsd,
          side: this.Side.BUY,
          price: roundedPrice,
        },
        { tickSize, negRisk: activity.negRisk },
        this.OrderType.FAK,
      );

      const fokError = fokResult?.error || fokResult?.errorMsg;
      const fokFilled = fokResult?.success && !fokError;

      if (fokFilled) {
        const orderId = fokResult.orderID || fokResult.orderIds?.[0] || null;
        await new Promise(r => setTimeout(r, FILL_CHECK_DELAY_MS));
        const fill = await this.checkFill(orderId, activity.tokenId, sizeUsd);
        if (fill) {
          log.info({ orderId, trader: trader.alias, market: activity.marketSlug, outcome: activity.outcome, sizeUsd: sizeUsd.toFixed(2), fillPrice: fill.price }, 'FOK order FILLED');
          await this.persistence.updateLiveTradeExecution(liveTradeId, orderId, fill.price, fill.size, 'filled');
          return { orderId, fillPrice: fill.price, fillSize: fill.size, status: 'filled' };
        }
      }

      // FOK failed — GTC at trader's price + 5c to catch the move
      const gtcPrice = Math.min(0.99, Math.round((roundedPrice + 0.05) / tick) * tick);
      log.info({ trader: trader.alias, market: activity.marketSlug, fokError, gtcPrice, traderPrice: roundedPrice }, 'FOK missed, placing GTC at trader price +1c');

      const size = Math.max(5, Math.round(sizeUsd / gtcPrice));
      const gtcResult = await this.clobClient.createAndPostOrder(
        { tokenID: activity.tokenId, price: gtcPrice, side: this.Side.BUY, size },
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
      log.info({ orderId, trader: trader.alias, market: activity.marketSlug, price: gtcPrice, size }, 'GTC order placed — will check fill in price update cycle');
      await this.persistence.updateLiveTradeExecution(liveTradeId, orderId, gtcPrice, size, 'pending');
      return { orderId, fillPrice: gtcPrice, fillSize: size, status: 'pending' };

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
    } finally {
      // Log book depth after order attempt (fire-and-forget)
      this.clobClient?.getOrderBook(activity.tokenId).then((book: any) => {
        const asks = book?.asks || [];
        const depth = asks.reduce((s: number, a: { size: string }) => s + parseFloat(a.size || '0'), 0);
        this.persistence.getPool().query('UPDATE pm_live_trades SET book_depth = $1 WHERE id = $2', [depth, liveTradeId]).catch(() => {});
      }).catch(() => {});
    }
  }

  async executeSellOrder(
    liveTradeId: number,
    trader: TrackedTrader,
    activity: TraderActivity,
    position: { fillSize: number; fillPrice: number },
  ): Promise<{ orderId?: string; exitPrice?: number; status: string }> {
    if (!this.clobClient) return { status: 'no_client' };

    try {
      const midPrice = await this.fetchMidPrice(activity.conditionId, activity.tokenId);
      const sellPrice = midPrice ?? activity.price;

      const tickSize = '0.01';
      const tick = parseFloat(tickSize);
      const roundedPrice = Math.min(0.99, Math.round(sellPrice / tick) * tick);
      const size = Math.round(position.fillSize * 100) / 100;

      if (size < 1) {
        log.warn({ trader: trader.alias, market: activity.marketSlug, size }, 'Sell too small, skipping');
        return { status: 'skipped_small' };
      }

      // Try FOK sell first
      const fokResult = await this.clobClient.createAndPostMarketOrder(
        { tokenID: activity.tokenId, amount: size, side: this.Side.SELL, price: roundedPrice },
        { tickSize, negRisk: activity.negRisk },
        this.OrderType.FOK,
      );

      const fokError = fokResult?.error || fokResult?.errorMsg;
      if (fokResult?.success && !fokError) {
        const orderId = fokResult.orderID || fokResult.orderIds?.[0] || null;
        await new Promise(r => setTimeout(r, FILL_CHECK_DELAY_MS));
        const fill = await this.checkFill(orderId, activity.tokenId);
        if (fill) {
          const realPnl = (fill.price - position.fillPrice) * position.fillSize;
          log.info({ orderId, trader: trader.alias, market: activity.marketSlug, exitPrice: fill.price, entryPrice: position.fillPrice, realPnl: realPnl.toFixed(2) }, 'FOK SELL FILLED');
          await this.persistence.markLiveTradeSold(liveTradeId, fill.price, realPnl, orderId);
          return { orderId, exitPrice: fill.price, status: 'sold' };
        }
      }

      // GTC fallback
      log.info({ trader: trader.alias, market: activity.marketSlug, fokError }, 'FOK sell missed, trying GTC');
      const gtcResult = await this.clobClient.createAndPostOrder(
        { tokenID: activity.tokenId, price: roundedPrice, side: this.Side.SELL, size },
        { tickSize, negRisk: activity.negRisk },
        this.OrderType.GTC,
      );

      const gtcError = gtcResult?.error || gtcResult?.errorMsg;
      if (!gtcResult?.success || gtcError) {
        log.warn({ trader: trader.alias, market: activity.marketSlug, error: gtcError }, 'GTC sell rejected');
        return { status: 'rejected' };
      }

      const orderId = gtcResult.orderID || gtcResult.orderIds?.[0] || null;
      log.info({ orderId, trader: trader.alias, market: activity.marketSlug, price: roundedPrice, size }, 'GTC sell placed, waiting 5min');

      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 10_000));
        const fill = await this.checkFill(orderId, activity.tokenId);
        if (fill) {
          const realPnl = (fill.price - position.fillPrice) * position.fillSize;
          log.info({ orderId, trader: trader.alias, market: activity.marketSlug, exitPrice: fill.price, realPnl: realPnl.toFixed(2) }, 'GTC SELL FILLED');
          await this.persistence.markLiveTradeSold(liveTradeId, fill.price, realPnl, orderId);
          return { orderId, exitPrice: fill.price, status: 'sold' };
        }
      }

      try { await this.clobClient.cancelOrder({ orderID: orderId }); } catch { /* ok */ }
      log.warn({ orderId, trader: trader.alias, market: activity.marketSlug }, 'GTC sell cancelled after 5min timeout');
      return { orderId, status: 'unfilled' };
    } catch (err) {
      log.error({ trader: trader.alias, market: activity.marketSlug, error: (err as Error).message }, 'Sell order failed');
      return { status: 'error' };
    }
  }

  async checkPendingOrder(liveTradeId: number, _tokenId?: string): Promise<boolean> {
    if (!this.clobClient) return false;
    const result = await this.persistence.getPool().query(
      `SELECT order_id, fill_price::float as price FROM pm_live_trades WHERE id = $1`, [liveTradeId]
    );
    const orderId = result.rows[0]?.order_id;
    if (!orderId) return false;
    try {
      const order = await this.clobClient.getOrder(orderId);
      if (order && parseFloat(order.size_matched || '0') > 0) {
        const fillPrice = parseFloat(order.price);
        const fillSize = parseFloat(order.size_matched);
        await this.persistence.updateLiveTradeExecution(liveTradeId, orderId, fillPrice, fillSize, 'filled');
        return true;
      }
    } catch { /* not filled yet */ }
    return false;
  }

  async cancelPendingOrder(liveTradeId: number): Promise<void> {
    if (!this.clobClient) return;
    const result = await this.persistence.getPool().query(
      `SELECT order_id FROM pm_live_trades WHERE id = $1`, [liveTradeId]
    );
    const orderId = result.rows[0]?.order_id;
    if (!orderId) return;
    try {
      await this.clobClient.cancelOrder({ orderID: orderId });
      await this.persistence.updateLiveTradeExecution(liveTradeId, orderId, null, null, 'cancelled');
      log.info({ orderId, liveTradeId }, 'Pending GTC cancelled');
    } catch { /* already cancelled or filled */ }
  }

  private async checkFill(orderId: string | null, _tokenId: string, maxSizeUsd?: number): Promise<{ price: number; size: number } | null> {
    if (!orderId) return null;
    try {
      const order = await this.clobClient.getOrder(orderId);
      if (order && parseFloat(order.size_matched) > 0) {
        const price = parseFloat(order.price);
        let size = parseFloat(order.size_matched);
        if (maxSizeUsd && price > 0) {
          const maxShares = maxSizeUsd / price;
          if (size > maxShares * 1.5) {
            log.warn({ orderId, reportedSize: size, maxShares, price }, 'Fill size exceeds expected — capping');
            size = maxShares;
          }
        }
        return { price, size };
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
