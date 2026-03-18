import type { PMMBookSnapshot, PMMQuote, PMMConfig, PMMPosition } from './types.js';

const LOGIT_CLAMP_MIN = 0.001;
const LOGIT_CLAMP_MAX = 0.999;
const QUOTE_STOP_MIN = 0.05;
const QUOTE_STOP_MAX = 0.95;
const MIN_RESOLUTION_TAU_S = 300; // 5 min
const EWMA_ALPHA = 0.06;
const JUMP_SIGMA_THRESHOLD = 3;

// Numerically stable sigmoid: branch on sign to avoid exp overflow
function sigmoid(x: number): number {
  if (x >= 0) {
    const ex = Math.exp(-x);
    return 1 / (1 + ex);
  }
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

function logit(p: number): number {
  const clamped = Math.min(LOGIT_CLAMP_MAX, Math.max(LOGIT_CLAMP_MIN, p));
  return Math.log(clamped / (1 - clamped));
}

// Tick-round to Polymarket's 0.01 cents (0.001 in price units, effectively 0.1 cents)
// Polymarket prices are in [0, 1] with tick size 0.01
function tickRound(price: number, tickSize = 0.01): number {
  return Math.round(price / tickSize) * tickSize;
}

export interface LogitVolState {
  ewmaVar: number;
  lastLogitMid: number | null;
  lastUpdateMs: number;
}

export function updateLogitVol(
  state: LogitVolState,
  currentMid: number,
  nowMs: number,
): { vol: number; jumped: boolean } {
  const currentLogit = logit(currentMid);
  let jumped = false;

  if (state.lastLogitMid !== null) {
    const dt = (nowMs - state.lastUpdateMs) / 1000;
    if (dt > 0.5 && dt < 120) {
      const logitReturn = currentLogit - state.lastLogitMid;
      const retPerSec = (logitReturn * logitReturn) / dt;

      // Jump filter: if |return| > 3σ, don't update EWMA
      const currentSigma = Math.sqrt(state.ewmaVar * dt);
      if (currentSigma > 0 && Math.abs(logitReturn) > JUMP_SIGMA_THRESHOLD * currentSigma) {
        jumped = true;
        // Don't update EWMA, use inflated vol
        state.lastLogitMid = currentLogit;
        state.lastUpdateMs = nowMs;
        return { vol: state.ewmaVar * 4, jumped: true };
      }

      state.ewmaVar = EWMA_ALPHA * retPerSec + (1 - EWMA_ALPHA) * state.ewmaVar;
    }
  }

  state.lastLogitMid = currentLogit;
  state.lastUpdateMs = nowMs;
  return { vol: state.ewmaVar, jumped };
}

export function computeQuote(
  book: PMMBookSnapshot,
  config: PMMConfig,
  position: PMMPosition | undefined,
  volState: LogitVolState,
  endDateMs: number,
  nowMs: number = Date.now(),
): PMMQuote | null {
  const mid = book.midPrice;

  // Don't quote outside safe range
  if (mid < QUOTE_STOP_MIN || mid > QUOTE_STOP_MAX) return null;

  // Resolution-aware tau
  const timeToResolutionS = Math.max(0, (endDateMs - nowMs) / 1000);
  if (timeToResolutionS < MIN_RESOLUTION_TAU_S) return null;

  const tauMM = 300; // 5 min default horizon
  const tau = Math.min(tauMM, timeToResolutionS);

  // Transform to logit space
  const logitMid = logit(mid);
  const sigma2 = volState.ewmaVar || 0.001; // floor to avoid zero

  // Inventory in position-size units
  const netShares = position?.netShares || 0;
  const q = netShares / config.positionSizeUsd;

  // A-S reservation price in logit space
  const gamma = config.gamma;
  const logitReservation = logitMid - q * gamma * sigma2 * tau;

  // A-S half-spread in logit space
  const volHalfSpread = Math.sqrt(sigma2 * tau);
  // Convert min spread cents to logit delta at current mid
  const minSpreadProb = config.minSpreadCents / 100;
  const logitHigh = logit(Math.min(LOGIT_CLAMP_MAX, mid + minSpreadProb / 2));
  const logitLow = logit(Math.max(LOGIT_CLAMP_MIN, mid - minSpreadProb / 2));
  const minLogitHalfSpread = (logitHigh - logitLow) / 2;
  const halfSpreadLogit = Math.max(minLogitHalfSpread, volHalfSpread);

  // Map back to probability space
  const bidLogit = logitReservation - halfSpreadLogit;
  const askLogit = logitReservation + halfSpreadLogit;
  let bidPrice = sigmoid(bidLogit);
  let askPrice = sigmoid(askLogit);

  // Enforce bounds
  bidPrice = Math.max(0.01, Math.min(0.98, bidPrice));
  askPrice = Math.max(0.02, Math.min(0.99, askPrice));
  if (bidPrice >= askPrice) return null;

  // Per-side inventory limits near resolution
  const hoursToResolution = timeToResolutionS / 3600;
  if (hoursToResolution < 12) {
    const maxInv = config.maxInventoryUsd * (hoursToResolution / 12);
    if (netShares > 0 && netShares * mid > maxInv) {
      // Skew hard to sell: widen bid, tighten ask
      bidPrice = Math.max(0.01, bidPrice - 0.02);
    }
    if (netShares < 0 && Math.abs(netShares) * mid > maxInv) {
      askPrice = Math.min(0.99, askPrice + 0.02);
    }
  }

  // Tick-round
  bidPrice = tickRound(bidPrice);
  askPrice = tickRound(askPrice);
  if (bidPrice >= askPrice) askPrice = bidPrice + 0.01;

  const reservationPrice = sigmoid(logitReservation);
  const halfSpreadProb = (askPrice - bidPrice) / 2;

  return {
    tokenId: book.tokenId,
    conditionId: book.conditionId,
    side: 'YES',
    bidPrice,
    askPrice,
    bidSize: config.positionSizeUsd,
    askSize: config.positionSizeUsd,
    midPrice: mid,
    reservationPrice,
    halfSpreadProb,
    logitMid,
    ewmaVol: sigma2,
    tau,
    inventory: q,
  };
}

// Derive No quotes from Yes model
export function deriveNoQuotes(yesQuote: PMMQuote): { noBid: number; noAsk: number } {
  return {
    noBid: tickRound(1 - yesQuote.askPrice),
    noAsk: tickRound(1 - yesQuote.bidPrice),
  };
}
