import { Decimal } from 'decimal.js';
import type { QuoteWithStaleness, NormalizedQuote, Chain } from '../types/index.js';

export interface FilterResult {
  passed: boolean;
  reason: string;
}

export interface ThresholdFilterInput {
  spreadBps: number;
  minSpreadBps: number;
}

export function thresholdFilter(input: ThresholdFilterInput): FilterResult {
  const { spreadBps, minSpreadBps } = input;
  const absSpread = Math.abs(spreadBps);

  if (absSpread >= minSpreadBps) {
    return {
      passed: true,
      reason: 'spread_above_threshold',
    };
  }

  return {
    passed: false,
    reason: 'spread_below_threshold',
  };
}

export interface DurationFilterInput {
  pairChainKey: string;
  currentSpreadBps: number;
  minSpreadBps: number;
  minDurationMs: number;
  gapFirstSeenMap: Map<string, number>;
}

export function durationFilter(input: DurationFilterInput): FilterResult {
  const { pairChainKey, currentSpreadBps, minSpreadBps, minDurationMs, gapFirstSeenMap } = input;

  const absSpread = Math.abs(currentSpreadBps);
  const now = Date.now();

  if (absSpread < minSpreadBps) {
    gapFirstSeenMap.delete(pairChainKey);
    return {
      passed: false,
      reason: 'spread_below_threshold',
    };
  }

  const firstSeenAt = gapFirstSeenMap.get(pairChainKey);

  if (!firstSeenAt) {
    gapFirstSeenMap.set(pairChainKey, now);
    return {
      passed: false,
      reason: 'duration_not_met',
    };
  }

  const duration = now - firstSeenAt;

  if (duration >= minDurationMs) {
    return {
      passed: true,
      reason: 'duration_met',
    };
  }

  return {
    passed: false,
    reason: 'duration_not_met',
  };
}

export interface DepthFilterInput {
  liquidity?: bigint;
  minLiquidityUsd: number;
  dexMid: number;
}

export function depthFilter(input: DepthFilterInput): FilterResult {
  const { liquidity, minLiquidityUsd, dexMid } = input;

  if (liquidity === undefined) {
    return {
      passed: false,
      reason: 'depth_unknown',
    };
  }

  const liquidityDecimal = new Decimal(liquidity.toString());
  const dexMidDecimal = new Decimal(dexMid);
  const liquidityUsd = liquidityDecimal.times(dexMidDecimal).toNumber();

  if (liquidityUsd >= minLiquidityUsd) {
    return {
      passed: true,
      reason: 'depth_sufficient',
    };
  }

  return {
    passed: false,
    reason: 'depth_insufficient',
  };
}

export interface StalenessFilterInput {
  quotes: QuoteWithStaleness[];
}

export function stalenessFilter(input: StalenessFilterInput): FilterResult {
  const { quotes } = input;

  const staleQuotes = quotes.filter((q) => q.isStale);

  if (staleQuotes.length === 0) {
    return {
      passed: true,
      reason: 'quotes_fresh',
    };
  }

  const staleVenues = staleQuotes.map((q) => q.quote.venue).join(', ');

  return {
    passed: false,
    reason: `quotes_stale: ${staleVenues}`,
  };
}

export interface VolatilityFilterInput {
  spreadBps: number;
  minSpreadBps: number;
  volatilityRegime?: 'low' | 'normal' | 'high';
  volatilityAdjustment: boolean;
}

export function volatilityFilter(input: VolatilityFilterInput): FilterResult {
  const { spreadBps, minSpreadBps, volatilityRegime = 'normal', volatilityAdjustment } = input;

  if (!volatilityAdjustment) {
    return {
      passed: true,
      reason: 'volatility_adjustment_disabled',
    };
  }

  let adjustedThreshold = minSpreadBps;

  if (volatilityRegime === 'high') {
    adjustedThreshold = minSpreadBps * 1.5;
  }

  const absSpread = Math.abs(spreadBps);

  if (absSpread >= adjustedThreshold) {
    return {
      passed: true,
      reason: volatilityRegime === 'high' ? 'volatility_high_threshold_met' : 'volatility_normal',
    };
  }

  return {
    passed: false,
    reason: 'volatility_high_threshold_not_met',
  };
}

export interface AnchorConfidenceFilterInput {
  confidence: 'high' | 'medium' | 'low';
  anchorDivergenceBps?: number;
}

export function anchorConfidenceFilter(input: AnchorConfidenceFilterInput): FilterResult {
  const { confidence, anchorDivergenceBps } = input;

  if (confidence === 'low') {
    return {
      passed: false,
      reason: `anchors_divergent: ${anchorDivergenceBps?.toFixed(2)}bps`,
    };
  }

  if (confidence === 'medium') {
    return {
      passed: true,
      reason: `anchors_moderate_agreement: ${anchorDivergenceBps?.toFixed(2)}bps`,
    };
  }

  return {
    passed: true,
    reason: 'anchors_agree',
  };
}

export interface TimeAlignmentFilterInput {
  anchorQuote: NormalizedQuote;
  dexQuote: NormalizedQuote;
  maxTimeSkewMs: number;
}

export function timeAlignmentFilter(input: TimeAlignmentFilterInput): FilterResult {
  const { anchorQuote, dexQuote, maxTimeSkewMs } = input;

  const tAnchor = anchorQuote.exchangeTsMs ?? anchorQuote.receivedTsMs;
  const tDex = dexQuote.blockTsMs ?? dexQuote.receivedTsMs;

  const skew = Math.abs(tAnchor - tDex);

  if (skew > maxTimeSkewMs) {
    return {
      passed: false,
      reason: `time_skew: ${skew.toFixed(0)}ms > ${maxTimeSkewMs}ms`,
    };
  }

  return {
    passed: true,
    reason: `time_aligned: ${skew.toFixed(0)}ms`,
  };
}

export function getMaxTimeSkewMs(chain: Chain): number {
  switch (chain) {
    case 'base':
      return 1500;
    case 'mainnet':
      return 3000;
    default:
      return 1500;
  }
}

export interface ThinMarketBufferFilterInput {
  spreadBps: number;
  minSpreadBps: number;
  thinMarketBufferBps: number;
  hasThinMarketQuotes: boolean;
}

export function thinMarketBufferFilter(input: ThinMarketBufferFilterInput): FilterResult {
  const { spreadBps, minSpreadBps, thinMarketBufferBps, hasThinMarketQuotes } = input;

  if (!hasThinMarketQuotes) {
    return {
      passed: true,
      reason: 'no_thin_market_quotes',
    };
  }

  const adjustedThreshold = minSpreadBps + thinMarketBufferBps;
  const absSpread = Math.abs(spreadBps);

  if (absSpread >= adjustedThreshold) {
    return {
      passed: true,
      reason: `thin_market_buffer_met: ${absSpread.toFixed(1)} >= ${adjustedThreshold.toFixed(1)}`,
    };
  }

  return {
    passed: false,
    reason: `thin_market_buffer_not_met: ${absSpread.toFixed(1)} < ${adjustedThreshold.toFixed(1)}`,
  };
}
