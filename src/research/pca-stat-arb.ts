import { EventEmitter } from 'events';
import * as math from 'mathjs';
import { createChildLogger, type Logger } from '../utils/logger.js';

export type RegimeState = 'bullish' | 'bearish' | 'neutral';
export type ExitReason = 'zscore' | 'zero_cross' | 'time_stop' | 'trailing_stop' | 'stop_loss' | 'stall_exit';
export type ShadowExitReason = 'zero_cross' | 'shadow_time_stop';

export interface ShadowPosition {
  signalTimestamp: number;
  asset: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryZScoreSign: number;
  shadowStartTimestamp: number;
  peakPnlBps: number;
  troughPnlBps: number;
  lastPnlBps: number;
  cumulativePC1Return: number;
  entryPC1Loading: number;
  realExitReason: ExitReason;
}

export interface PCAShadowExitEvent {
  signalTimestamp: number;
  asset: string;
  direction: 'long' | 'short';
  entryPrice: number;
  shadowExitTimestamp: number;
  shadowExitPrice: number;
  shadowPnlBps: number;
  shadowPeakPnlBps: number;
  shadowTroughPnlBps: number;
  shadowHoldTimeMs: number;
  shadowExitReason: ShadowExitReason;
  shadowPC1PnlBps: number;
  shadowResidualPnlBps: number;
  realExitReason: ExitReason;
}

export interface PnLAttribution {
  totalPnlBps: number;
  pc1PnlBps: number;
  residualPnlBps: number;
  pc1PctOfTotal: number;
  cumulativePC1Return: number;
  pc1Loading: number;
}

export interface RegimeGatingConfig {
  enabled: boolean;
  ewmaSpan: number;
  regimeThreshold: number;
  hysteresisTicks: number;
  minVolatilityBps?: number;
  maxPC1DisplacementBps?: number;
  pc1DisplacementLookback?: number;
}

export interface ExposureLimitsConfig {
  maxPositionsLong: number;
  maxPositionsShort: number;
  maxPositionsTotal: number;
}

export type SizingMode = 'flat' | 'vol_adjusted' | 'factor_neutral';

export interface SizingConfig {
  mode: SizingMode;
  baseNotionalUsd: number;
  minPositionUsd: number;
  maxPositionUsd: number;
  targetVolBps?: number;
  loadingSmoothingSpan?: number;
  maxPortfolioPC1ExposureUsd?: number;
}

export interface LongConfig {
  enabled: boolean;
  entryZScore: number;
  exitZScore: number;
  maxHoldTimeMs: number;
  minHoldTimeMs: number;
  zeroCrossExit: boolean;
  stopLossBps: number;
  requireRegimeConfirmation: boolean;
}

export interface TrailingExitConfig {
  enabled: boolean;
  activationPnlBps: number;
  trailStopBps: number;
  minHoldTimeMs?: number;
}

export interface ShortConfig {
  entryZScore: number;
  maxEntryZScore?: number;
  exitZScore: number;
  maxHoldTimeMs: number;
  minHoldTimeMs: number;
  zeroCrossExit: boolean;
  zscoreExit: boolean;
  stopLossBps: number;
  stopLossIgnoresMinHold: boolean;
  trailingExit: TrailingExitConfig;
  stallExitMs?: number;
  stallExitMinPeakBps?: number;
}

export interface OrphanCleanupConfig {
  maxStaleMs: number;
}

export interface PCAConfig {
  assets: string[];
  returnWindowMs: number;
  pcaLookbackPeriods: number;
  numFactors: number;
  minVarianceExplained: number;
  residualLookbackPeriods: number;
  entryZScore: number;
  exitZScore: number;
  tickIntervalMs: number;
  pcaRefreshPeriods: number;
  positionSizeUsd: number;
  regimeGating: RegimeGatingConfig;
  exposureLimits: ExposureLimitsConfig;
  sizing: SizingConfig;
  long: LongConfig;
  short: ShortConfig;
  orphanCleanup?: OrphanCleanupConfig;
  blockedHoursUtc?: number[];
}

const DEFAULT_CONFIG: PCAConfig = {
  assets: ['ETH', 'BTC', 'SOL', 'AVAX', 'MATIC', 'ARB'],
  returnWindowMs: 60000,
  pcaLookbackPeriods: 60,
  numFactors: 2,
  minVarianceExplained: 0.7,
  residualLookbackPeriods: 30,
  entryZScore: 2.0,
  exitZScore: 0.5,
  tickIntervalMs: 60000,
  pcaRefreshPeriods: 15,
  positionSizeUsd: 100,
  regimeGating: {
    enabled: true,
    ewmaSpan: 10,
    regimeThreshold: 0.5,
    hysteresisTicks: 3,
  },
  exposureLimits: {
    maxPositionsLong: 3,
    maxPositionsShort: 5,
    maxPositionsTotal: 6,
  },
  sizing: {
    mode: 'factor_neutral',
    baseNotionalUsd: 100,
    minPositionUsd: 25,
    maxPositionUsd: 200,
    targetVolBps: 100,
    loadingSmoothingSpan: 20,
    maxPortfolioPC1ExposureUsd: 150,
  },
  long: {
    enabled: true,
    entryZScore: 3.0,
    exitZScore: 0.0,
    maxHoldTimeMs: 21600000,
    minHoldTimeMs: 2700000,
    zeroCrossExit: true,
    stopLossBps: 150,
    requireRegimeConfirmation: true,
  },
  short: {
    entryZScore: 2.5,
    exitZScore: 0.0,
    maxHoldTimeMs: 43200000,
    minHoldTimeMs: 1800000,
    zeroCrossExit: false,
    zscoreExit: true,
    stopLossBps: 150,
    stopLossIgnoresMinHold: false,
    trailingExit: {
      enabled: true,
      activationPnlBps: 25,
      trailStopBps: 20,
    },
  },
};

export interface FactorModel {
  eigenvectors: number[][];
  eigenvalues: number[];
  varianceExplained: number[];
  assetBetas: Map<string, number[]>;
  timestamp: number;
}

export interface AssetSignal {
  asset: string;
  timestamp: number;
  actualReturn: number;
  expectedReturn: number;
  residual: number;
  residualZScore: number;
  signal: 'long' | 'short' | 'neutral';
  factorContributions: number[];
  factorReturns: number[];
}

export interface PCASignalEvent {
  timestamp: number;
  asset: string;
  direction: 'long' | 'short';
  zScore: number;
  residual: number;
  confidence: number;
  entryPrice: number;
  positionSizeUsd: number;
  factorContext: {
    pc1Return: number;
    pc2Return: number;
  };
  allAssetResiduals: Record<string, number>;
}

export interface PCAExitEvent extends PCASignalEvent {
  exitTimestamp: number;
  exitZScore: number;
  holdTimeMs: number;
  exitPrice: number;
  pnlBps: number;
  exitReason: ExitReason;
  peakPnlBps: number;
  troughPnlBps: number;
  regimeState: RegimeState;
  attribution: PnLAttribution;
}

export interface ActivePosition extends PCASignalEvent {
  peakPnlBps: number;
  troughPnlBps: number;
  lastPnlBps: number;
  trailingActivated: boolean;
  cumulativePC1Return: number;
  entryPC1Loading: number;
}

export class PCAStatArbMonitor extends EventEmitter {
  private config: PCAConfig;
  private logger: Logger;
  private priceHistory: Map<string, { price: number; ts: number }[]> = new Map();
  private returnHistory: Map<string, number[]> = new Map();
  private factorModel: FactorModel | null = null;
  private residualHistory: Map<string, number[]> = new Map();
  private activeSignals: Map<string, PCASignalEvent> = new Map();
  private activePositions: Map<string, ActivePosition> = new Map();
  private benchmarkPositions: Map<string, ActivePosition> = new Map();
  private shadowPositions: Map<string, ShadowPosition[]> = new Map();
  private static readonly SHADOW_MAX_HOLD_MS = 12 * 60 * 60 * 1000;
  private tickCount: number = 0;
  private tickInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private pc1ReturnHistory: number[] = [];
  private regimeState: RegimeState = 'neutral';
  private pc1Momentum: number = 0;
  private ewmaMean: number = 0;
  private ewmaVar: number = 0;
  private ewmaVol: number = 0;
  private pc1DisplacementBps: number = 0;
  private pendingRegime: RegimeState = 'neutral';
  private regimeTickCount: number = 0;
  private smoothedPC1Loadings: Map<string, number> = new Map();

  constructor(config: Partial<PCAConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createChildLogger({ component: 'pca-stat-arb' });

    for (const asset of this.config.assets) {
      this.priceHistory.set(asset, []);
      this.returnHistory.set(asset, []);
      this.residualHistory.set(asset, []);
    }
  }

  start(): void {
    if (this.isRunning) {
      this.logger.warn('PCA monitor already running');
      return;
    }

    this.isRunning = true;
    this.logger.info(
      {
        assets: this.config.assets,
        numFactors: this.config.numFactors,
        entryZScore: this.config.entryZScore,
        tickIntervalMs: this.config.tickIntervalMs,
        longEnabled: this.config.long.enabled,
        shortEntryZScore: this.config.short.entryZScore,
        shortTrailingEnabled: this.config.short.trailingExit.enabled,
        shortZscoreExit: this.config.short.zscoreExit,
        shortZeroCrossExit: this.config.short.zeroCrossExit,
        shortStopLossBps: this.config.short.stopLossBps,
        shortStopLossIgnoresMinHold: this.config.short.stopLossIgnoresMinHold,
        shortMaxHoldTimeMs: this.config.short.maxHoldTimeMs,
        longStopLossBps: this.config.long.stopLossBps,
      },
      'PCA stat-arb monitor started'
    );

    this.tickInterval = setInterval(() => this.tick(), this.config.tickIntervalMs);
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.isRunning = false;
    this.logger.info('PCA stat-arb monitor stopped');
  }

  loadPositions(positions: Array<{
    timestamp: number;
    asset: string;
    direction: 'long' | 'short';
    zScore: number;
    residual: number;
    entryPrice: number;
    positionSizeUsd: number;
    pc1Return: number;
    pc2Return: number;
    confidence: number;
  }>): void {
    for (const pos of positions) {
      const activePos: ActivePosition = {
        timestamp: pos.timestamp,
        asset: pos.asset,
        direction: pos.direction,
        zScore: pos.zScore,
        residual: pos.residual,
        confidence: pos.confidence,
        entryPrice: pos.entryPrice,
        positionSizeUsd: pos.positionSizeUsd,
        factorContext: { pc1Return: pos.pc1Return, pc2Return: pos.pc2Return },
        allAssetResiduals: {},
        peakPnlBps: 0,
        troughPnlBps: 0,
        lastPnlBps: 0,
        trailingActivated: false,
        cumulativePC1Return: 0,
        entryPC1Loading: this.getPC1Loading(pos.asset),
      };
      this.activePositions.set(pos.asset, activePos);
      this.activeSignals.set(pos.asset, activePos);
    }
    this.logger.info({ count: positions.length }, 'Loaded active positions from database');
  }

  loadPriceHistory(history: Map<string, Array<{ price: number; ts: number }>>): void {
    let totalLoaded = 0;
    for (const [asset, prices] of history) {
      const assetHistory = this.priceHistory.get(asset);
      if (assetHistory && prices.length > 0) {
        assetHistory.push(...prices);
        totalLoaded += prices.length;
      }
    }
    this.logger.info({ totalLoaded, assets: history.size }, 'Loaded price history from database');
  }

  getCurrentPricesSnapshot(): Record<string, number> {
    const prices: Record<string, number> = {};
    for (const asset of this.config.assets) {
      const price = this.getCurrentPrice(asset);
      if (price > 0) prices[asset] = price;
    }
    return prices;
  }

  updatePrice(asset: string, price: number): void {
    if (!this.config.assets.includes(asset)) return;

    const history = this.priceHistory.get(asset);
    if (!history) return;

    const now = Date.now();
    history.push({ price, ts: now });

    if (history.length % 10 === 0) {
      this.logger.info({ asset, price, historyLength: history.length }, 'Price update received');
    }

    const maxPoints = this.config.pcaLookbackPeriods * 3;
    while (history.length > maxPoints) {
      history.shift();
    }
  }

  private tick(): void {
    const now = Date.now();
    this.tickCount++;
    this.logger.info({ tickCount: this.tickCount, activePositions: this.activePositions.size }, 'Tick started');

    // CRITICAL: Check time-stops for ALL active positions FIRST
    // This must run even when signal data is incomplete
    this.checkAllPositionExits(now);

    const returns = this.computeReturns(now);
    this.logger.info({ returnsCount: Object.keys(returns).length, required: this.config.assets.length }, 'Returns computed');
    if (Object.keys(returns).length < this.config.assets.length) {
      const priceHistorySizes: Record<string, number> = {};
      for (const asset of this.config.assets) {
        priceHistorySizes[asset] = this.priceHistory.get(asset)?.length ?? 0;
      }
      this.logger.info(
        { assetsWithData: Object.keys(returns).length, required: this.config.assets.length, priceHistorySizes },
        'Insufficient price data, waiting'
      );
      return;
    }

    this.updateReturnHistory(returns);

    if (!this.factorModel || this.tickCount % this.config.pcaRefreshPeriods === 0) {
      this.refreshFactorModel();
    }

    if (!this.factorModel) {
      this.logger.debug('No factor model yet, need more data');
      return;
    }

    const signals = this.computeSignals(returns, now);

    if (signals.length > 0 && signals[0].factorReturns[0] !== undefined) {
      this.computeRegimeState(signals[0].factorReturns[0]);
    }

    this.processSignals(signals, now);
    this.checkBenchmarkExits(now);
    this.updateShadowPositions(signals, now);
    this.logSummary(returns, signals);

    if (signals.length > 0) {
      this.emit('residuals', signals);
    }
  }

  private checkAllPositionExits(now: number): void {
    if (this.activePositions.size > 0) {
      const positionSummary = Array.from(this.activePositions.entries()).map(([asset, pos]) => ({
        asset,
        dir: pos.direction,
        holdMin: ((now - pos.timestamp) / 60000).toFixed(1),
        hasPrice: this.getCurrentPrice(asset) > 0,
      }));
      this.logger.info({ positions: positionSummary }, 'Checking positions for price-based exits');
    }

    const toRemove: string[] = [];
    for (const [asset, position] of this.activePositions) {
      const currentPrice = this.getCurrentPrice(asset);
      if (currentPrice <= 0) {
        this.logger.warn({ asset, direction: position.direction }, 'Cannot check exit - no price data');
        continue;
      }

      const holdTimeMs = now - position.timestamp;
      const direction = position.direction;
      const dirConfig = direction === 'long' ? this.config.long : this.config.short;
      const maxHoldTimeMs = dirConfig.maxHoldTimeMs ?? Infinity;
      const minHoldTimeMs = dirConfig.minHoldTimeMs ?? 0;

      const entryPrice = position.entryPrice;
      let pnlBps = 0;
      if (entryPrice > 0) {
        const priceChange = (currentPrice - entryPrice) / entryPrice;
        pnlBps = direction === 'long' ? priceChange * 10000 : -priceChange * 10000;
      }
      position.lastPnlBps = pnlBps;
      position.peakPnlBps = Math.max(position.peakPnlBps, pnlBps);
      position.troughPnlBps = Math.min(position.troughPnlBps, pnlBps);

      let exitReason: ExitReason | null = null;

      // 1. Hard stop-loss
      const stopLossBps = dirConfig.stopLossBps ?? 100;
      const ignoresMinHold = direction === 'short'
        ? this.config.short.stopLossIgnoresMinHold
        : false;
      if (pnlBps <= -stopLossBps && (ignoresMinHold || holdTimeMs >= minHoldTimeMs)) {
        exitReason = 'stop_loss';
      }

      // 2. Time stop
      if (!exitReason && holdTimeMs >= maxHoldTimeMs) {
        exitReason = 'time_stop';
      }

      // 3. Trailing stop — gated by optional minHoldTimeMs
      if (!exitReason && direction === 'short' && this.config.short.trailingExit.enabled) {
        const { activationPnlBps, trailStopBps, minHoldTimeMs: trailingMinHold } = this.config.short.trailingExit;
        if (pnlBps >= activationPnlBps) {
          position.trailingActivated = true;
        }
        if (position.trailingActivated && holdTimeMs >= (trailingMinHold ?? 0)) {
          const drawdownFromPeak = position.peakPnlBps - pnlBps;
          if (drawdownFromPeak >= trailStopBps) {
            exitReason = 'trailing_stop';
          }
        }
      }

      if (exitReason) {
        this.logger.info(
          {
            asset,
            direction,
            exitReason,
            holdTimeMin: (holdTimeMs / 60000).toFixed(1),
            maxHoldTimeMin: (maxHoldTimeMs / 60000).toFixed(1),
            entryPrice,
            exitPrice: currentPrice,
            pnlBps: pnlBps.toFixed(1),
          },
          'Price-based exit triggered'
        );

        const attribution = this.computeAttribution(position);
        const exitEvent: PCAExitEvent = {
          ...position,
          exitTimestamp: now,
          exitZScore: 0,
          holdTimeMs,
          exitPrice: currentPrice,
          pnlBps,
          exitReason,
          peakPnlBps: position.peakPnlBps,
          troughPnlBps: position.troughPnlBps,
          regimeState: this.regimeState,
          attribution,
        };

        this.emit('exit', exitEvent);
        if (this.shouldShadow(exitReason, holdTimeMs)) {
          this.addShadowPosition(position, now, exitReason);
        }
        toRemove.push(asset);
      }
    }

    for (const asset of toRemove) {
      this.activePositions.delete(asset);
      this.activeSignals.delete(asset);
    }
  }

  private createBenchmarkEntry(pcaAsset: string, now: number, _signals: AssetSignal[]): void {
    const candidates = this.config.assets.filter(a =>
      a !== pcaAsset &&
      !this.activePositions.has(a) &&
      !this.benchmarkPositions.has(a) &&
      this.getCurrentPrice(a) > 0
    );
    if (candidates.length === 0) return;

    const randomAsset = candidates[Math.floor(Math.random() * candidates.length)];
    const price = this.getCurrentPrice(randomAsset);
    const benchmarkKey = `bench_${randomAsset}_${now}`;

    const position: ActivePosition = {
      timestamp: now,
      asset: randomAsset,
      direction: 'short',
      zScore: 0,
      residual: 0,
      confidence: 0,
      entryPrice: price,
      positionSizeUsd: 100,
      factorContext: { pc1Return: 0, pc2Return: 0 },
      allAssetResiduals: {},
      peakPnlBps: 0,
      troughPnlBps: 0,
      lastPnlBps: 0,
      trailingActivated: false,
      cumulativePC1Return: 0,
      entryPC1Loading: 0,
    };

    this.benchmarkPositions.set(benchmarkKey, position);
    this.emit('benchmark_signal', { ...position, direction: 'random_short' as const });
  }

  private checkBenchmarkExits(now: number): void {
    const toRemove: string[] = [];
    const trailingCfg = this.config.short.trailingExit;
    const maxHoldTimeMs = this.config.short.maxHoldTimeMs ?? 14400000;

    for (const [key, pos] of this.benchmarkPositions) {
      const currentPrice = this.getCurrentPrice(pos.asset);
      if (currentPrice <= 0) continue;

      const holdTimeMs = now - pos.timestamp;
      const priceChange = (currentPrice - pos.entryPrice) / pos.entryPrice;
      const pnlBps = -priceChange * 10000;

      pos.lastPnlBps = pnlBps;
      pos.peakPnlBps = Math.max(pos.peakPnlBps, pnlBps);
      pos.troughPnlBps = Math.min(pos.troughPnlBps, pnlBps);

      let exitReason: ExitReason | null = null;

      if (holdTimeMs >= maxHoldTimeMs) {
        exitReason = 'time_stop';
      }

      if (!exitReason && trailingCfg.enabled) {
        if (pnlBps >= trailingCfg.activationPnlBps) pos.trailingActivated = true;
        if (pos.trailingActivated && holdTimeMs >= (trailingCfg.minHoldTimeMs ?? 0)) {
          if (pos.peakPnlBps - pnlBps >= trailingCfg.trailStopBps) {
            exitReason = 'trailing_stop';
          }
        }
      }

      if (exitReason) {
        this.emit('benchmark_exit', {
          asset: pos.asset,
          direction: 'random_short',
          entryPrice: pos.entryPrice,
          exitPrice: currentPrice,
          pnlBps,
          peakPnlBps: pos.peakPnlBps,
          troughPnlBps: pos.troughPnlBps,
          holdTimeMs,
          exitReason,
          timestamp: pos.timestamp,
        });
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      this.benchmarkPositions.delete(key);
    }
  }

  private computeReturns(now: number): Record<string, number> {
    const returns: Record<string, number> = {};
    const windowStart = now - this.config.returnWindowMs;

    for (const asset of this.config.assets) {
      const history = this.priceHistory.get(asset);
      if (!history || history.length < 2) continue;

      const startPrice = this.findPriceAtTime(history, windowStart);
      const endPrice = history[history.length - 1].price;

      if (startPrice && endPrice && startPrice > 0) {
        returns[asset] = (endPrice - startPrice) / startPrice;
      }
    }

    return returns;
  }

  private findPriceAtTime(
    history: { price: number; ts: number }[],
    targetTs: number
  ): number | null {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].ts <= targetTs) {
        return history[i].price;
      }
    }
    return history[0]?.price ?? null;
  }

  private updateReturnHistory(returns: Record<string, number>): void {
    for (const asset of this.config.assets) {
      const history = this.returnHistory.get(asset);
      if (!history) continue;

      if (returns[asset] !== undefined) {
        history.push(returns[asset]);

        while (history.length > this.config.pcaLookbackPeriods) {
          history.shift();
        }
      }
    }
  }

  private refreshFactorModel(): void {
    const minPeriods = Math.floor(this.config.pcaLookbackPeriods * 0.8);
    for (const asset of this.config.assets) {
      const history = this.returnHistory.get(asset);
      if (!history || history.length < minPeriods) {
        return;
      }
    }

    try {
      const numPeriods = Math.min(
        ...this.config.assets.map((a) => this.returnHistory.get(a)?.length ?? 0)
      );

      const returnMatrix: number[][] = [];
      for (let t = 0; t < numPeriods; t++) {
        const row: number[] = [];
        for (const asset of this.config.assets) {
          const history = this.returnHistory.get(asset)!;
          row.push(history[history.length - numPeriods + t]);
        }
        returnMatrix.push(row);
      }

      const covMatrix = this.computeCovarianceMatrix(returnMatrix);
      const { eigenvectors, eigenvalues } = this.eigenDecomposition(covMatrix);

      const indices = eigenvalues
        .map((_, i) => i)
        .sort((a, b) => eigenvalues[b] - eigenvalues[a]);
      const sortedEigenvalues = indices.map((i) => eigenvalues[i]);
      const sortedEigenvectors = indices.map((i) => eigenvectors[i]);

      const totalVariance = sortedEigenvalues.reduce((a, b) => a + b, 0);
      const varianceExplained: number[] = [];
      let cumulative = 0;
      for (const ev of sortedEigenvalues) {
        cumulative += ev / totalVariance;
        varianceExplained.push(cumulative);
      }

      let numFactors = this.config.numFactors;
      for (let i = 0; i < varianceExplained.length; i++) {
        if (varianceExplained[i] >= this.config.minVarianceExplained) {
          numFactors = Math.max(numFactors, i + 1);
          break;
        }
      }
      numFactors = Math.min(numFactors, sortedEigenvectors.length);

      const assetBetas = new Map<string, number[]>();
      for (let i = 0; i < this.config.assets.length; i++) {
        const betas: number[] = [];
        for (let f = 0; f < numFactors; f++) {
          betas.push(sortedEigenvectors[f][i]);
        }
        assetBetas.set(this.config.assets[i], betas);
      }

      this.factorModel = {
        eigenvectors: sortedEigenvectors.slice(0, numFactors),
        eigenvalues: sortedEigenvalues.slice(0, numFactors),
        varianceExplained: varianceExplained.slice(0, numFactors),
        assetBetas,
        timestamp: Date.now(),
      };

      this.logger.info(
        {
          numFactors,
          varianceExplained: varianceExplained
            .slice(0, numFactors)
            .map((v) => `${(v * 100).toFixed(1)}%`),
          pc1Loadings: Object.fromEntries(
            this.config.assets.map((a, i) => [a, sortedEigenvectors[0][i].toFixed(3)])
          ),
        },
        'Factor model updated'
      );

      this.updateSmoothedLoadings();
      this.emit('factorModel', this.factorModel);
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, 'Failed to compute factor model');
    }
  }

  private updateSmoothedLoadings(): void {
    if (!this.factorModel) return;
    const span = this.config.sizing.loadingSmoothingSpan ?? 20;
    const alpha = 2 / (span + 1);

    for (const [asset, betas] of this.factorModel.assetBetas) {
      const rawLoading = betas[0] ?? 0;
      const prevSmoothed = this.smoothedPC1Loadings.get(asset) ?? rawLoading;
      const newSmoothed = alpha * rawLoading + (1 - alpha) * prevSmoothed;
      this.smoothedPC1Loadings.set(asset, newSmoothed);
    }
  }

  private computeCovarianceMatrix(returns: number[][]): number[][] {
    const n = returns[0].length;
    const T = returns.length;

    const means: number[] = new Array(n).fill(0);
    for (const row of returns) {
      for (let i = 0; i < n; i++) {
        means[i] += row[i];
      }
    }
    for (let i = 0; i < n; i++) {
      means[i] /= T;
    }

    const cov: number[][] = Array(n)
      .fill(null)
      .map(() => Array(n).fill(0));
    for (const row of returns) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          cov[i][j] += (row[i] - means[i]) * (row[j] - means[j]);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        cov[i][j] /= T - 1;
      }
    }

    return cov;
  }

  private eigenDecomposition(matrix: number[][]): {
    eigenvectors: number[][];
    eigenvalues: number[];
  } {
    const result = math.eigs(matrix);

    const eigenvalues: number[] = (result.values as unknown as number[]).map((v: unknown) =>
      typeof v === 'number' ? v : (v as { re: number }).re ?? 0
    );

    const eigenvectors: number[][] = [];
    const vectors = result.eigenvectors;
    for (let i = 0; i < vectors.length; i++) {
      const vec: number[] = (vectors[i].vector as unknown as number[]).map((v: unknown) =>
        typeof v === 'number' ? v : (v as { re: number }).re ?? 0
      );
      eigenvectors.push(vec);
    }

    return { eigenvectors, eigenvalues };
  }

  private computeSignals(returns: Record<string, number>, now: number): AssetSignal[] {
    if (!this.factorModel) return [];

    const signals: AssetSignal[] = [];

    const factorReturns: number[] = [];
    for (let f = 0; f < this.factorModel.eigenvectors.length; f++) {
      let factorReturn = 0;
      for (let i = 0; i < this.config.assets.length; i++) {
        const asset = this.config.assets[i];
        factorReturn += this.factorModel.eigenvectors[f][i] * (returns[asset] ?? 0);
      }
      factorReturns.push(factorReturn);
    }

    for (const asset of this.config.assets) {
      const actualReturn = returns[asset];
      if (actualReturn === undefined) continue;

      const betas = this.factorModel.assetBetas.get(asset);
      if (!betas) continue;

      let expectedReturn = 0;
      const factorContributions: number[] = [];
      for (let f = 0; f < factorReturns.length; f++) {
        const contribution = betas[f] * factorReturns[f];
        factorContributions.push(contribution);
        expectedReturn += contribution;
      }

      const residual = actualReturn - expectedReturn;

      const residHistory = this.residualHistory.get(asset);
      if (residHistory) {
        residHistory.push(residual);
        while (residHistory.length > this.config.residualLookbackPeriods) {
          residHistory.shift();
        }
      }

      const residualZScore = this.computeResidualZScore(asset, residual);

      let signal: 'long' | 'short' | 'neutral' = 'neutral';
      if (residualZScore <= -this.config.entryZScore) {
        signal = 'long';
      } else if (residualZScore >= this.config.entryZScore) {
        signal = 'short';
      }

      signals.push({
        asset,
        timestamp: now,
        actualReturn,
        expectedReturn,
        residual,
        residualZScore,
        signal,
        factorContributions,
        factorReturns,
      });
    }

    return signals;
  }

  private computeResidualZScore(asset: string, currentResidual: number): number {
    const history = this.residualHistory.get(asset);
    if (!history || history.length < 10) {
      return 0;
    }

    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / history.length;
    const std = Math.sqrt(variance);

    if (std < 0.0001) return 0;

    return (currentResidual - mean) / std;
  }

  private processSignals(signals: AssetSignal[], now: number): void {
    for (const signal of signals) {
      const existingPosition = this.activePositions.get(signal.asset);

      if (!existingPosition) {
        let volMult = 0;
        let direction: 'long' | 'short' | null = null;

        const longMult = this.shouldEnterLong(signal.residualZScore, signal.asset);
        if (longMult > 0) {
          volMult = longMult;
          direction = 'long';
        } else {
          const shortMult = this.shouldEnterShort(signal.residualZScore, signal.asset);
          if (shortMult > 0) {
            volMult = shortMult;
            direction = 'short';
          }
        }

        if (volMult > 0 && direction) {
          const currentPrice = this.getCurrentPrice(signal.asset);
          if (currentPrice <= 0) {
            this.logger.warn({ asset: signal.asset }, 'Skipping signal - no valid price');
            continue;
          }

          const baseSize = this.computePositionSize(signal.asset, direction);
          const position: ActivePosition = {
            timestamp: now,
            asset: signal.asset,
            direction,
            zScore: signal.residualZScore,
            residual: signal.residual,
            confidence:
              this.factorModel?.varianceExplained[this.factorModel.varianceExplained.length - 1] ?? 0,
            entryPrice: currentPrice,
            positionSizeUsd: baseSize * volMult,
            factorContext: {
              pc1Return: signal.factorReturns[0] ?? 0,
              pc2Return: signal.factorReturns[1] ?? 0,
            },
            allAssetResiduals: Object.fromEntries(signals.map((s) => [s.asset, s.residual])),
            peakPnlBps: 0,
            troughPnlBps: 0,
            lastPnlBps: 0,
            trailingActivated: false,
            cumulativePC1Return: 0,
            entryPC1Loading: this.getPC1Loading(signal.asset),
          };

          this.activePositions.set(signal.asset, position);
          this.activeSignals.set(signal.asset, position);

          this.logger.info(
            {
              asset: signal.asset,
              direction,
              zScore: signal.residualZScore.toFixed(2),
              residualBps: (signal.residual * 10000).toFixed(1),
              pc1Bps: (signal.factorReturns[0] * 10000).toFixed(1),
              regimeState: this.regimeState,
              pc1Momentum: this.pc1Momentum.toFixed(4),
              positionSizeUsd: position.positionSizeUsd.toFixed(2),
              volMult: volMult.toFixed(2),
              ewmaVolBps: (this.ewmaVol * 10000).toFixed(1),
              pc1DisplacementBps: this.pc1DisplacementBps.toFixed(1),
              pc1Loading: this.getPC1Loading(signal.asset).toFixed(3),
              portfolioPC1Exposure: this.computePortfolioPC1Exposure().toFixed(2),
            },
            'PCA signal detected'
          );

          this.emit('signal', { ...position, pc1Momentum: this.pc1Momentum, regimeState: this.regimeState, ewmaVolBps: this.ewmaVol * 10000, pc1DisplacementBps: this.pc1DisplacementBps });

          if (direction === 'short') {
            this.createBenchmarkEntry(signal.asset, now, signals);
          }
        }
      }

      if (existingPosition) {
        existingPosition.cumulativePC1Return += signal.factorReturns[0] ?? 0;

        const currentPrice = this.getCurrentPrice(signal.asset);
        const { shouldExit, reason } = this.checkExitConditions(
          existingPosition,
          signal.residualZScore,
          currentPrice,
          now
        );

        if (shouldExit) {
          const holdTime = now - existingPosition.timestamp;

          // Calculate P&L from prices directly
          const entryPrice = existingPosition.entryPrice;
          let pnlBps = 0;
          if (entryPrice > 0 && currentPrice > 0) {
            const priceChange = (currentPrice - entryPrice) / entryPrice;
            pnlBps = existingPosition.direction === 'long' ? priceChange * 10000 : -priceChange * 10000;
          }

          const attribution = this.computeAttribution(existingPosition);

          this.logger.info(
            {
              asset: signal.asset,
              direction: existingPosition.direction,
              exitReason: reason,
              entryZScore: existingPosition.zScore.toFixed(2),
              exitZScore: signal.residualZScore.toFixed(2),
              holdTimeMin: (holdTime / 60000).toFixed(1),
              entryPrice,
              exitPrice: currentPrice,
              pnlBps: pnlBps.toFixed(1),
              peakPnlBps: existingPosition.peakPnlBps.toFixed(1),
              troughPnlBps: existingPosition.troughPnlBps.toFixed(1),
              pc1PnlBps: attribution.pc1PnlBps.toFixed(1),
              residualPnlBps: attribution.residualPnlBps.toFixed(1),
              pc1PctOfTotal: (attribution.pc1PctOfTotal * 100).toFixed(0) + '%',
            },
            'PCA signal closed'
          );

          const exitEvent: PCAExitEvent = {
            ...existingPosition,
            exitTimestamp: now,
            exitZScore: signal.residualZScore,
            holdTimeMs: holdTime,
            exitPrice: currentPrice,
            pnlBps,
            exitReason: reason,
            peakPnlBps: existingPosition.peakPnlBps,
            troughPnlBps: existingPosition.troughPnlBps,
            regimeState: this.regimeState,
            attribution,
          };

          this.emit('exit', exitEvent);
          if (this.shouldShadow(reason, holdTime)) {
            this.addShadowPosition(existingPosition, now, reason);
          }
          this.activePositions.delete(signal.asset);
          this.activeSignals.delete(signal.asset);
        }
      }
    }
  }

  private getCurrentPrice(asset: string): number {
    const history = this.priceHistory.get(asset);
    if (!history || history.length === 0) return 0;
    return history[history.length - 1].price;
  }

  private computeRegimeState(pc1Return: number): void {
    this.pc1ReturnHistory.push(pc1Return);
    while (this.pc1ReturnHistory.length > 100) {
      this.pc1ReturnHistory.shift();
    }

    const gating = this.config.regimeGating;
    if (!gating?.enabled) return;

    const alpha = 2 / (gating.ewmaSpan + 1);
    this.ewmaMean = alpha * pc1Return + (1 - alpha) * this.ewmaMean;
    this.ewmaVar = alpha * Math.pow(pc1Return, 2) + (1 - alpha) * this.ewmaVar;

    const ewmaStd = Math.sqrt(Math.max(this.ewmaVar - Math.pow(this.ewmaMean, 2), 0.0000001));
    this.ewmaVol = ewmaStd;
    this.pc1Momentum = this.ewmaMean / ewmaStd;

    const lookback = gating.pc1DisplacementLookback ?? gating.ewmaSpan;
    const recentReturns = this.pc1ReturnHistory.slice(-lookback);
    const displacement = recentReturns.reduce((sum, r) => sum + r, 0);
    this.pc1DisplacementBps = displacement * 10000;

    const threshold = gating.regimeThreshold;
    let candidateRegime: RegimeState;
    if (this.pc1Momentum > threshold) {
      candidateRegime = 'bullish';
    } else if (this.pc1Momentum < -threshold) {
      candidateRegime = 'bearish';
    } else {
      candidateRegime = 'neutral';
    }

    if (candidateRegime === this.pendingRegime) {
      this.regimeTickCount++;
    } else {
      this.pendingRegime = candidateRegime;
      this.regimeTickCount = 1;
    }

    if (this.regimeTickCount >= gating.hysteresisTicks && this.regimeState !== this.pendingRegime) {
      const oldState = this.regimeState;
      this.regimeState = this.pendingRegime;
      this.logger.info(
        { oldState, newState: this.regimeState, pc1Momentum: this.pc1Momentum.toFixed(3), ticksInState: this.regimeTickCount },
        'Regime state changed'
      );
    }
  }

  private countPositionsByDirection(): { long: number; short: number; total: number } {
    let longCount = 0;
    let shortCount = 0;
    for (const pos of this.activePositions.values()) {
      if (pos.direction === 'long') longCount++;
      else shortCount++;
    }
    return { long: longCount, short: shortCount, total: longCount + shortCount };
  }

  private computeAssetVolatility(asset: string): number {
    const history = this.returnHistory.get(asset);
    if (!history || history.length < 10) return 0.01;
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / history.length;
    return Math.sqrt(variance) || 0.01;
  }

  private getPC1Loading(asset: string, useSmoothed: boolean = true): number {
    if (useSmoothed && this.smoothedPC1Loadings.has(asset)) {
      return this.smoothedPC1Loadings.get(asset)!;
    }
    if (!this.factorModel) return 1;
    const betas = this.factorModel.assetBetas.get(asset);
    return betas?.[0] ?? 1;
  }

  private computePositionSize(asset: string, direction: 'long' | 'short'): number {
    const sizing = this.config.sizing;
    if (!sizing) return this.config.positionSizeUsd;

    const { mode, baseNotionalUsd, minPositionUsd, maxPositionUsd, targetVolBps } = sizing;

    let size = baseNotionalUsd;

    if (mode === 'vol_adjusted') {
      const vol = this.computeAssetVolatility(asset);
      const targetVol = (targetVolBps ?? 100) / 10000;
      size = baseNotionalUsd * (targetVol / Math.max(vol, 0.001));
    } else if (mode === 'factor_neutral') {
      const pc1Loading = Math.abs(this.getPC1Loading(asset));
      const vol = this.computeAssetVolatility(asset);
      const avgLoading = this.computeAveragePC1Loading();
      const loadingRatio = avgLoading / Math.max(pc1Loading, 0.01);
      const targetVol = (targetVolBps ?? 100) / 10000;
      const volAdjust = targetVol / Math.max(vol, 0.001);
      size = baseNotionalUsd * loadingRatio * volAdjust;
    }

    size = Math.max(minPositionUsd, Math.min(maxPositionUsd, size));

    this.logger.debug(
      { asset, direction, size: size.toFixed(2), mode },
      'Position size computed'
    );

    return size;
  }

  private computeAveragePC1Loading(): number {
    if (!this.factorModel) return 1;
    let sum = 0;
    let count = 0;
    for (const betas of this.factorModel.assetBetas.values()) {
      if (betas[0] !== undefined) {
        sum += Math.abs(betas[0]);
        count++;
      }
    }
    return count > 0 ? sum / count : 1;
  }

  private computePortfolioPC1Exposure(): number {
    let exposure = 0;
    for (const pos of this.activePositions.values()) {
      const loading = this.getPC1Loading(pos.asset);
      const sign = pos.direction === 'long' ? 1 : -1;
      exposure += sign * loading * pos.positionSizeUsd;
    }
    return exposure;
  }

  private computeAttribution(position: ActivePosition): PnLAttribution {
    const totalPnlBps = position.lastPnlBps;
    const pc1Loading = position.entryPC1Loading;
    const cumulativePC1Return = position.cumulativePC1Return;
    const sign = position.direction === 'long' ? 1 : -1;
    const pc1PnlBps = sign * pc1Loading * cumulativePC1Return * 10000;
    const residualPnlBps = totalPnlBps - pc1PnlBps;
    const pc1PctOfTotal = totalPnlBps !== 0 ? pc1PnlBps / totalPnlBps : 0;

    return {
      totalPnlBps,
      pc1PnlBps,
      residualPnlBps,
      pc1PctOfTotal,
      cumulativePC1Return,
      pc1Loading,
    };
  }

  private wouldBreachPC1Exposure(asset: string, direction: 'long' | 'short'): boolean {
    const maxExposure = this.config.sizing.maxPortfolioPC1ExposureUsd;
    if (!maxExposure) return false;

    const currentExposure = this.computePortfolioPC1Exposure();
    const loading = this.getPC1Loading(asset);
    const positionSize = this.computePositionSize(asset, direction);
    const sign = direction === 'long' ? 1 : -1;
    const additionalExposure = sign * loading * positionSize;
    const projectedExposure = Math.abs(currentExposure + additionalExposure);

    if (projectedExposure > maxExposure) {
      this.logger.debug(
        { asset, direction, currentExposure: currentExposure.toFixed(2), projectedExposure: projectedExposure.toFixed(2), maxExposure },
        'Entry blocked by PC1 exposure cap'
      );
      return true;
    }
    return false;
  }

  private computeVolMultiplier(): number {
    const minVolBps = this.config.regimeGating.minVolatilityBps;
    if (!minVolBps) return 1;
    const minVol = minVolBps / 10000;
    return Math.min(1, this.ewmaVol / minVol);
  }

  private shouldEnterLong(zScore: number, asset: string): number {
    if (this.config.long.enabled === false) return 0;

    const longConfig = this.config.long;
    const threshold = longConfig.entryZScore ?? this.config.entryZScore;
    if (zScore > -threshold) return 0;

    if (this.config.blockedHoursUtc?.length) {
      const hourUtc = new Date().getUTCHours();
      if (this.config.blockedHoursUtc.includes(hourUtc)) return 0;
    }

    if (longConfig.requireRegimeConfirmation && this.config.regimeGating.enabled) {
      if (this.regimeState === 'bearish') {
        return 0;
      }
    }

    const limits = this.config.exposureLimits;
    const counts = this.countPositionsByDirection();
    if (counts.long >= limits.maxPositionsLong) return 0;
    if (counts.total >= limits.maxPositionsTotal) return 0;

    if (this.wouldBreachPC1Exposure(asset, 'long')) return 0;

    const maxDisp = this.config.regimeGating.maxPC1DisplacementBps;
    if (maxDisp && Math.abs(this.pc1DisplacementBps) > maxDisp) return 0;

    const volMult = this.computeVolMultiplier();
    if (volMult < 0.1) return 0;
    return volMult;
  }

  private shouldEnterShort(zScore: number, asset: string): number {
    const shortConfig = this.config.short;
    const threshold = shortConfig.entryZScore ?? this.config.entryZScore;
    if (zScore < threshold) return 0;
    if (shortConfig.maxEntryZScore && zScore > shortConfig.maxEntryZScore) return 0;

    if (this.config.blockedHoursUtc?.length) {
      const hourUtc = new Date().getUTCHours();
      if (this.config.blockedHoursUtc.includes(hourUtc)) return 0;
    }

    const limits = this.config.exposureLimits;
    const counts = this.countPositionsByDirection();
    if (counts.short >= limits.maxPositionsShort) return 0;
    if (counts.total >= limits.maxPositionsTotal) return 0;

    if (this.wouldBreachPC1Exposure(asset, 'short')) return 0;

    const maxDisp = this.config.regimeGating.maxPC1DisplacementBps;
    if (maxDisp && Math.abs(this.pc1DisplacementBps) > maxDisp) return 0;

    const volMult = this.computeVolMultiplier();
    if (volMult < 0.1) return 0;
    return volMult;
  }

  private checkExitConditions(
    position: ActivePosition,
    currentZScore: number,
    currentPrice: number,
    now: number
  ): { shouldExit: boolean; reason: ExitReason } {
    const holdTimeMs = now - position.timestamp;
    const direction = position.direction;
    const dirConfig = direction === 'long' ? this.config.long : this.config.short;
    const maxHoldTimeMs = dirConfig.maxHoldTimeMs ?? Infinity;
    const minHoldTimeMs = dirConfig.minHoldTimeMs ?? 0;

    let currentPnlBps = 0;
    if (position.entryPrice > 0 && currentPrice > 0) {
      const rawReturn = (currentPrice - position.entryPrice) / position.entryPrice;
      currentPnlBps = (direction === 'long' ? rawReturn : -rawReturn) * 10000;
    }
    position.lastPnlBps = currentPnlBps;
    position.peakPnlBps = Math.max(position.peakPnlBps, currentPnlBps);
    position.troughPnlBps = Math.min(position.troughPnlBps, currentPnlBps);

    // 1. Hard stop-loss — fires FIRST, bypasses minHold when stopLossIgnoresMinHold
    const stopLossBps = dirConfig.stopLossBps ?? 100;
    const ignoresMinHold = direction === 'short'
      ? this.config.short.stopLossIgnoresMinHold
      : false;
    if (currentPnlBps <= -stopLossBps && (ignoresMinHold || holdTimeMs >= minHoldTimeMs)) {
      return { shouldExit: true, reason: 'stop_loss' };
    }

    // 2. Stall exit — if position hasn't shown life after stallExitMs, bail early
    if (direction === 'short' && this.config.short.stallExitMs && this.config.short.stallExitMinPeakBps !== undefined) {
      if (holdTimeMs >= this.config.short.stallExitMs && !position.trailingActivated
          && position.peakPnlBps < this.config.short.stallExitMinPeakBps) {
        return { shouldExit: true, reason: 'stall_exit' };
      }
    }

    // 3. Time stop
    if (holdTimeMs >= maxHoldTimeMs) {
      return { shouldExit: true, reason: 'time_stop' };
    }

    // 4. Trailing stop — gated by optional minHoldTimeMs
    if (direction === 'short' && this.config.short.trailingExit.enabled) {
      const { activationPnlBps, trailStopBps, minHoldTimeMs: trailingMinHold } = this.config.short.trailingExit;
      if (currentPnlBps >= activationPnlBps) {
        position.trailingActivated = true;
      }
      if (position.trailingActivated && holdTimeMs >= (trailingMinHold ?? 0)) {
        const drawdownFromPeak = position.peakPnlBps - currentPnlBps;
        if (drawdownFromPeak >= trailStopBps) {
          return { shouldExit: true, reason: 'trailing_stop' };
        }
      }
    }

    // 5. Z-score / zero-cross exits — lowest priority, gated by direction config
    const passedMinHold = holdTimeMs >= minHoldTimeMs;
    const useZeroCrossExit = dirConfig.zeroCrossExit ?? false;
    const useZscoreExit = direction === 'short'
      ? this.config.short.zscoreExit
      : true;

    if (useZeroCrossExit && passedMinHold) {
      const entrySign = position.zScore > 0 ? 1 : -1;
      const currentSign = currentZScore > 0 ? 1 : -1;
      if (entrySign !== currentSign) {
        return { shouldExit: true, reason: 'zero_cross' };
      }
    }

    if (useZscoreExit && passedMinHold) {
      const exitZScore = dirConfig.exitZScore ?? this.config.exitZScore;
      if (Math.abs(currentZScore) < exitZScore) {
        return { shouldExit: true, reason: 'zscore' };
      }
    }

    return { shouldExit: false, reason: 'zscore' };
  }

  private shouldShadow(reason: ExitReason, holdTimeMs: number): boolean {
    if (reason === 'zero_cross') return false;
    if (reason === 'time_stop' && holdTimeMs >= PCAStatArbMonitor.SHADOW_MAX_HOLD_MS) return false;
    return true;
  }

  private addShadowPosition(position: ActivePosition, exitTimestamp: number, exitReason: ExitReason): void {
    const shadow: ShadowPosition = {
      signalTimestamp: position.timestamp,
      asset: position.asset,
      direction: position.direction,
      entryPrice: position.entryPrice,
      entryZScoreSign: position.zScore > 0 ? 1 : -1,
      shadowStartTimestamp: exitTimestamp,
      peakPnlBps: position.peakPnlBps,
      troughPnlBps: position.troughPnlBps,
      lastPnlBps: position.lastPnlBps,
      cumulativePC1Return: position.cumulativePC1Return,
      entryPC1Loading: position.entryPC1Loading,
      realExitReason: exitReason,
    };
    const existing = this.shadowPositions.get(position.asset) ?? [];
    existing.push(shadow);
    this.shadowPositions.set(position.asset, existing);
    this.logger.info({ asset: position.asset, realExitReason: exitReason }, 'Position moved to shadow tracking');
  }

  private updateShadowPositions(signals: AssetSignal[], now: number): void {
    const signalMap = new Map(signals.map(s => [s.asset, s]));

    for (const [asset, shadows] of this.shadowPositions) {
      const signal = signalMap.get(asset);
      const currentPrice = this.getCurrentPrice(asset);
      if (currentPrice <= 0) continue;

      const toRemove: number[] = [];

      for (let i = 0; i < shadows.length; i++) {
        const shadow = shadows[i];
        const priceChange = (currentPrice - shadow.entryPrice) / shadow.entryPrice;
        const pnlBps = shadow.direction === 'long' ? priceChange * 10000 : -priceChange * 10000;
        shadow.lastPnlBps = pnlBps;
        shadow.peakPnlBps = Math.max(shadow.peakPnlBps, pnlBps);
        shadow.troughPnlBps = Math.min(shadow.troughPnlBps, pnlBps);

        if (signal) {
          shadow.cumulativePC1Return += signal.factorReturns[0] ?? 0;
        }

        const totalHoldMs = now - shadow.signalTimestamp;
        let shouldExit = false;
        let shadowExitReason: ShadowExitReason = 'shadow_time_stop';

        if (totalHoldMs >= PCAStatArbMonitor.SHADOW_MAX_HOLD_MS) {
          shouldExit = true;
          shadowExitReason = 'shadow_time_stop';
        } else if (signal) {
          const currentSign = signal.residualZScore > 0 ? 1 : -1;
          if (currentSign !== shadow.entryZScoreSign) {
            shouldExit = true;
            shadowExitReason = 'zero_cross';
          }
        }

        if (shouldExit) {
          const attr = this.computeShadowAttribution(shadow);
          const exitEvent: PCAShadowExitEvent = {
            signalTimestamp: shadow.signalTimestamp,
            asset: shadow.asset,
            direction: shadow.direction,
            entryPrice: shadow.entryPrice,
            shadowExitTimestamp: now,
            shadowExitPrice: currentPrice,
            shadowPnlBps: pnlBps,
            shadowPeakPnlBps: shadow.peakPnlBps,
            shadowTroughPnlBps: shadow.troughPnlBps,
            shadowHoldTimeMs: totalHoldMs,
            shadowExitReason,
            shadowPC1PnlBps: attr.pc1PnlBps,
            shadowResidualPnlBps: attr.residualPnlBps,
            realExitReason: shadow.realExitReason,
          };
          this.emit('shadow_exit', exitEvent);
          toRemove.push(i);
        }
      }

      for (let j = toRemove.length - 1; j >= 0; j--) {
        shadows.splice(toRemove[j], 1);
      }
      if (shadows.length === 0) {
        this.shadowPositions.delete(asset);
      }
    }
  }

  private computeShadowAttribution(shadow: ShadowPosition): { pc1PnlBps: number; residualPnlBps: number } {
    const sign = shadow.direction === 'long' ? 1 : -1;
    const pc1PnlBps = sign * shadow.entryPC1Loading * shadow.cumulativePC1Return * 10000;
    const residualPnlBps = shadow.lastPnlBps - pc1PnlBps;
    return { pc1PnlBps, residualPnlBps };
  }

  getShadowPositionCount(): number {
    let count = 0;
    for (const shadows of this.shadowPositions.values()) {
      count += shadows.length;
    }
    return count;
  }

  private logSummary(_returns: Record<string, number>, signals: AssetSignal[]): void {
    if (this.tickCount % 5 !== 0) return;

    const residualSummary = Object.fromEntries(
      signals.map((s) => [s.asset, `${s.residualZScore.toFixed(2)}σ`])
    );

    this.logger.info(
      {
        tick: this.tickCount,
        activeSignals: this.activePositions.size,
        shadowPositions: this.getShadowPositionCount(),
        residuals: residualSummary,
        pc1Bps: signals[0] ? (signals[0].factorReturns[0] * 10000).toFixed(1) : 'N/A',
        regimeState: this.regimeState,
        pc1Momentum: this.pc1Momentum.toFixed(4),
        ewmaVolBps: (this.ewmaVol * 10000).toFixed(1),
        pc1DisplacementBps: this.pc1DisplacementBps.toFixed(1),
      },
      'PCA summary'
    );
  }

  getFactorModel(): FactorModel | null {
    return this.factorModel;
  }

  getCurrentSignals(): AssetSignal[] {
    const returns = this.computeReturns(Date.now());
    return this.computeSignals(returns, Date.now());
  }

  getActiveSignals(): Map<string, PCASignalEvent> {
    return new Map(this.activeSignals);
  }

  getConfig(): PCAConfig {
    return { ...this.config };
  }

  getCurrentPrices(): Record<string, number> {
    const prices: Record<string, number> = {};
    for (const asset of this.config.assets) {
      const price = this.getCurrentPrice(asset);
      if (price > 0) prices[asset] = price;
    }
    return prices;
  }

  getRegimeState(): { state: RegimeState; pc1Momentum: number } {
    return { state: this.regimeState, pc1Momentum: this.pc1Momentum };
  }

  getActivePositions(): Map<string, ActivePosition> {
    return new Map(this.activePositions);
  }
}
