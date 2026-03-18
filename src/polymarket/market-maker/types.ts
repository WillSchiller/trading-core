export interface PMMConfig {
  enabled: boolean;
  paperMode: boolean;
  maxMarkets: number;
  positionSizeUsd: number;
  maxInventoryUsd: number;
  maxTotalExposureUsd: number;
  minSpreadCents: number;
  gamma: number;
  requoteIntervalMs: number;
  minVolume24h: number;
  exitBeforeResolutionH: number;
  makerFeeBps: number;
  takerFeeBps: number;
  gammaApiUrl: string;
  clobWsUrl: string;
}

export interface PMMBookLevel {
  price: number;
  size: number;
}

export interface PMMBookSnapshot {
  tokenId: string;
  conditionId: string;
  timestamp: number;
  bids: PMMBookLevel[];
  asks: PMMBookLevel[];
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadCents: number;
}

export interface PMMMarket {
  conditionId: string;
  questionId: string;
  question: string;
  slug: string;
  outcomes: string[];
  tokens: Array<{ tokenId: string; outcome: string }>;
  yesTokenId: string;
  noTokenId: string;
  midPrice: number;
  volume24h: number;
  liquidity: number;
  spreadCents: number;
  endDate: string;
  active: boolean;
  negRisk: boolean;
  score: number;
  feeSchedule?: string;
}

export interface PMMQuote {
  tokenId: string;
  conditionId: string;
  side: 'YES' | 'NO';
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  midPrice: number;
  reservationPrice: number;
  halfSpreadProb: number;
  logitMid: number;
  ewmaVol: number;
  tau: number;
  inventory: number;
}

export interface PMMFill {
  conditionId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  notionalUsd: number;
  timestamp: number;
  midAtFill: number;
  edgeCents: number;
  adverseSelectionCents?: number;
  ofi?: number;
  vpin?: number;
  ewmaVol?: number;
  bookImbalance?: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface PMMPosition {
  conditionId: string;
  tokenId: string;
  outcome: string;
  question: string;
  netShares: number;
  avgEntry: number;
  realizedPnl: number;
  fills: number;
  lastFillAt: number;
}

export interface PMMStats {
  totalFills: number;
  totalVolumeUsd: number;
  spreadPnl: number;
  adverseCost: number;
  netPnl: number;
  avgEdgeCents: number;
  fillsPerHour: number;
  toxicFillPct: number;
  marketsActive: number;
}

export interface PMMActiveMarket {
  conditionId: string;
  question: string;
  slug: string;
  yesTokenId: string;
  noTokenId: string;
  midPrice: number;
  volume24h: number;
  liquidity: number;
  endDate: string;
  score: number;
  startedAt: number;
}
