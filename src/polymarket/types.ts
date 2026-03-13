export interface PolymarketConfig {
  enabled: boolean;
  paperMode: boolean;
  pollIntervalMs: number;
  discoveryIntervalMs: number;
  positionUpdateIntervalMs: number;
  killSwitchCheckIntervalMs: number;
  bankrollUsd: number;
  maxTraders: number;
  riskLimits: PolymarketRiskLimits;
  privateKey?: string;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  clobApiUrl: string;
  gammaApiUrl: string;
  dataApiUrl: string;
}

export interface PolymarketRiskLimits {
  maxPositionUsd: number;
  maxTotalExposureUsd: number;
  dailyLossLimitUsd: number;
  maxMarketsOpen: number;
}

export interface TrackedTrader {
  id?: number;
  address: string;
  alias: string;
  pnl: number;
  volume: number;
  bankrollEstimate: number;
  rank: number;
  enabled: boolean;
  discoveredAt?: Date;
  lastActivityAt?: Date;
}

export interface TraderActivity {
  id: string;
  traderAddress: string;
  timestamp: number;
  conditionId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  outcome: string;
  marketSlug: string;
  marketQuestion: string;
  negRisk: boolean;
}

export interface CopyTrade {
  id?: number;
  traderAddress: string;
  conditionId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  outcome: string;
  marketSlug: string;
  status: 'pending' | 'filled' | 'failed' | 'paper';
  paper: boolean;
  orderId?: string;
  fillPrice?: number;
  errorMessage?: string;
  createdAt?: Date;
}

export interface CopyPosition {
  id?: number;
  conditionId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  outcome: string;
  marketSlug: string;
  marketQuestion: string;
  avgEntry: number;
  size: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  status: 'open' | 'closed';
  paper: boolean;
  openedAt?: Date;
  closedAt?: Date;
}

export interface KillSwitchEvent {
  reason: string;
  dailyPnl: number;
  totalExposure: number;
  positionsOpen: number;
  triggeredAt?: Date;
}

export interface MarketInfo {
  conditionId: string;
  questionId: string;
  question: string;
  slug: string;
  outcomes: string[];
  outcomePrices: number[];
  volume: number;
  liquidity: number;
  negRisk: boolean;
  active: boolean;
  closed: boolean;
  tokens: Array<{ tokenId: string; outcome: string }>;
}

export interface LeaderboardEntry {
  address: string;
  displayName: string;
  pnl: number;
  volume: number;
  rank: number;
}
