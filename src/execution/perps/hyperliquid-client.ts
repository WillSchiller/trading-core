import { privateKeyToAccount } from 'viem/accounts';
import { HttpTransport, InfoClient, ExchangeClient } from '@nktkas/hyperliquid';
import { createChildLogger } from '../../utils/logger.js';
import type {
  PerpsExchangeClient,
  ExchangeName,
  OrderResult,
  PositionInfo,
  AccountInfo,
  PaperFillConfig,
  PerpsSide,
  MarginType,
} from './types.js';

const log = createChildLogger({ component: 'hyperliquid' });

export interface HyperliquidClientConfig {
  privateKey: string;
  paperMode: boolean;
  paperFill?: PaperFillConfig;
  testnet?: boolean;
  slippageBps?: number;
}

interface AssetMeta {
  index: number;
  szDecimals: number;
  maxLeverage: number;
}

export class HyperliquidClient implements PerpsExchangeClient {
  readonly exchange: ExchangeName = 'hyperliquid';
  private readonly _paperMode: boolean;
  private readonly paperFill: PaperFillConfig;
  private readonly slippageBps: number;
  private readonly walletAddress: `0x${string}`;
  private readonly info: InfoClient;
  private readonly exchangeClient: ExchangeClient;
  private assetCache = new Map<string, AssetMeta>();
  private marginTypeLogged = false;

  constructor(config: HyperliquidClientConfig) {
    this._paperMode = config.paperMode;
    this.paperFill = config.paperFill ?? { spreadBps: 2, slippageBps: 5, takerFeeBps: 2, maxSlippageBps: 20 };
    this.slippageBps = config.slippageBps ?? 50;

    const key = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
    const account = privateKeyToAccount(key as `0x${string}`);
    this.walletAddress = account.address;

    const transport = new HttpTransport({ isTestnet: config.testnet ?? false });
    this.info = new InfoClient({ transport });
    this.exchangeClient = new ExchangeClient({ transport, wallet: account });

    log.info({ address: this.walletAddress, paperMode: this._paperMode, testnet: config.testnet ?? false }, 'Hyperliquid client initialized');
  }

  private toHlSymbol(symbol: string): string {
    return symbol.replace('USDT', '');
  }

  private toInternalSymbol(hlSymbol: string): string {
    return `${hlSymbol}USDT`;
  }

  async refreshPrecisionCache(): Promise<void> {
    const [meta] = await this.info.metaAndAssetCtxs();
    this.assetCache.clear();
    for (let i = 0; i < meta.universe.length; i++) {
      const asset = meta.universe[i];
      this.assetCache.set(asset.name, {
        index: i,
        szDecimals: asset.szDecimals,
        maxLeverage: asset.maxLeverage,
      });
    }
    log.info({ assetCount: this.assetCache.size }, 'Precision cache refreshed');
  }

  private getAssetMeta(symbol: string): AssetMeta | undefined {
    const hlSymbol = this.toHlSymbol(symbol);
    return this.assetCache.get(hlSymbol);
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (this._paperMode) {
      log.debug({ symbol, leverage }, 'Paper mode: skipping setLeverage');
      return;
    }
    const meta = this.getAssetMeta(symbol);
    if (!meta) {
      log.warn({ symbol, exchange: this.exchange }, 'unsupported_symbol — cannot set leverage');
      return;
    }
    await this.exchangeClient.updateLeverage({
      asset: meta.index,
      isCross: false,
      leverage,
    });
    log.info({ symbol, leverage, exchange: this.exchange }, 'Leverage set');
  }

  async setMarginType(_symbol: string, _marginType: MarginType): Promise<void> {
    if (!this.marginTypeLogged) {
      log.info({ exchange: this.exchange }, 'marginType not directly supported on HL, skipping — margin mode set via setLeverage isCross param');
      this.marginTypeLogged = true;
    }
  }

  async placeOrder(params: {
    symbol: string;
    side: PerpsSide;
    quantity: number;
    clientOrderId: string;
    reduceOnly?: boolean;
    markPrice?: number;
  }): Promise<OrderResult> {
    const { symbol, side, quantity, clientOrderId, reduceOnly, markPrice } = params;
    const roundedQty = this.roundQuantity(symbol, quantity);

    if (this._paperMode) {
      const fillPrice = this.simulatePaperFill(side, markPrice ?? 0, roundedQty);
      log.info({ symbol, side, quantity: roundedQty, clientOrderId, fillPrice: fillPrice.toFixed(4), exchange: this.exchange }, 'PAPER order (simulated)');
      return {
        status: 'FILLED',
        avgPrice: fillPrice > 0 ? fillPrice.toFixed(8) : '0',
        filledQty: String(roundedQty),
        exchangeOrderId: String(Date.now()),
      };
    }

    const meta = this.getAssetMeta(symbol);
    if (!meta) {
      log.error({ symbol, exchange: this.exchange, reason: 'unsupported_symbol' }, 'Symbol not found on Hyperliquid');
      return { status: 'REJECTED', avgPrice: '0', filledQty: '0' };
    }

    const isBuy = side === 'BUY';
    const mp = markPrice ?? 0;
    const slippageMult = isBuy ? (1 + this.slippageBps / 10000) : (1 - this.slippageBps / 10000);
    const limitPrice = this.roundPrice(symbol, mp * slippageMult);

    const resp = await this.exchangeClient.order({
      orders: [{
        a: meta.index,
        b: isBuy,
        p: String(limitPrice),
        s: String(roundedQty),
        r: reduceOnly ?? false,
        t: { limit: { tif: 'Ioc' } },
      }],
      grouping: 'na',
    });

    const status = resp.response.data.statuses[0];
    if (!status) {
      log.error({ symbol, clientOrderId, exchange: this.exchange }, 'No order status returned');
      return { status: 'CANCELED', avgPrice: '0', filledQty: '0' };
    }

    if (typeof status === 'string') {
      log.warn({ symbol, clientOrderId, status, exchange: this.exchange }, 'Unexpected order status string');
      return { status: 'CANCELED', avgPrice: '0', filledQty: '0' };
    }

    if ('error' in status) {
      log.error({ symbol, clientOrderId, error: status.error, exchange: this.exchange }, 'Order rejected');
      return { status: 'REJECTED', avgPrice: '0', filledQty: '0' };
    }

    if ('filled' in status) {
      const filledQty = status.filled.totalSz;
      const avgPrice = status.filled.avgPx;
      log.info({ symbol, side, filledQty, avgPrice, oid: status.filled.oid, clientOrderId, exchange: this.exchange }, 'Order filled');
      return {
        status: 'FILLED',
        avgPrice,
        filledQty,
        exchangeOrderId: String(status.filled.oid),
      };
    }

    if ('resting' in status) {
      log.warn({ symbol, clientOrderId, oid: status.resting.oid, exchange: this.exchange }, 'IOC order resting (unexpected) — treating as canceled');
      return { status: 'CANCELED', avgPrice: '0', filledQty: '0' };
    }

    log.warn({ symbol, clientOrderId, status, exchange: this.exchange }, 'Unknown order status');
    return { status: 'CANCELED', avgPrice: '0', filledQty: '0' };
  }

  async getPositions(_symbol?: string): Promise<PositionInfo[]> {
    if (this._paperMode) return [];

    const state = await this.info.clearinghouseState({ user: this.walletAddress });
    const result: PositionInfo[] = [];
    for (const ap of state.assetPositions) {
      const pos = ap.position;
      const szi = pos.szi;
      const isShort = szi.startsWith('-');
      const qty = isShort ? szi.slice(1) : szi;
      if (qty === '0' || qty === '0.0') continue;
      result.push({
        symbol: this.toInternalSymbol(pos.coin),
        side: isShort ? 'SHORT' : 'LONG',
        qty,
        entryPrice: pos.entryPx,
        markPrice: undefined,
        unrealizedPnl: pos.unrealizedPnl,
        leverage: typeof pos.leverage === 'object' ? pos.leverage.value : undefined,
      });
    }
    return result;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const state = await this.info.clearinghouseState({ user: this.walletAddress });
    return {
      availableBalance: state.withdrawable,
      walletBalance: state.crossMarginSummary.accountValue,
      unrealizedPnl: state.crossMarginSummary.totalNtlPos,
    };
  }

  roundQuantity(symbol: string, qty: number): number {
    const meta = this.getAssetMeta(symbol);
    const szDecimals = meta?.szDecimals ?? 3;
    const step = Math.pow(10, -szDecimals);
    const rounded = Math.floor(qty / step) * step;
    return parseFloat(rounded.toFixed(szDecimals));
  }

  roundPrice(_symbol: string, price: number): number {
    if (price === 0) return 0;
    const sigFigs = 6;
    const magnitude = Math.floor(Math.log10(Math.abs(price))) + 1;
    const decimals = Math.max(0, sigFigs - magnitude);
    return parseFloat(price.toFixed(decimals));
  }

  isPaperMode(): boolean {
    return this._paperMode;
  }

  getPaperFillConfig(): PaperFillConfig {
    return this.paperFill;
  }

  private simulatePaperFill(side: PerpsSide, markPrice: number, qty: number): number {
    if (markPrice <= 0) return 0;
    const spreadCost = (this.paperFill.spreadBps / 10000) * markPrice;
    const slippageCost = Math.min(
      (this.paperFill.slippageBps / 10000) * markPrice,
      (this.paperFill.maxSlippageBps / 10000) * markPrice,
    );
    const notional = markPrice * qty;
    const feeUsd = (this.paperFill.takerFeeBps / 10000) * notional;
    const feePriceDelta = feeUsd / qty;
    const totalAdverse = spreadCost + slippageCost + feePriceDelta;
    return side === 'BUY' ? markPrice + totalAdverse : markPrice - totalAdverse;
  }
}
