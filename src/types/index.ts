export type VenueType = 'cex' | 'dex';
export type Chain = 'mainnet' | 'base' | 'arbitrum';
export type OpportunityStatus =
  | 'detected'
  | 'evaluating'
  | 'skipped'
  | 'submitted'
  | 'filled'
  | 'reverted'
  | 'expired';
export type TradeDirection = 'buy_dex' | 'sell_dex';
export type RollupInterval = '1s' | '10s' | '1m';

export interface NormalizedQuote {
  ts: Date;
  venue: string;
  pair: string;
  chain?: Chain;
  bid?: number;
  ask?: number;
  mid: number;
  blockNumber?: bigint;
  sqrtPriceX96?: bigint;
  liquidity?: bigint;
  latencyMs: number;
  exchangeTsMs?: number;
  receivedTsMs: number;
  blockTsMs?: number;
}

export type QuoteQuality = 'fresh' | 'thin_market_ok' | 'stale_reject';

export interface QuoteWithStaleness {
  quote: NormalizedQuote;
  isStale: boolean;
  staleReason?: 'age' | 'disconnect' | 'block_lag' | 'invalid_timestamp';
  staleDurationMs?: number;
  quality?: QuoteQuality;
  isThinMarket?: boolean;
}

export interface Opportunity {
  id?: bigint;
  detectedAt: Date;
  pairId: number;
  chain: Chain;
  anchorVenueId: number;
  anchorMid: number;
  confirmVenueId?: number;
  confirmMid?: number;
  dexVenueId: number;
  dexPoolAddress: string;
  dexMid: number;
  dexBlockNumber?: bigint;
  spreadBps: number;
  direction: TradeDirection;
  estimatedSlippageBps?: number;
  estimatedGasUsd?: number;
  estimatedPoolFeeBps?: number;
  estimatedProfitUsd?: number;
  status: OpportunityStatus;
  skipReason?: string;
  volatilityRegime?: string;
  reasonCodes?: string[];
  metadata?: Record<string, unknown>;
  openedAt?: Date;
  closedAt?: Date;
  lastSeenAt?: Date;
  closeReason?: string;
  oppKey?: string;
  maxSpreadBps?: number;
}

export interface ConnectorHealth {
  venueId: number;
  chain?: Chain;
  lastQuoteAt?: Date;
  lastBlock?: bigint;
  wsConnected: boolean;
  reconnectCount: number;
  errorCount: number;
  updatedAt: Date;
  lastLatencyMs?: number;
  p95LatencyMs?: number;
  invalidTsCount?: number;
  futureTsCount?: number;
}
