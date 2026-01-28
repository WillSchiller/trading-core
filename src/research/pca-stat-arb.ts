import { EventEmitter } from 'events';
import * as math from 'mathjs';
import { createChildLogger, type Logger } from '../utils/logger.js';

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
}

export class PCAStatArbMonitor extends EventEmitter {
  private config: PCAConfig;
  private logger: Logger;
  private priceHistory: Map<string, { price: number; ts: number }[]> = new Map();
  private returnHistory: Map<string, number[]> = new Map();
  private factorModel: FactorModel | null = null;
  private residualHistory: Map<string, number[]> = new Map();
  private activeSignals: Map<string, PCASignalEvent> = new Map();
  private tickCount: number = 0;
  private tickInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

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
    this.processSignals(signals, now);
    this.logSummary(returns, signals);
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
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, 'Failed to compute factor model');
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
      const existingSignal = this.activeSignals.get(signal.asset);

      if (signal.signal !== 'neutral' && !existingSignal) {
        const event: PCASignalEvent = {
          timestamp: now,
          asset: signal.asset,
          direction: signal.signal,
          zScore: signal.residualZScore,
          residual: signal.residual,
          confidence:
            this.factorModel?.varianceExplained[this.factorModel.varianceExplained.length - 1] ?? 0,
          factorContext: {
            pc1Return: signal.factorReturns[0] ?? 0,
            pc2Return: signal.factorReturns[1] ?? 0,
          },
          allAssetResiduals: Object.fromEntries(signals.map((s) => [s.asset, s.residual])),
        };

        this.activeSignals.set(signal.asset, event);

        this.logger.info(
          {
            asset: signal.asset,
            direction: signal.signal,
            zScore: signal.residualZScore.toFixed(2),
            residualBps: (signal.residual * 10000).toFixed(1),
            pc1Bps: (signal.factorReturns[0] * 10000).toFixed(1),
          },
          'PCA signal detected'
        );

        this.emit('signal', event);
      }

      if (existingSignal && Math.abs(signal.residualZScore) < this.config.exitZScore) {
        const holdTime = now - existingSignal.timestamp;

        this.logger.info(
          {
            asset: signal.asset,
            direction: existingSignal.direction,
            entryZScore: existingSignal.zScore.toFixed(2),
            exitZScore: signal.residualZScore.toFixed(2),
            holdTimeMin: (holdTime / 60000).toFixed(1),
          },
          'PCA signal closed'
        );

        const exitEvent: PCAExitEvent = {
          ...existingSignal,
          exitTimestamp: now,
          exitZScore: signal.residualZScore,
          holdTimeMs: holdTime,
        };

        this.emit('exit', exitEvent);
        this.activeSignals.delete(signal.asset);
      }
    }
  }

  private logSummary(_returns: Record<string, number>, signals: AssetSignal[]): void {
    if (this.tickCount % 5 !== 0) return;

    const residualSummary = Object.fromEntries(
      signals.map((s) => [s.asset, `${s.residualZScore.toFixed(2)}σ`])
    );

    this.logger.info(
      {
        tick: this.tickCount,
        activeSignals: this.activeSignals.size,
        residuals: residualSummary,
        pc1Bps: signals[0] ? (signals[0].factorReturns[0] * 10000).toFixed(1) : 'N/A',
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
}
