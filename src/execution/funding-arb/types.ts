export interface FundingArbConfig {
  enabled: boolean;
  paperMode: boolean;
  scanIntervalMs: number;
  rotationCheckIntervalMs: number;
  maxPositions: number;
  positionSizeUsd: number;
  perpLeverage: number;
  minAnnualizedPct: number;
  rotationThresholdPct: number;
  exitBelowAnnualizedPct: number;
  takerFeeBps: number;             // HL perp taker fee per side
  makerFeeBps: number;             // HL perp maker fee per side
  spotFeeBps: number;              // Binance spot fee per side
  useMakerOrders: boolean;
  spotAssetWhitelist?: string[];
}

export interface FundingOpportunity {
  asset: string;
  perpAssetIndex: number;
  binanceSymbol: string;
  currentFundingRate: number;      // per-hour rate on HL
  predictedFundingRate: number;
  annualizedPct: number;           // (rate * 8760) * 100
  breakEvenHours: number;          // hours to recoup round-trip fees
  perpMidPrice: number;
  timestamp: number;
}

export interface FundingArbPosition {
  id: string;
  asset: string;
  binanceSymbol: string;
  status: 'opening' | 'open' | 'closing' | 'closed';
  perpShortQty: string;
  perpEntryPrice: string;
  spotLongQty: string;
  spotEntryPrice: string;
  notionalUsd: number;
  leverage: number;
  entryFundingRate: number;
  accumulatedFunding: number;
  entryFeesUsd: number;
  exitFeesUsd: number;
  realizedPnl: number;
  spotPnl: number;
  perpPnl: number;
  hoursHeld: number;
  openedAt: number;
  closedAt: number | null;
}

export interface FundingScanResult {
  timestamp: number;
  opportunities: FundingOpportunity[];
  bestOpportunity: FundingOpportunity | null;
  currentPositions: FundingArbPosition[];
  rotationCandidate: { from: string; to: string; apyGain: number } | null;
}
