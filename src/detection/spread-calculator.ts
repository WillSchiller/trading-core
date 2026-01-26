import type { NormalizedQuote } from '../types/index.js';

export interface SpreadResult {
  spreadBps: number;
  direction: 'buy_dex' | 'sell_dex';
  anchorMid: number;
  confirmMid?: number;
  dexMid: number;
  confidence: 'high' | 'medium' | 'low';
  anchorDivergenceBps?: number;
}

export interface SpreadCalculationInput {
  anchorQuote: NormalizedQuote;
  confirmQuote?: NormalizedQuote;
  dexQuote: NormalizedQuote;
}

const ANCHOR_DIVERGENCE_THRESHOLD_BPS = 10;

export function calculateSpread(input: SpreadCalculationInput): SpreadResult {
  const { anchorQuote, confirmQuote, dexQuote } = input;

  const anchorMid = anchorQuote.mid;
  const dexMid = dexQuote.mid;

  const spreadBps = ((dexMid - anchorMid) / anchorMid) * 10000;

  const direction: 'buy_dex' | 'sell_dex' = spreadBps < 0 ? 'buy_dex' : 'sell_dex';

  let confidence: 'high' | 'medium' | 'low' = 'high';
  let anchorDivergenceBps: number | undefined;
  let confirmMid: number | undefined;

  if (confirmQuote) {
    confirmMid = confirmQuote.mid;
    const divergence = Math.abs(((confirmMid - anchorMid) / anchorMid) * 10000);

    anchorDivergenceBps = divergence;

    if (divergence > ANCHOR_DIVERGENCE_THRESHOLD_BPS) {
      confidence = 'low';
    } else if (divergence > ANCHOR_DIVERGENCE_THRESHOLD_BPS / 2) {
      confidence = 'medium';
    }
  }

  return {
    spreadBps,
    direction,
    anchorMid,
    confirmMid,
    dexMid,
    confidence,
    anchorDivergenceBps,
  };
}

export function calculateSpreadBps(params: { cexMid: number; dexMid: number }): number {
  const { cexMid, dexMid } = params;
  return ((dexMid - cexMid) / cexMid) * 10000;
}

export function determineDirection(spreadBps: number): 'buy_dex' | 'sell_dex' {
  return spreadBps < 0 ? 'buy_dex' : 'sell_dex';
}
