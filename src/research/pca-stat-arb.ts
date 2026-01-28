import { EventEmitter } from 'events';
import * as math from 'mathjs';
import { createChildLogger, type Logger } from '../utils/logger.js';

export type RegimeState = 'bullish' | 'bearish' | 'neutral';
export type ExitReason = 'zscore' | 'time_stop' | 'trailing_stop';

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
  entryZScore: number;
  exitZScore: number;
  maxHoldTimeMs: number;
  requireRegimeConfirmation: boolean;
}

export interface TrailingExitConfig {
  enabled: boolean;
  activationPnlBps: number;
  trailStopBps: number;
}

export interface ShortConfig {
  entryZScore: number;
  exitZScore: number;
  maxHoldTimeMs: number;
  trailingExit: TrailingExitConfig;
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
  regimeGating?: RegimeGatingConfig;
  exposureLimits?: ExposureLimitsConfig;
  sizing?: SizingConfig;
  long?: LongConfig;
  short?: ShortConfig;
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
    entryZScore: 2.5,
    exitZScore: 0.3,
    maxHoldTimeMs: 1800000,
    requireRegimeConfirmation: true,
  },
  short: {
    entryZScore: 2.0,
    exitZScore: 0.5,
    maxHoldTimeMs: 7200000,
    trailingExit: {
      enabled: true,
      activationPnlBps: 20,
      trailStopBps: 15,
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
  private tickCount: number = 0;
  private tickInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private pc1ReturnHistory: number[] = [];
  private regimeState: RegimeState = 'neutral';
  private pc1Momentum: number = 0;
  private ewmaMean: number = 0;
  private ewmaVar: number = 0;
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

    // CRITICAL: Check time-stops for ALL active positions FIRST
    // This must run even when signal data is incomplete
    this.checkAllPositionExits(now);

    const returns = this.computeReturns(now);
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
    this.logSummary(returns, signals);

    if (signals.length > 0) {
      this.emit('residuals', signals);
    }
  }

  private checkAllPositionExits(now: number): void {
    for (const [asset, position] of this.activePositions) {
      const currentPrice = this.getCurrentPrice(asset);
      if (currentPrice <= 0) continue;

      const holdTimeMs = now - position.timestamp;
      const dirConfig = position.direction === 'long' ? this.config.long : this.config.short;
      const maxHoldTimeMs = dirConfig?.maxHoldTimeMs ?? Infinity;

      if (holdTimeMs >= maxHoldTimeMs) {
        this.logger.info(
          {
            asset,
            direction: position.direction,
            holdTimeMin: (holdTimeMs / 60000).toFixed(1),
            maxHoldTimeMin: (maxHoldTimeMs / 60000).toFixed(1),
            entryTs: position.timestamp,
            nowMs: now,
          },
          'Time-stop triggered'
        );

        const attribution = this.computeAttribution(position);
        const exitEvent: PCAExitEvent = {
          ...position,
          exitTimestamp: now,
          exitZScore: 0,
          holdTimeMs,
          exitPrice: currentPrice,
          pnlBps: position.lastPnlBps,
          exitReason: 'time_stop',
          peakPnlBps: position.peakPnlBps,
          troughPnlBps: position.troughPnlBps,
          regimeState: this.regimeState,
          attribution,
        };

        this.emit('exit', exitEvent);
        this.activePositions.delete(asset);
        this.activeSignals.delete(asset);
      }
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
    const span = this.config.sizing?.loadingSmoothingSpan ?? 20;
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
        let shouldEnter = false;
        let direction: 'long' | 'short' | null = null;

        if (this.shouldEnterLong(signal.residualZScore, signal.asset)) {
          shouldEnter = true;
          direction = 'long';
        } else if (this.shouldEnterShort(signal.residualZScore, signal.asset)) {
          shouldEnter = true;
          direction = 'short';
        }

        if (shouldEnter && direction) {
          const currentPrice = this.getCurrentPrice(signal.asset);
          if (currentPrice <= 0) {
            this.logger.warn({ asset: signal.asset }, 'Skipping signal - no valid price');
            continue;
          }

          const position: ActivePosition = {
            timestamp: now,
            asset: signal.asset,
            direction,
            zScore: signal.residualZScore,
            residual: signal.residual,
            confidence:
              this.factorModel?.varianceExplained[this.factorModel.varianceExplained.length - 1] ?? 0,
            entryPrice: currentPrice,
            positionSizeUsd: this.computePositionSize(signal.asset, direction),
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
              pc1Loading: this.getPC1Loading(signal.asset).toFixed(3),
              portfolioPC1Exposure: this.computePortfolioPC1Exposure().toFixed(2),
            },
            'PCA signal detected'
          );

          this.emit('signal', { ...position, pc1Momentum: this.pc1Momentum, regimeState: this.regimeState });
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
          const attribution = this.computeAttribution(existingPosition);

          this.logger.info(
            {
              asset: signal.asset,
              direction: existingPosition.direction,
              exitReason: reason,
              entryZScore: existingPosition.zScore.toFixed(2),
              exitZScore: signal.residualZScore.toFixed(2),
              holdTimeMin: (holdTime / 60000).toFixed(1),
              pnlBps: existingPosition.lastPnlBps.toFixed(1),
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
            pnlBps: existingPosition.lastPnlBps,
            exitReason: reason,
            peakPnlBps: existingPosition.peakPnlBps,
            troughPnlBps: existingPosition.troughPnlBps,
            regimeState: this.regimeState,
            attribution,
          };

          this.emit('exit', exitEvent);
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
    this.pc1Momentum = this.ewmaMean / ewmaStd;

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
    const maxExposure = this.config.sizing?.maxPortfolioPC1ExposureUsd;
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

  private shouldEnterLong(zScore: number, asset: string): boolean {
    const longConfig = this.config.long;
    const threshold = longConfig?.entryZScore ?? this.config.entryZScore;
    if (zScore > -threshold) return false;

    if (longConfig?.requireRegimeConfirmation && this.config.regimeGating?.enabled) {
      if (this.regimeState === 'bearish') {
        return false;
      }
    }

    const limits = this.config.exposureLimits;
    if (limits) {
      const counts = this.countPositionsByDirection();
      if (counts.long >= limits.maxPositionsLong) return false;
      if (counts.total >= limits.maxPositionsTotal) return false;
    }

    if (this.wouldBreachPC1Exposure(asset, 'long')) return false;

    return true;
  }

  private shouldEnterShort(zScore: number, asset: string): boolean {
    const shortConfig = this.config.short;
    const threshold = shortConfig?.entryZScore ?? this.config.entryZScore;
    if (zScore < threshold) return false;

    const limits = this.config.exposureLimits;
    if (limits) {
      const counts = this.countPositionsByDirection();
      if (counts.short >= limits.maxPositionsShort) return false;
      if (counts.total >= limits.maxPositionsTotal) return false;
    }

    if (this.wouldBreachPC1Exposure(asset, 'short')) return false;

    return true;
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
    const maxHoldTimeMs = dirConfig?.maxHoldTimeMs ?? Infinity;

    let currentPnlBps = 0;
    if (position.entryPrice > 0 && currentPrice > 0) {
      const rawReturn = (currentPrice - position.entryPrice) / position.entryPrice;
      currentPnlBps = (direction === 'long' ? rawReturn : -rawReturn) * 10000;
    }
    position.lastPnlBps = currentPnlBps;
    position.peakPnlBps = Math.max(position.peakPnlBps, currentPnlBps);
    position.troughPnlBps = Math.min(position.troughPnlBps, currentPnlBps);

    if (holdTimeMs >= maxHoldTimeMs) {
      return { shouldExit: true, reason: 'time_stop' };
    }

    if (direction === 'long') {
      const exitZScore = this.config.long?.exitZScore ?? this.config.exitZScore;
      if (Math.abs(currentZScore) < exitZScore) {
        return { shouldExit: true, reason: 'zscore' };
      }
    }

    if (direction === 'short' && this.config.short?.trailingExit?.enabled) {
      const { activationPnlBps, trailStopBps } = this.config.short.trailingExit;
      if (currentPnlBps >= activationPnlBps) {
        position.trailingActivated = true;
      }
      if (position.trailingActivated) {
        const drawdownFromPeak = position.peakPnlBps - currentPnlBps;
        if (drawdownFromPeak >= trailStopBps) {
          return { shouldExit: true, reason: 'trailing_stop' };
        }
      }
    }

    return { shouldExit: false, reason: 'zscore' };
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
        residuals: residualSummary,
        pc1Bps: signals[0] ? (signals[0].factorReturns[0] * 10000).toFixed(1) : 'N/A',
        regimeState: this.regimeState,
        pc1Momentum: this.pc1Momentum.toFixed(4),
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
