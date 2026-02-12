import type { ExitReason } from '../../research/pca-stat-arb.js';

export type PerpsDirection = 'long' | 'short';
export type PerpsSide = 'BUY' | 'SELL';
export type PerpsExecutionStatus = 'pending_open' | 'open' | 'closing' | 'closed' | 'failed';
export type MarginType = 'ISOLATED' | 'CROSSED';
export type ExchangeName = 'binance' | 'hyperliquid';

export interface OrderResult {
  status: 'FILLED' | 'REJECTED' | 'CANCELED' | 'RESTING';
  avgPrice: string;
  filledQty: string;
  exchangeOrderId?: string;
  raw?: unknown;
}

export interface OpenOrder {
  oid: string;
  symbol: string;
  side: PerpsSide;
  sz: string;
  limitPx: string;
}

export interface PositionInfo {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: string;
  entryPrice?: string;
  markPrice?: string;
  unrealizedPnl?: string;
  leverage?: number;
}

export interface AccountInfo {
  availableBalance: string;
  walletBalance?: string;
  unrealizedPnl?: string;
}

export interface PerpsExchangeClient {
  readonly exchange: ExchangeName;
  refreshPrecisionCache(): Promise<void>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  setMarginType(symbol: string, marginType: MarginType): Promise<void>;
  placeOrder(params: {
    symbol: string;
    side: PerpsSide;
    quantity: string;
    clientOrderId: string;
    reduceOnly?: boolean;
    markPrice?: number;
    orderType?: 'maker' | 'taker';
  }): Promise<OrderResult>;
  cancelOrder(oid: string): Promise<void>;
  getOpenOrders(): Promise<OpenOrder[]>;
  waitForFill(oid: string, timeoutMs: number, pollIntervalMs?: number): Promise<OrderResult>;
  getPositions(symbol?: string): Promise<PositionInfo[]>;
  getAccountInfo(): Promise<AccountInfo>;
  roundQuantity(symbol: string, qty: number): string;
  roundPrice(symbol: string, price: number): number;
  isPaperMode(): boolean;
  getPaperFillConfig(): PaperFillConfig;
}

export type PerpsMode = 'paper' | 'live';

export interface PerpsExecution {
  id: number;
  runId: string;
  mode: PerpsMode;
  symbol: string;
  asset: string;
  direction: PerpsDirection;
  side: PerpsSide;
  entryPrice: string;
  exitPrice: string | null;
  quantity: string;
  notionalUsd: string;
  realizedPnl: string | null;
  unrealizedPnl: string | null;
  clientOrderId: string;
  entryOrderId: string | null;
  exitOrderId: string | null;
  status: PerpsExecutionStatus;
  isPaperTrade: boolean;
  signalTimestamp: number;
  zScore: number;
  residual: number;
  confidence: number;
  exitReason: ExitReason | null;
  leverage: number;
  marginType: MarginType;
  createdAt: Date;
  updatedAt: Date;
}

export interface KillSwitchEvent {
  id: number;
  reason: string;
  dailyPnl: string;
  totalPnl: string;
  consecutiveLosses: number;
  positionsClosedCount: number;
  timestamp: Date;
}

export interface PerpsPosition {
  symbol: string;
  asset: string;
  direction: PerpsDirection;
  side: PerpsSide;
  quantity: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  notionalUsd: string;
  leverage: number;
  marginType: MarginType;
  clientOrderId: string;
  openedAt: number;
  peakPnlBps: number;
  trailingActivated: boolean;
}

export interface BinanceOrderResponse {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: PerpsSide;
  type: string;
  status: string;
  avgPrice: string;
  executedQty: string;
  cumQuote: string;
  updateTime: number;
}

export interface BinancePositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  notional: string;
  updateTime: number;
}

export interface BinanceAccountInfo {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  availableBalance: string;
  maxWithdrawAmount: string;
}

export interface BinanceExchangeInfo {
  symbols: BinanceSymbolInfo[];
}

export interface BinanceSymbolInfo {
  symbol: string;
  quantityPrecision: number;
  pricePrecision: number;
  filters: BinanceFilter[];
}

export interface BinanceFilter {
  filterType: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  tickSize?: string;
  minNotional?: string;
}

export interface SymbolPrecision {
  quantityPrecision: number;
  pricePrecision: number;
  minQty: number;
  stepSize: number;
  minNotional: number;
}

export interface PaperFillConfig {
  spreadBps: number;
  slippageBps: number;
  takerFeeBps: number;
  makerFeeBps?: number;
  maxSlippageBps: number;
}

export interface BinanceFuturesClientConfig {
  apiKey: string;
  apiSecret: string;
  paperMode: boolean;
  baseUrl?: string;
  paperFill?: PaperFillConfig;
}

export interface PerpsExecutionConfig {
  enabled: boolean;
  paperMode: boolean;
  leverage: number;
  marginType: MarginType;
  enableLongs: boolean;
  enableShorts: boolean;
  maxConcurrentPositions: number;
  maxPositionSizeUsd: number;
  minPositionSizeUsd: number;
  maxTotalExposureUsd: number;
  cooldownMs: number;
  heartbeatIntervalMs: number;
  positionSyncIntervalMs: number;
  maxHoldTimeMsShort: number;
  maxHoldTimeMsLong: number;
  heartbeatStopLossBps: number;
  trailingStop: { activationPnlBps: number; trailStopBps: number };
  stallExitMs?: number;
  stallExitMinPeakBps?: number;
  maxPC1DisplacementBps?: number;
  killSwitch: KillSwitchConfig;
  paperFill?: PaperFillConfig;
  orderType?: 'maker' | 'taker';
  makerTimeoutMs?: number;
  exitMakerTimeoutMs?: number;
  exitFallbackToTaker?: boolean;
}

export interface KillSwitchConfig {
  dailyDrawdownLimitUsd: number;
  maxTotalLossUsd: number;
  maxConsecutiveLosses: number;
  checkIntervalMs: number;
}

const ASSET_TO_SYMBOL: Record<string, string> = {};
const SYMBOL_TO_ASSET: Record<string, string> = {};

export function assetToSymbol(asset: string): string {
  return ASSET_TO_SYMBOL[asset] ?? `${asset}USDT`;
}

export function symbolToAsset(symbol: string): string {
  return SYMBOL_TO_ASSET[symbol] ?? symbol.replace('USDT', '');
}

export function makeClientOrderId(signalTimestamp: number, asset: string, side: PerpsSide): string {
  return `pca_${signalTimestamp}_${asset}_${side}`;
}

export function directionToSide(direction: PerpsDirection): PerpsSide {
  return direction === 'short' ? 'SELL' : 'BUY';
}

export function closingSide(direction: PerpsDirection): PerpsSide {
  return direction === 'short' ? 'BUY' : 'SELL';
}
