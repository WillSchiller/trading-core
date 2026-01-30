import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PCAStatArbMonitor, type PCAConfig, type RegimeState } from '../../src/research/pca-stat-arb.js';

const createTestConfig = (overrides: Partial<PCAConfig> = {}): Partial<PCAConfig> => ({
  assets: ['ETH', 'BTC', 'SOL'],
  returnWindowMs: 1000,
  pcaLookbackPeriods: 10,
  numFactors: 2,
  minVarianceExplained: 0.5,
  residualLookbackPeriods: 5,
  entryZScore: 2.0,
  exitZScore: 0.5,
  tickIntervalMs: 100,
  pcaRefreshPeriods: 5,
  positionSizeUsd: 100,
  regimeGating: {
    enabled: true,
    ewmaSpan: 3,
    regimeThreshold: 0.5,
    hysteresisTicks: 2,
  },
  exposureLimits: {
    maxPositionsLong: 2,
    maxPositionsShort: 3,
    maxPositionsTotal: 4,
  },
  sizing: {
    mode: 'factor_neutral',
    baseNotionalUsd: 100,
    minPositionUsd: 25,
    maxPositionUsd: 200,
    targetVolBps: 100,
    loadingSmoothingSpan: 5,
    maxPortfolioPC1ExposureUsd: 150,
  },
  long: {
    enabled: true,
    entryZScore: 2.5,
    exitZScore: 0.3,
    maxHoldTimeMs: 30000,
    minHoldTimeMs: 0,
    zeroCrossExit: true,
    stopLossBps: 150,
    requireRegimeConfirmation: true,
  },
  short: {
    entryZScore: 2.0,
    exitZScore: 0.5,
    maxHoldTimeMs: 60000,
    minHoldTimeMs: 0,
    zeroCrossExit: false,
    zscoreExit: true,
    stopLossBps: 150,
    stopLossIgnoresMinHold: false,
    trailingExit: {
      enabled: true,
      activationPnlBps: 20,
      trailStopBps: 15,
    },
  },
  ...overrides,
});

const feedPrices = (monitor: PCAStatArbMonitor, prices: Record<string, number[]>) => {
  const assets = Object.keys(prices);
  const length = prices[assets[0]].length;
  for (let i = 0; i < length; i++) {
    for (const asset of assets) {
      monitor.updatePrice(asset, prices[asset][i]);
    }
  }
};

const generateDowntrend = (start: number, periods: number, volatility: number = 0.02): number[] => {
  const prices: number[] = [];
  let price = start;
  for (let i = 0; i < periods; i++) {
    price *= 1 - 0.01 + (Math.random() - 0.7) * volatility;
    prices.push(price);
  }
  return prices;
};

const generateUptrend = (start: number, periods: number, volatility: number = 0.02): number[] => {
  const prices: number[] = [];
  let price = start;
  for (let i = 0; i < periods; i++) {
    price *= 1 + 0.01 + (Math.random() - 0.3) * volatility;
    prices.push(price);
  }
  return prices;
};

const generateFlat = (start: number, periods: number, volatility: number = 0.01): number[] => {
  const prices: number[] = [];
  let price = start;
  for (let i = 0; i < periods; i++) {
    price *= 1 + (Math.random() - 0.5) * volatility;
    prices.push(price);
  }
  return prices;
};

describe('PCAStatArbMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe('Regime Detection', () => {
    it('detects bearish regime during sustained downtrend', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());
      let regimeState: RegimeState = 'neutral';

      monitor.on('factorModel', () => {
        regimeState = (monitor as unknown as { regimeState: RegimeState }).regimeState;
      });

      monitor.start();

      feedPrices(monitor, {
        ETH: generateDowntrend(2000, 30),
        BTC: generateDowntrend(40000, 30),
        SOL: generateDowntrend(100, 30),
      });

      for (let i = 0; i < 30; i++) {
        vi.advanceTimersByTime(100);
      }

      monitor.stop();

      const internalState = monitor as unknown as { regimeState: RegimeState };
      expect(['bearish', 'neutral']).toContain(internalState.regimeState);
    });

    it('detects bullish regime during sustained uptrend', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      monitor.start();

      feedPrices(monitor, {
        ETH: generateUptrend(2000, 30),
        BTC: generateUptrend(40000, 30),
        SOL: generateUptrend(100, 30),
      });

      for (let i = 0; i < 30; i++) {
        vi.advanceTimersByTime(100);
      }

      monitor.stop();

      const internalState = monitor as unknown as { regimeState: RegimeState };
      expect(['bullish', 'neutral']).toContain(internalState.regimeState);
    });

    it('requires hysteresis ticks before regime transition', () => {
      const config = createTestConfig({
        regimeGating: {
          enabled: true,
          ewmaSpan: 3,
          regimeThreshold: 0.5,
          hysteresisTicks: 3,
        },
      });
      const monitor = new PCAStatArbMonitor(config);
      const regimeChanges: RegimeState[] = [];

      monitor.on('factorModel', () => {
        const state = (monitor as unknown as { regimeState: RegimeState }).regimeState;
        if (regimeChanges.length === 0 || regimeChanges[regimeChanges.length - 1] !== state) {
          regimeChanges.push(state);
        }
      });

      monitor.start();

      const downtrend = generateDowntrend(2000, 10);
      const uptrend = generateUptrend(downtrend[downtrend.length - 1], 10);
      const combined = [...downtrend, ...uptrend];

      feedPrices(monitor, {
        ETH: combined,
        BTC: combined.map(p => p * 20),
        SOL: combined.map(p => p * 0.05),
      });

      for (let i = 0; i < combined.length; i++) {
        vi.advanceTimersByTime(100);
      }

      monitor.stop();

      expect(regimeChanges.length).toBeLessThanOrEqual(3);
    });

    it('stays neutral during sideways market', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      monitor.start();

      feedPrices(monitor, {
        ETH: generateFlat(2000, 30, 0.005),
        BTC: generateFlat(40000, 30, 0.005),
        SOL: generateFlat(100, 30, 0.005),
      });

      for (let i = 0; i < 30; i++) {
        vi.advanceTimersByTime(100);
      }

      monitor.stop();

      const internalState = monitor as unknown as { regimeState: RegimeState };
      expect(internalState.regimeState).toBe('neutral');
    });
  });

  describe('Long Entry Gating', () => {
    it('blocks long entries in bearish regime', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());
      const signals: Array<{ direction: string; blocked?: boolean }> = [];

      monitor.on('signal', (signal) => {
        signals.push({ direction: signal.direction });
      });

      Object.assign(monitor, { regimeState: 'bearish' as RegimeState });

      const shouldEnterLong = (monitor as unknown as {
        shouldEnterLong: (zScore: number, asset: string) => boolean
      }).shouldEnterLong.bind(monitor);

      expect(shouldEnterLong(-3.0, 'ETH')).toBe(false);
    });

    it('allows long entries in bullish regime', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      Object.assign(monitor, {
        regimeState: 'bullish' as RegimeState,
        activePositions: new Map(),
        factorModel: {
          assetBetas: new Map([['ETH', [0.5, 0.2]]]),
        },
        returnHistory: new Map([['ETH', [0.01, -0.01, 0.02, -0.02, 0.01, -0.01, 0.02, -0.02, 0.01, -0.01]]]),
        smoothedPC1Loadings: new Map([['ETH', 0.5]]),
      });

      const shouldEnterLong = (monitor as unknown as {
        shouldEnterLong: (zScore: number, asset: string) => boolean
      }).shouldEnterLong.bind(monitor);

      expect(shouldEnterLong(-3.0, 'ETH')).toBe(true);
    });

    it('allows long entries in neutral regime', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      Object.assign(monitor, {
        regimeState: 'neutral' as RegimeState,
        activePositions: new Map(),
        factorModel: {
          assetBetas: new Map([['ETH', [0.5, 0.2]]]),
        },
        returnHistory: new Map([['ETH', [0.01, -0.01, 0.02, -0.02, 0.01, -0.01, 0.02, -0.02, 0.01, -0.01]]]),
        smoothedPC1Loadings: new Map([['ETH', 0.5]]),
      });

      const shouldEnterLong = (monitor as unknown as {
        shouldEnterLong: (zScore: number, asset: string) => boolean
      }).shouldEnterLong.bind(monitor);

      expect(shouldEnterLong(-3.0, 'ETH')).toBe(true);
    });

    it('respects long exposure limits', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig({
        exposureLimits: { maxPositionsLong: 1, maxPositionsShort: 3, maxPositionsTotal: 4 },
      }));

      Object.assign(monitor, {
        regimeState: 'bullish' as RegimeState,
        activePositions: new Map([
          ['existing-long', { direction: 'long', asset: 'BTC', positionSizeUsd: 100 }],
        ]),
        factorModel: { assetBetas: new Map([['ETH', [0.5, 0.2]]]) },
        returnHistory: new Map([['ETH', Array(10).fill(0.01)]]),
        smoothedPC1Loadings: new Map([['ETH', 0.5]]),
      });

      const shouldEnterLong = (monitor as unknown as {
        shouldEnterLong: (zScore: number, asset: string) => boolean
      }).shouldEnterLong.bind(monitor);

      expect(shouldEnterLong(-3.0, 'ETH')).toBe(false);
    });
  });

  describe('Short Entry Logic', () => {
    it('allows shorts regardless of bearish regime', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      Object.assign(monitor, {
        regimeState: 'bearish' as RegimeState,
        activePositions: new Map(),
        factorModel: { assetBetas: new Map([['ETH', [0.5, 0.2]]]) },
        returnHistory: new Map([['ETH', Array(10).fill(0.01)]]),
        smoothedPC1Loadings: new Map([['ETH', 0.5]]),
      });

      const shouldEnterShort = (monitor as unknown as {
        shouldEnterShort: (zScore: number, asset: string) => boolean
      }).shouldEnterShort.bind(monitor);

      expect(shouldEnterShort(3.0, 'ETH')).toBe(true);
    });

    it('allows shorts in bullish regime', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      Object.assign(monitor, {
        regimeState: 'bullish' as RegimeState,
        activePositions: new Map(),
        factorModel: { assetBetas: new Map([['ETH', [0.5, 0.2]]]) },
        returnHistory: new Map([['ETH', Array(10).fill(0.01)]]),
        smoothedPC1Loadings: new Map([['ETH', 0.5]]),
      });

      const shouldEnterShort = (monitor as unknown as {
        shouldEnterShort: (zScore: number, asset: string) => boolean
      }).shouldEnterShort.bind(monitor);

      expect(shouldEnterShort(3.0, 'ETH')).toBe(true);
    });

    it('respects short exposure limits', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig({
        exposureLimits: { maxPositionsLong: 2, maxPositionsShort: 1, maxPositionsTotal: 4 },
      }));

      Object.assign(monitor, {
        regimeState: 'neutral' as RegimeState,
        activePositions: new Map([
          ['existing-short', { direction: 'short', asset: 'BTC', positionSizeUsd: 100 }],
        ]),
        factorModel: { assetBetas: new Map([['ETH', [0.5, 0.2]]]) },
        returnHistory: new Map([['ETH', Array(10).fill(0.01)]]),
        smoothedPC1Loadings: new Map([['ETH', 0.5]]),
      });

      const shouldEnterShort = (monitor as unknown as {
        shouldEnterShort: (zScore: number, asset: string) => boolean
      }).shouldEnterShort.bind(monitor);

      expect(shouldEnterShort(3.0, 'ETH')).toBe(false);
    });

    it('rejects short when z-score below threshold', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      Object.assign(monitor, {
        regimeState: 'neutral' as RegimeState,
        activePositions: new Map(),
        factorModel: { assetBetas: new Map([['ETH', [0.5, 0.2]]]) },
        returnHistory: new Map([['ETH', Array(10).fill(0.01)]]),
        smoothedPC1Loadings: new Map([['ETH', 0.5]]),
      });

      const shouldEnterShort = (monitor as unknown as {
        shouldEnterShort: (zScore: number, asset: string) => boolean
      }).shouldEnterShort.bind(monitor);

      expect(shouldEnterShort(1.5, 'ETH')).toBe(false);
    });
  });

  describe('Exit Conditions', () => {
    const createPosition = (overrides: Partial<{
      direction: 'long' | 'short';
      timestamp: number;
      entryPrice: number;
      peakPnlBps: number;
      troughPnlBps: number;
      lastPnlBps: number;
      trailingActivated: boolean;
      asset: string;
      positionSizeUsd: number;
    }> = {}) => ({
      direction: 'long' as const,
      timestamp: Date.now() - 10000,
      entryPrice: 2000,
      peakPnlBps: 0,
      troughPnlBps: 0,
      lastPnlBps: 0,
      trailingActivated: false,
      asset: 'ETH',
      positionSizeUsd: 100,
      zScore: -2.5,
      residual: -0.02,
      confidence: 0.8,
      factorContext: { pc1Return: 0.01, pc2Return: 0.005 },
      allAssetResiduals: { ETH: -0.02 },
      ...overrides,
    });

    it('triggers time stop for long after max hold time', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig({
        long: {
          enabled: true,
          entryZScore: 2.5,
          exitZScore: 0.3,
          maxHoldTimeMs: 10000,
          minHoldTimeMs: 0,
          zeroCrossExit: true,
          stopLossBps: 150,
          requireRegimeConfirmation: true,
        },
      }));

      const position = createPosition({
        direction: 'long',
        timestamp: Date.now() - 15000,
      });

      const checkExitConditions = (monitor as unknown as {
        checkExitConditions: (pos: typeof position, zScore: number, price: number, now: number) => { shouldExit: boolean; reason: string }
      }).checkExitConditions.bind(monitor);

      const result = checkExitConditions(position, -1.0, 2050, Date.now());

      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('time_stop');
    });

    it('triggers time stop for short after max hold time', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig({
        short: {
          entryZScore: 2.0,
          exitZScore: 0.5,
          maxHoldTimeMs: 20000,
          minHoldTimeMs: 0,
          zeroCrossExit: false,
          zscoreExit: true,
          stopLossBps: 150,
          stopLossIgnoresMinHold: false,
          trailingExit: { enabled: true, activationPnlBps: 20, trailStopBps: 15 },
        },
      }));

      const position = createPosition({
        direction: 'short',
        timestamp: Date.now() - 25000,
      });

      const checkExitConditions = (monitor as unknown as {
        checkExitConditions: (pos: typeof position, zScore: number, price: number, now: number) => { shouldExit: boolean; reason: string }
      }).checkExitConditions.bind(monitor);

      const result = checkExitConditions(position, 1.0, 1950, Date.now());

      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('time_stop');
    });

    it('triggers z-score exit for long when residual normalizes', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      const position = createPosition({
        direction: 'long',
        timestamp: Date.now() - 5000,
      });

      const checkExitConditions = (monitor as unknown as {
        checkExitConditions: (pos: typeof position, zScore: number, price: number, now: number) => { shouldExit: boolean; reason: string }
      }).checkExitConditions.bind(monitor);

      const result = checkExitConditions(position, -0.2, 2050, Date.now());

      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('zscore');
    });

    it('triggers z-score exit for short in strict mode', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      const position = createPosition({
        direction: 'short',
        timestamp: Date.now() - 5000,
        entryPrice: 2000,
      });

      const checkExitConditions = (monitor as unknown as {
        checkExitConditions: (pos: typeof position, zScore: number, price: number, now: number) => { shouldExit: boolean; reason: string }
      }).checkExitConditions.bind(monitor);

      const result = checkExitConditions(position, 0.2, 1950, Date.now());

      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('zscore');
    });

    it('activates trailing stop after profit threshold', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      const position = createPosition({
        direction: 'short',
        timestamp: Date.now() - 5000,
        entryPrice: 2000,
        peakPnlBps: 0,
        trailingActivated: false,
      });

      const checkExitConditions = (monitor as unknown as {
        checkExitConditions: (pos: typeof position, zScore: number, price: number, now: number) => { shouldExit: boolean; reason: string }
      }).checkExitConditions.bind(monitor);

      checkExitConditions(position, 1.5, 1950, Date.now());

      expect(position.trailingActivated).toBe(true);
    });

    it('triggers trailing stop exit when drawdown from peak exceeds threshold', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      const position = createPosition({
        direction: 'short',
        timestamp: Date.now() - 5000,
        entryPrice: 2000,
        peakPnlBps: 30,
        trailingActivated: true,
      });

      const checkExitConditions = (monitor as unknown as {
        checkExitConditions: (pos: typeof position, zScore: number, price: number, now: number) => { shouldExit: boolean; reason: string }
      }).checkExitConditions.bind(monitor);

      const result = checkExitConditions(position, 1.5, 1998, Date.now());

      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('trailing_stop');
    });

    it('does not exit trailing stop before drawdown threshold', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      const position = createPosition({
        direction: 'short',
        timestamp: Date.now() - 5000,
        entryPrice: 2000,
        peakPnlBps: 30,
        trailingActivated: true,
      });

      const checkExitConditions = (monitor as unknown as {
        checkExitConditions: (pos: typeof position, zScore: number, price: number, now: number) => { shouldExit: boolean; reason: string }
      }).checkExitConditions.bind(monitor);

      const result = checkExitConditions(position, 1.5, 1960, Date.now());

      expect(result.shouldExit).toBe(false);
    });
  });

  describe('PC1 Exposure Cap', () => {
    it('blocks entry when would breach portfolio PC1 exposure', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig({
        sizing: {
          mode: 'flat',
          baseNotionalUsd: 100,
          minPositionUsd: 25,
          maxPositionUsd: 200,
          maxPortfolioPC1ExposureUsd: 50,
        },
      }));

      Object.assign(monitor, {
        regimeState: 'neutral' as RegimeState,
        activePositions: new Map([
          ['existing-long', { direction: 'long', asset: 'BTC', positionSizeUsd: 100 }],
        ]),
        factorModel: {
          assetBetas: new Map([
            ['ETH', [0.8, 0.2]],
            ['BTC', [0.7, 0.3]],
          ]),
        },
        returnHistory: new Map([['ETH', Array(10).fill(0.01)]]),
        smoothedPC1Loadings: new Map([
          ['ETH', 0.8],
          ['BTC', 0.7],
        ]),
      });

      const shouldEnterLong = (monitor as unknown as {
        shouldEnterLong: (zScore: number, asset: string) => boolean
      }).shouldEnterLong.bind(monitor);

      expect(shouldEnterLong(-3.0, 'ETH')).toBe(false);
    });

    it('allows entry when within PC1 exposure cap', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig({
        sizing: {
          mode: 'flat',
          baseNotionalUsd: 50,
          minPositionUsd: 25,
          maxPositionUsd: 200,
          maxPortfolioPC1ExposureUsd: 200,
        },
      }));

      Object.assign(monitor, {
        regimeState: 'neutral' as RegimeState,
        activePositions: new Map(),
        factorModel: { assetBetas: new Map([['ETH', [0.5, 0.2]]]) },
        returnHistory: new Map([['ETH', Array(10).fill(0.01)]]),
        smoothedPC1Loadings: new Map([['ETH', 0.5]]),
      });

      const shouldEnterLong = (monitor as unknown as {
        shouldEnterLong: (zScore: number, asset: string) => boolean
      }).shouldEnterLong.bind(monitor);

      expect(shouldEnterLong(-3.0, 'ETH')).toBe(true);
    });

    it('calculates portfolio PC1 exposure correctly', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      Object.assign(monitor, {
        activePositions: new Map([
          ['pos1', { direction: 'long', asset: 'ETH', positionSizeUsd: 100 }],
          ['pos2', { direction: 'short', asset: 'BTC', positionSizeUsd: 100 }],
        ]),
        factorModel: {
          assetBetas: new Map([
            ['ETH', [0.8, 0.2]],
            ['BTC', [0.6, 0.3]],
          ]),
        },
        smoothedPC1Loadings: new Map([
          ['ETH', 0.8],
          ['BTC', 0.6],
        ]),
      });

      const computePortfolioPC1Exposure = (monitor as unknown as {
        computePortfolioPC1Exposure: () => number
      }).computePortfolioPC1Exposure.bind(monitor);

      const exposure = computePortfolioPC1Exposure();
      const expectedExposure = (1 * 0.8 * 100) + (-1 * 0.6 * 100);
      expect(exposure).toBeCloseTo(expectedExposure, 1);
    });
  });

  describe('EWMA Smoothed PC1 Loadings', () => {
    it('uses smoothed loadings for position sizing', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      Object.assign(monitor, {
        factorModel: { assetBetas: new Map([['ETH', [0.9, 0.2]]]) },
        smoothedPC1Loadings: new Map([['ETH', 0.7]]),
        returnHistory: new Map([['ETH', Array(10).fill(0.01)]]),
      });

      const getPC1Loading = (monitor as unknown as {
        getPC1Loading: (asset: string, useSmoothed?: boolean) => number
      }).getPC1Loading.bind(monitor);

      expect(getPC1Loading('ETH', true)).toBe(0.7);
      expect(getPC1Loading('ETH', false)).toBe(0.9);
    });

    it('falls back to raw loading when smoothed not available', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig());

      Object.assign(monitor, {
        factorModel: { assetBetas: new Map([['ETH', [0.9, 0.2]]]) },
        smoothedPC1Loadings: new Map(),
      });

      const getPC1Loading = (monitor as unknown as {
        getPC1Loading: (asset: string, useSmoothed?: boolean) => number
      }).getPC1Loading.bind(monitor);

      expect(getPC1Loading('ETH', true)).toBe(0.9);
    });
  });

  describe('EWMA Regime Momentum', () => {
    it('computes volatility-adjusted momentum correctly', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig({
        regimeGating: {
          enabled: true,
          ewmaSpan: 3,
          regimeThreshold: 0.5,
          hysteresisTicks: 2,
        },
      }));

      const computeRegimeState = (monitor as unknown as {
        computeRegimeState: (pc1Return: number) => void
      }).computeRegimeState.bind(monitor);

      for (let i = 0; i < 5; i++) {
        computeRegimeState(-0.02);
      }

      const internalState = monitor as unknown as { pc1Momentum: number };
      expect(internalState.pc1Momentum).toBeLessThan(0);
    });

    it('momentum responds to regime change with lag', () => {
      const monitor = new PCAStatArbMonitor(createTestConfig({
        regimeGating: {
          enabled: true,
          ewmaSpan: 5,
          regimeThreshold: 0.5,
          hysteresisTicks: 3,
        },
      }));

      const computeRegimeState = (monitor as unknown as {
        computeRegimeState: (pc1Return: number) => void
      }).computeRegimeState.bind(monitor);

      for (let i = 0; i < 5; i++) {
        computeRegimeState(-0.02);
      }

      const momentumAfterDowntrend = (monitor as unknown as { pc1Momentum: number }).pc1Momentum;

      computeRegimeState(0.02);

      const momentumAfterOneUp = (monitor as unknown as { pc1Momentum: number }).pc1Momentum;

      expect(momentumAfterOneUp).toBeGreaterThan(momentumAfterDowntrend);
      expect(momentumAfterOneUp).toBeLessThan(0);
    });
  });
});
