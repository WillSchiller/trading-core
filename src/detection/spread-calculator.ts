import { Decimal } from 'decimal.js';
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

  const anchorMid = new Decimal(anchorQuote.mid);
  const dexMid = new Decimal(dexQuote.mid);

  const spreadBps = dexMid.minus(anchorMid).dividedBy(anchorMid).times(10000).toNumber();

  const direction: 'buy_dex' | 'sell_dex' = spreadBps < 0 ? 'buy_dex' : 'sell_dex';

  let confidence: 'high' | 'medium' | 'low' = 'high';
  let anchorDivergenceBps: number | undefined;
  let confirmMid: number | undefined;

  if (confirmQuote) {
    confirmMid = confirmQuote.mid;
    const confirmMidDecimal = new Decimal(confirmMid);
    const divergence = confirmMidDecimal
      .minus(anchorMid)
      .dividedBy(anchorMid)
      .times(10000)
      .abs()
      .toNumber();

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
    anchorMid: anchorMid.toNumber(),
    confirmMid,
    dexMid: dexMid.toNumber(),
    confidence,
    anchorDivergenceBps,
  };
}

export function calculateSpreadBps(params: { cexMid: number; dexMid: number }): number {
  const { cexMid, dexMid } = params;
  const cex = new Decimal(cexMid);
  const dex = new Decimal(dexMid);
  return dex.minus(cex).dividedBy(cex).times(10000).toNumber();
}

export function determineDirection(spreadBps: number): 'buy_dex' | 'sell_dex' {
  return spreadBps < 0 ? 'buy_dex' : 'sell_dex';
}
