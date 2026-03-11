export type SideFilter = 'both' | 'buy' | 'sell';

export interface MMConfig {
  assets: string[];
  assetSideFilter?: Record<string, SideFilter>;
  positionSizeUsd: number;
  maxInventoryUsd: number;
  requoteIntervalMs: number;
  minSpreadBps: number;
  skewBpsPerUnit: number;
  maxOpenOrders: number;
  paperMode: boolean;
}

export interface BookLevel {
  px: number;
  sz: number;
  n: number;
}

export interface BookSnapshot {
  asset: string;
  time: number;
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadBps: number;
}

export interface MMQuote {
  asset: string;
  bidPx: number;
  askPx: number;
  bidSz: number;
  askSz: number;
  midPrice: number;
  spreadBps: number;
  skewBps: number;
  timestamp: number;
}

export interface MMFill {
  asset: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  notional: number;
  timestamp: number;
  midAtFill: number;
  edgeBps: number;
  filtered: boolean;  // true = would have been blocked by side filter
  priceAfter1m?: number;
  priceAfter5m?: number;
  adverseSelectionBps?: number;
}

export interface MMPosition {
  asset: string;
  netQty: number;
  netNotional: number;
  avgEntryPrice: number;
  fills: number;
  realizedPnl: number;
}

export interface MMStats {
  totalFills: number;
  totalVolumeUsd: number;
  grossPnl: number;
  rebatesPnl: number;
  adverseSelectionCost: number;
  netPnl: number;
  avgEdgeBps: number;
  fillsPerHour: number;
  toxicFillPct: number;
}
