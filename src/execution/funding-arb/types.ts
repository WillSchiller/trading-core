export interface FundingArbConfig {
  enabled: boolean;
  paperMode: boolean;
  scanIntervalMs: number;          // how often to scan funding rates (default 60s)
  rotationCheckIntervalMs: number; // how often to check for rotation (default 300s)
  maxPositions: number;            // max simultaneous arb positions
  positionSizeUsd: number;         // per-position notional
  perpLeverage: number;            // leverage on perp short leg (default 3)
  minAnnualizedPct: number;        // minimum APY to enter (after fees)
  rotationThresholdPct: number;    // new asset must beat current by this APY margin
  exitBelowAnnualizedPct: number;  // exit if funding drops below this APY
  takerFeeBps: number;             // round-trip taker fee (spot + perp)
  makerFeeBps: number;             // round-trip maker fee
  useMakerOrders: boolean;         // try maker orders to reduce fees
  spotAssetWhitelist?: string[];   // only trade these (if set)
}

export interface FundingOpportunity {
  asset: string;
  perpAssetIndex: number;
  spotAssetId: number;             // 10000 + spotIndex
  currentFundingRate: number;      // per-hour rate
  predictedFundingRate: number;    // next predicted
  annualizedPct: number;           // (rate * 8760) * 100
  annualizedAfterFeesPct: number;  // net of round-trip entry+exit fees
  breakEvenHours: number;          // hours to recoup entry fees
  spotMidPrice: number;
  perpMidPrice: number;
  basisBps: number;                // (perp - spot) / spot * 10000
  spotVolume24h: number;
  hasSpot: boolean;
  timestamp: number;
}

export interface FundingArbPosition {
  id: string;
  asset: string;
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

