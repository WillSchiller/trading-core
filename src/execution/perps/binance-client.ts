import { createHmac } from 'node:crypto';
import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import type {
  BinanceFuturesClientConfig,
  BinanceOrderResponse,
  BinancePositionRisk,
  BinanceAccountInfo,
  BinanceExchangeInfo,
  SymbolPrecision,
  PaperFillConfig,
  PerpsSide,
  MarginType,
  PerpsExchangeClient,
  ExchangeName,
  OrderResult,
  PositionInfo,
  AccountInfo,
} from './types.js';

const log = createChildLogger({ component: 'binance-futures' });

const FAPI_BASE = 'https://fapi.binance.com';

export class BinanceFuturesClient implements PerpsExchangeClient {
  readonly exchange: ExchangeName = 'binance';
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly paperMode: boolean;
  private readonly baseUrl: string;
  private readonly paperFill: PaperFillConfig;
  private precisionCache = new Map<string, SymbolPrecision>();
  private lastExchangeInfoFetch = 0;
  private static readonly EXCHANGE_INFO_TTL_MS = 3600_000;

  constructor(config: BinanceFuturesClientConfig) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.paperMode = config.paperMode;
    this.baseUrl = config.baseUrl ?? FAPI_BASE;
    this.paperFill = config.paperFill ?? { spreadBps: 2, slippageBps: 5, takerFeeBps: 2, maxSlippageBps: 20 };
  }

  private sign(queryString: string): string {
    return createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  private buildSignedParams(params: Record<string, string | number>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      qs.append(k, String(v));
    }
    qs.append('timestamp', Date.now().toString());
    qs.append('recvWindow', '5000');
    const raw = qs.toString();
    const signature = this.sign(raw);
    return `${raw}&signature=${signature}`;
  }

  private async request<T>(
    method: string,
    path: string,
    params: Record<string, string | number> = {},
    signed = true
  ): Promise<T> {
    const qs = signed ? this.buildSignedParams(params) : new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string])
    ).toString();

    const url = qs ? `${this.baseUrl}${path}?${qs}` : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'X-MBX-APIKEY': this.apiKey };

    const response = await fetch(url, { method, headers });
    const body = await response.text();

    if (!response.ok) {
      const msg = `Binance API ${method} ${path} failed: ${response.status} ${body}`;
      log.error({ status: response.status, body, path }, msg);
      throw new Error(msg);
    }

    return JSON.parse(body) as T;
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

    if (this.paperMode) {
      const fillPrice = this.simulatePaperFill(side, markPrice ?? 0, roundedQty);
      log.info({ symbol, side, quantity: roundedQty, clientOrderId, fillPrice: fillPrice.toFixed(4) }, 'PAPER order (simulated)');
      return {
        status: 'FILLED',
        avgPrice: fillPrice > 0 ? fillPrice.toFixed(8) : '0',
        filledQty: String(roundedQty),
        exchangeOrderId: String(Date.now()),
      };
    }

    const orderParams: Record<string, string | number> = {
      symbol,
      side,
      type: 'MARKET',
      quantity: roundedQty,
      newClientOrderId: clientOrderId,
    };
    if (reduceOnly) orderParams.reduceOnly = 'true';

    const resp = await withRetry(
      () => this.request<BinanceOrderResponse>('POST', '/fapi/v1/order', orderParams),
      { maxAttempts: 3, baseDelayMs: 500 },
      { symbol, side, clientOrderId }
    );
    return {
      status: resp.status === 'FILLED' ? 'FILLED' : 'CANCELED',
      avgPrice: resp.avgPrice,
      filledQty: resp.executedQty,
      exchangeOrderId: String(resp.orderId),
      raw: resp,
    };
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

  async getPositionRisk(symbol?: string): Promise<BinancePositionRisk[]> {
    const params: Record<string, string | number> = {};
    if (symbol) params.symbol = symbol;
    return this.request<BinancePositionRisk[]>('GET', '/fapi/v2/positionRisk', params);
  }

  async getPositions(symbol?: string): Promise<PositionInfo[]> {
    const raw = await this.getPositionRisk(symbol);
    const result: PositionInfo[] = [];
    for (const ep of raw) {
      const amt = ep.positionAmt;
      const isShort = amt.startsWith('-');
      const qty = isShort ? amt.slice(1) : amt;
      if (qty === '0' || qty === '0.00000000') continue;
      result.push({
        symbol: ep.symbol,
        side: isShort ? 'SHORT' : 'LONG',
        qty,
        entryPrice: ep.entryPrice,
        markPrice: ep.markPrice,
        unrealizedPnl: ep.unRealizedProfit,
        leverage: parseInt(ep.leverage, 10),
      });
    }
    return result;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const resp = await this.request<BinanceAccountInfo>('GET', '/fapi/v2/account');
    return {
      availableBalance: resp.availableBalance,
      walletBalance: resp.totalWalletBalance,
      unrealizedPnl: resp.totalUnrealizedProfit,
    };
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (this.paperMode) {
      log.debug({ symbol, leverage }, 'Paper mode: skipping setLeverage');
      return;
    }
    await this.request('POST', '/fapi/v1/leverage', { symbol, leverage });
    log.info({ symbol, leverage }, 'Leverage set');
  }

  async setMarginType(symbol: string, marginType: MarginType): Promise<void> {
    if (this.paperMode) {
      log.debug({ symbol, marginType }, 'Paper mode: skipping setMarginType');
      return;
    }
    try {
      await this.request('POST', '/fapi/v1/marginType', { symbol, marginType });
      log.info({ symbol, marginType }, 'Margin type set');
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('-4046') || msg.includes('No need to change margin type')) {
        log.debug({ symbol, marginType }, 'Margin type already set');
        return;
      }
      throw err;
    }
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    if (this.paperMode) {
      log.debug({ symbol }, 'Paper mode: skipping cancelAllOrders');
      return;
    }
    await this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol });
    log.info({ symbol }, 'All open orders cancelled');
  }

  async getExchangeInfo(): Promise<BinanceExchangeInfo> {
    return this.request<BinanceExchangeInfo>('GET', '/fapi/v1/exchangeInfo', {}, false);
  }

  async refreshPrecisionCache(): Promise<void> {
    const now = Date.now();
    if (now - this.lastExchangeInfoFetch < BinanceFuturesClient.EXCHANGE_INFO_TTL_MS && this.precisionCache.size > 0) {
      return;
    }

    const info = await this.getExchangeInfo();
    for (const sym of info.symbols) {
      const lotSize = sym.filters.find(f => f.filterType === 'LOT_SIZE');
      const minNotional = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL');
      this.precisionCache.set(sym.symbol, {
        quantityPrecision: sym.quantityPrecision,
        pricePrecision: sym.pricePrecision,
        minQty: lotSize?.minQty ? parseFloat(lotSize.minQty) : 0.001,
        stepSize: lotSize?.stepSize ? parseFloat(lotSize.stepSize) : 0.001,
        minNotional: minNotional?.minNotional ? parseFloat(minNotional.minNotional) : 5,
      });
    }
    this.lastExchangeInfoFetch = now;
    log.info({ symbolCount: this.precisionCache.size }, 'Precision cache refreshed');
  }

  getPrecision(symbol: string): SymbolPrecision {
    const cached = this.precisionCache.get(symbol);
    if (cached) return cached;
    return { quantityPrecision: 3, pricePrecision: 2, minQty: 0.001, stepSize: 0.001, minNotional: 5 };
  }

  roundQuantity(symbol: string, qty: number): number {
    const { stepSize } = this.getPrecision(symbol);
    if (stepSize <= 0) return qty;
    const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
    const rounded = Math.floor(qty / stepSize) * stepSize;
    return parseFloat(rounded.toFixed(precision));
  }

  roundPrice(symbol: string, price: number): number {
    const { pricePrecision } = this.getPrecision(symbol);
    return parseFloat(price.toFixed(pricePrecision));
  }

  isPaperMode(): boolean {
    return this.paperMode;
  }

  getPaperFillConfig(): PaperFillConfig {
    return this.paperFill;
  }
}
