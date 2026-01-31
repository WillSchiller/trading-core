import type { ExitReason } from '../../research/pca-stat-arb.js';

export type PerpsDirection = 'long' | 'short';
export type PerpsSide = 'BUY' | 'SELL';
export type PerpsExecutionStatus = 'pending_open' | 'open' | 'closing' | 'closed' | 'failed';
export type MarginType = 'ISOLATED' | 'CROSSED';

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
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  notionalUsd: number;
  leverage: number;
  marginType: MarginType;
  clientOrderId: string;
  openedAt: number;
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
  killSwitch: KillSwitchConfig;
  paperFill?: PaperFillConfig;
}

export interface KillSwitchConfig {
  dailyDrawdownLimitUsd: number;
  maxTotalLossUsd: number;
  maxConsecutiveLosses: number;
  checkIntervalMs: number;
}

const ASSET_TO_SYMBOL: Record<string, string> = {
  ETH: 'ETHUSDT',
  BTC: 'BTCUSDT',
  SOL: 'SOLUSDT',
  AVAX: 'AVAXUSDT',
  ARB: 'ARBUSDT',
  OP: 'OPUSDT',
  LINK: 'LINKUSDT',
  UNI: 'UNIUSDT',
  AAVE: 'AAVEUSDT',
  ATOM: 'ATOMUSDT',
  SUI: 'SUIUSDT',
  DOT: 'DOTUSDT',
  MATIC: 'MATICUSDT',
};

const SYMBOL_TO_ASSET: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_TO_SYMBOL).map(([k, v]) => [v, k])
);

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
