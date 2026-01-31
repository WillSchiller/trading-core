import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  assetToSymbol,
  symbolToAsset,
  makeClientOrderId,
  directionToSide,
  closingSide,
} from '../../src/execution/perps/types.js';
import { toMicros, fromMicros, formatUsd, configToMicros, mulDiv } from '../../src/execution/perps/money.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../src/utils/alerts.js', () => ({
  sendAlert: vi.fn().mockResolvedValue(undefined),
  initAlerts: vi.fn(),
}));

describe('types / symbol mapping', () => {
  it('maps known assets to Binance USDT-M symbols', () => {
    expect(assetToSymbol('ETH')).toBe('ETHUSDT');
    expect(assetToSymbol('BTC')).toBe('BTCUSDT');
    expect(assetToSymbol('SOL')).toBe('SOLUSDT');
    expect(assetToSymbol('ARB')).toBe('ARBUSDT');
  });

  it('falls back to ASSET+USDT for unknown assets', () => {
    expect(assetToSymbol('XYZ')).toBe('XYZUSDT');
  });

  it('reverse maps symbol to asset', () => {
    expect(symbolToAsset('ETHUSDT')).toBe('ETH');
    expect(symbolToAsset('BTCUSDT')).toBe('BTC');
  });

  it('strips USDT for unknown symbols', () => {
    expect(symbolToAsset('XYZUSDT')).toBe('XYZ');
  });
});

describe('makeClientOrderId', () => {
  it('produces deterministic IDs', () => {
    const id1 = makeClientOrderId(1706000000000, 'ETH', 'SELL');
    const id2 = makeClientOrderId(1706000000000, 'ETH', 'SELL');
    expect(id1).toBe(id2);
    expect(id1).toBe('pca_1706000000000_ETH_SELL');
  });

  it('produces different IDs for different inputs', () => {
    const a = makeClientOrderId(1706000000000, 'ETH', 'SELL');
    const b = makeClientOrderId(1706000000001, 'ETH', 'SELL');
    const c = makeClientOrderId(1706000000000, 'BTC', 'SELL');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('directionToSide / closingSide', () => {
  it('maps short to SELL entry', () => {
    expect(directionToSide('short')).toBe('SELL');
  });

  it('maps long to BUY entry', () => {
    expect(directionToSide('long')).toBe('BUY');
  });

  it('closing short buys back', () => {
    expect(closingSide('short')).toBe('BUY');
  });

  it('closing long sells', () => {
    expect(closingSide('long')).toBe('SELL');
  });
});

describe('money utilities', () => {
  describe('toMicros', () => {
    it('converts integer strings', () => {
      expect(toMicros('100')).toBe(100_000_000n);
    });
    it('converts decimal strings', () => {
      expect(toMicros('1.23')).toBe(1_230_000n);
    });
    it('converts negative values', () => {
      expect(toMicros('-50.5')).toBe(-50_500_000n);
    });
    it('converts integer without decimals', () => {
      expect(toMicros('2000')).toBe(2_000_000_000n);
    });
    it('truncates beyond 6 decimals', () => {
      expect(toMicros('1.1234567')).toBe(1_123_456n);
    });
    it('rejects invalid input', () => {
      expect(() => toMicros('')).toThrow();
      expect(() => toMicros('NaN')).toThrow();
      expect(() => toMicros('Infinity')).toThrow();
    });
  });

  describe('fromMicros', () => {
    it('converts to string with 6 decimal places', () => {
      expect(fromMicros(100_000_000n)).toBe('100.000000');
    });
    it('handles negative values', () => {
      expect(fromMicros(-50_500_000n)).toBe('-50.500000');
    });
    it('handles zero', () => {
      expect(fromMicros(0n)).toBe('0.000000');
    });
  });

  describe('round-trip', () => {
    it('preserves value through toMicros→fromMicros', () => {
      expect(fromMicros(toMicros('123.456789'))).toBe('123.456789');
    });
    it('preserves integers', () => {
      expect(fromMicros(toMicros('2000'))).toBe('2000.000000');
    });
  });

  describe('formatUsd', () => {
    it('formats to 2 decimal places', () => {
      expect(formatUsd(toMicros('123.456789'))).toBe('123.45');
    });
    it('formats negative', () => {
      expect(formatUsd(toMicros('-10.5'))).toBe('-10.50');
    });
  });

  describe('configToMicros', () => {
    it('converts config number to micros', () => {
      expect(configToMicros(100)).toBe(100_000_000n);
    });
    it('handles decimals', () => {
      expect(configToMicros(0.5)).toBe(500_000n);
    });
  });

  describe('mulDiv', () => {
    it('multiplies two micros values and divides by scale', () => {
      const price = toMicros('2000');
      const qty = toMicros('0.1');
      expect(mulDiv(price, qty)).toBe(toMicros('200'));
    });
    it('handles negative values', () => {
      const diff = toMicros('-100');
      const qty = toMicros('0.1');
      expect(mulDiv(diff, qty)).toBe(toMicros('-10'));
    });
  });

  describe('aggregation equality', () => {
    it('sum of individual PnLs equals aggregate', () => {
      const trades = [
        { entry: '2000', exit: '2010', qty: '0.1' },
        { entry: '3000', exit: '2990', qty: '0.05' },
        { entry: '1500', exit: '1520', qty: '0.2' },
      ];
      let totalMicros = 0n;
      for (const t of trades) {
        const diff = toMicros(t.exit) - toMicros(t.entry);
        totalMicros += mulDiv(diff, toMicros(t.qty));
      }
      // (10*0.1) + (-10*0.05) + (20*0.2) = 1 + -0.5 + 4 = 4.5
      expect(totalMicros).toBe(toMicros('4.5'));
    });
  });
});

describe('BinanceFuturesClient', () => {
  let BinanceFuturesClient: typeof import('../../src/execution/perps/binance-client.js').BinanceFuturesClient;

  beforeEach(async () => {
    const mod = await import('../../src/execution/perps/binance-client.js');
    BinanceFuturesClient = mod.BinanceFuturesClient;
  });

  describe('HMAC signing', () => {
    it('generates a valid HMAC-SHA256 signature', () => {
      const client = new BinanceFuturesClient({
        apiKey: 'testkey',
        apiSecret: 'testsecret',
        paperMode: true,
      });
      const sign = (client as any).sign.bind(client);
      const sig = sign('symbol=ETHUSDT&side=BUY&timestamp=1234567890');
      expect(sig).toMatch(/^[a-f0-9]{64}$/);
      expect(sign('symbol=ETHUSDT&side=BUY&timestamp=1234567890')).toBe(sig);
    });
  });

  describe('quantity rounding', () => {
    it('rounds down to step size', () => {
      const client = new BinanceFuturesClient({
        apiKey: 'k',
        apiSecret: 's',
        paperMode: true,
      });
      (client as any).precisionCache.set('ETHUSDT', {
        quantityPrecision: 3,
        pricePrecision: 2,
        minQty: 0.001,
        stepSize: 0.001,
        minNotional: 5,
      });
      expect(client.roundQuantity('ETHUSDT', 0.12345)).toBe(0.123);
      expect(client.roundQuantity('ETHUSDT', 0.1239)).toBe(0.123);
    });

    it('handles integer step sizes', () => {
      const client = new BinanceFuturesClient({
        apiKey: 'k',
        apiSecret: 's',
        paperMode: true,
      });
      (client as any).precisionCache.set('BTCUSDT', {
        quantityPrecision: 3,
        pricePrecision: 1,
        minQty: 0.001,
        stepSize: 0.001,
        minNotional: 5,
      });
      expect(client.roundQuantity('BTCUSDT', 0.00456)).toBe(0.004);
    });

    it('returns default precision for unknown symbols', () => {
      const client = new BinanceFuturesClient({
        apiKey: 'k',
        apiSecret: 's',
        paperMode: true,
      });
      const precision = client.getPrecision('UNKNOWN');
      expect(precision.quantityPrecision).toBe(3);
      expect(precision.stepSize).toBe(0.001);
    });
  });

  describe('paper mode', () => {
    it('returns simulated order in paper mode', async () => {
      const client = new BinanceFuturesClient({
        apiKey: 'k',
        apiSecret: 's',
        paperMode: true,
      });
      const result = await client.placeOrder({
        symbol: 'ETHUSDT',
        side: 'SELL',
        quantity: 0.1,
        clientOrderId: 'test_order_1',
      });
      expect(result.status).toBe('FILLED');
      expect(result.clientOrderId).toBe('test_order_1');
      expect(result.symbol).toBe('ETHUSDT');
      expect(result.side).toBe('SELL');
    });

    it('simulates adverse fill price with paper fill model', async () => {
      const client = new BinanceFuturesClient({
        apiKey: 'k',
        apiSecret: 's',
        paperMode: true,
        paperFill: { spreadBps: 5, slippageBps: 10, takerFeeBps: 2, maxSlippageBps: 20 },
      });
      const result = await client.placeOrder({
        symbol: 'ETHUSDT',
        side: 'BUY',
        quantity: 0.1,
        clientOrderId: 'test_fill_1',
        markPrice: 2000,
      });
      const fillPrice = parseFloat(result.avgPrice);
      // BUY should fill ABOVE mark: mark + spread + slippage + fee
      expect(fillPrice).toBeGreaterThan(2000);
      // spread=5bps=1.00, slippage=10bps=2.00, fee=2bps=0.40 → total adverse = 3.40
      expect(fillPrice).toBeCloseTo(2003.4, 1);
    });

    it('simulates adverse fill for SELL (below mark)', async () => {
      const client = new BinanceFuturesClient({
        apiKey: 'k',
        apiSecret: 's',
        paperMode: true,
        paperFill: { spreadBps: 5, slippageBps: 10, takerFeeBps: 2, maxSlippageBps: 20 },
      });
      const result = await client.placeOrder({
        symbol: 'ETHUSDT',
        side: 'SELL',
        quantity: 0.1,
        clientOrderId: 'test_fill_2',
        markPrice: 2000,
      });
      const fillPrice = parseFloat(result.avgPrice);
      expect(fillPrice).toBeLessThan(2000);
      // spread=5bps=1.00, slippage=10bps=2.00, fee=2bps=0.40 → total adverse = 3.40
      expect(fillPrice).toBeCloseTo(1996.6, 1);
    });

    it('caps slippage at maxSlippageBps', async () => {
      const client = new BinanceFuturesClient({
        apiKey: 'k',
        apiSecret: 's',
        paperMode: true,
        paperFill: { spreadBps: 5, slippageBps: 100, takerFeeBps: 2, maxSlippageBps: 10 },
      });
      const result = await client.placeOrder({
        symbol: 'ETHUSDT',
        side: 'BUY',
        quantity: 1.0,
        clientOrderId: 'test_fill_cap',
        markPrice: 2000,
      });
      const fillPrice = parseFloat(result.avgPrice);
      // slippage capped at 10bps=2.00, spread=5bps=1.00, fee=2bps=0.40 → total = 3.40
      expect(fillPrice).toBeCloseTo(2003.4, 1);
    });

    it('blocks setLeverage in paper mode', async () => {
      const client = new BinanceFuturesClient({
        apiKey: 'k',
        apiSecret: 's',
        paperMode: true,
      });
      // Should not throw, just silently skip
      await client.setLeverage('ETHUSDT', 5);
      // No request made — if it tried to call API without proper creds, it would throw
    });

    it('blocks setMarginType in paper mode', async () => {
      const client = new BinanceFuturesClient({
        apiKey: 'k',
        apiSecret: 's',
        paperMode: true,
      });
      await client.setMarginType('ETHUSDT', 'ISOLATED');
    });

    it('blocks cancelAllOrders in paper mode', async () => {
      const client = new BinanceFuturesClient({
        apiKey: 'k',
        apiSecret: 's',
        paperMode: true,
      });
      await client.cancelAllOrders('ETHUSDT');
    });
  });
});

describe('KillSwitch', () => {
  let KillSwitch: typeof import('../../src/execution/perps/kill-switch.js').KillSwitch;

  const mockOrderResponse = {
    orderId: 1, clientOrderId: 'ks_1', status: 'FILLED', avgPrice: '2000',
    executedQty: '0.1', cumQuote: '200', updateTime: 0, symbol: 'ETHUSDT',
    side: 'BUY' as const, type: 'MARKET',
  };

  const mockClient = {
    placeOrder: vi.fn().mockResolvedValue(mockOrderResponse),
    isPaperMode: () => true,
  };

  const mockPersistence = {
    getDailyPnlMicros: vi.fn(),
    getTotalPnlMicros: vi.fn(),
    getConsecutiveLosses: vi.fn(),
    saveKillSwitchEvent: vi.fn().mockResolvedValue(undefined),
    updateExecution: vi.fn().mockResolvedValue(undefined),
  };

  const mockTracker = {
    getOpenPositions: vi.fn().mockReturnValue([]),
    closePosition: vi.fn().mockResolvedValue(undefined),
    hasPosition: vi.fn().mockReturnValue(false),
    getPosition: vi.fn().mockReturnValue(undefined),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/execution/perps/kill-switch.js');
    KillSwitch = mod.KillSwitch;
  });

  it('returns safe when all limits ok', async () => {
    mockPersistence.getDailyPnlMicros.mockResolvedValue(0n);
    mockPersistence.getTotalPnlMicros.mockResolvedValue(0n);
    mockPersistence.getConsecutiveLosses.mockResolvedValue(0);

    const ks = new KillSwitch(
      { dailyDrawdownLimitUsd: 100, maxTotalLossUsd: 500, maxConsecutiveLosses: 5, checkIntervalMs: 60000 },
      mockClient as any,
      mockPersistence as any,
      mockTracker as any,
    );
    const result = await ks.check();
    expect(result.safe).toBe(true);
  });

  it('triggers on daily drawdown', async () => {
    mockPersistence.getDailyPnlMicros.mockResolvedValue(-150_000_000n);
    mockPersistence.getTotalPnlMicros.mockResolvedValue(-150_000_000n);
    mockPersistence.getConsecutiveLosses.mockResolvedValue(2);

    const ks = new KillSwitch(
      { dailyDrawdownLimitUsd: 100, maxTotalLossUsd: 500, maxConsecutiveLosses: 5, checkIntervalMs: 60000 },
      mockClient as any,
      mockPersistence as any,
      mockTracker as any,
    );
    const result = await ks.check();
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Daily drawdown');
    expect(ks.isTriggered()).toBe(true);
  });

  it('triggers on total loss cap', async () => {
    mockPersistence.getDailyPnlMicros.mockResolvedValue(-50_000_000n);
    mockPersistence.getTotalPnlMicros.mockResolvedValue(-600_000_000n);
    mockPersistence.getConsecutiveLosses.mockResolvedValue(0);

    const ks = new KillSwitch(
      { dailyDrawdownLimitUsd: 100, maxTotalLossUsd: 500, maxConsecutiveLosses: 5, checkIntervalMs: 60000 },
      mockClient as any,
      mockPersistence as any,
      mockTracker as any,
    );
    const result = await ks.check();
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Total loss cap');
  });

  it('triggers on consecutive losses', async () => {
    mockPersistence.getDailyPnlMicros.mockResolvedValue(-30_000_000n);
    mockPersistence.getTotalPnlMicros.mockResolvedValue(-100_000_000n);
    mockPersistence.getConsecutiveLosses.mockResolvedValue(5);

    const ks = new KillSwitch(
      { dailyDrawdownLimitUsd: 100, maxTotalLossUsd: 500, maxConsecutiveLosses: 5, checkIntervalMs: 60000 },
      mockClient as any,
      mockPersistence as any,
      mockTracker as any,
    );
    const result = await ks.check();
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Consecutive losses');
  });

  it('stays triggered after first trigger', async () => {
    mockPersistence.getDailyPnlMicros.mockResolvedValue(-150_000_000n);
    mockPersistence.getTotalPnlMicros.mockResolvedValue(-150_000_000n);
    mockPersistence.getConsecutiveLosses.mockResolvedValue(0);

    const ks = new KillSwitch(
      { dailyDrawdownLimitUsd: 100, maxTotalLossUsd: 500, maxConsecutiveLosses: 5, checkIntervalMs: 60000 },
      mockClient as any,
      mockPersistence as any,
      mockTracker as any,
    );
    await ks.check();
    expect(ks.isTriggered()).toBe(true);

    mockPersistence.getDailyPnlMicros.mockResolvedValue(0n);
    const result2 = await ks.check();
    expect(result2.safe).toBe(false);
    expect(result2.reason).toBe('Kill switch already triggered');
  });

  it('closes positions with actual fill price from exchange', async () => {
    mockPersistence.getDailyPnlMicros.mockResolvedValue(-150_000_000n);
    mockPersistence.getTotalPnlMicros.mockResolvedValue(-150_000_000n);
    mockPersistence.getConsecutiveLosses.mockResolvedValue(0);
    mockTracker.getOpenPositions.mockReturnValue([
      { symbol: 'ETHUSDT', asset: 'ETH', direction: 'short', quantity: 0.1, clientOrderId: 'test1', markPrice: 2100, unrealizedPnl: -10, entryPrice: 2000 },
    ]);

    const ks = new KillSwitch(
      { dailyDrawdownLimitUsd: 100, maxTotalLossUsd: 500, maxConsecutiveLosses: 5, checkIntervalMs: 60000 },
      mockClient as any,
      mockPersistence as any,
      mockTracker as any,
    );
    await ks.check();
    expect(mockClient.placeOrder).toHaveBeenCalled();
    expect(mockTracker.closePosition).toHaveBeenCalledWith('ETH');
    expect(mockPersistence.updateExecution).toHaveBeenCalledWith('test1', expect.objectContaining({
      exitPrice: '2000',
    }));
  });

  it('tracks failed closes and retries on next check', async () => {
    mockPersistence.getDailyPnlMicros.mockResolvedValue(-150_000_000n);
    mockPersistence.getTotalPnlMicros.mockResolvedValue(-150_000_000n);
    mockPersistence.getConsecutiveLosses.mockResolvedValue(0);
    mockClient.placeOrder.mockRejectedValueOnce(new Error('network error'));
    mockTracker.getOpenPositions.mockReturnValue([
      { symbol: 'ETHUSDT', asset: 'ETH', direction: 'short', quantity: 0.1, clientOrderId: 'test1', markPrice: 2000, unrealizedPnl: -5, entryPrice: 2000 },
    ]);

    const ks = new KillSwitch(
      { dailyDrawdownLimitUsd: 100, maxTotalLossUsd: 500, maxConsecutiveLosses: 5, checkIntervalMs: 60000 },
      mockClient as any,
      mockPersistence as any,
      mockTracker as any,
    );
    await ks.check();
    expect(mockTracker.closePosition).not.toHaveBeenCalled();

    mockClient.placeOrder.mockResolvedValue(mockOrderResponse);
    mockTracker.hasPosition.mockReturnValue(true);
    mockTracker.getPosition.mockReturnValue({
      symbol: 'ETHUSDT', asset: 'ETH', direction: 'short', quantity: 0.1,
      clientOrderId: 'test1', markPrice: 2000, unrealizedPnl: -5, entryPrice: 2000,
    });
    await ks.check();
    expect(mockTracker.closePosition).toHaveBeenCalledWith('ETH');
  });
});

describe('PositionTracker', () => {
  let PositionTracker: typeof import('../../src/execution/perps/position-tracker.js').PositionTracker;

  const mockClient = {
    getPositionRisk: vi.fn().mockResolvedValue([]),
    isPaperMode: () => true,
    placeOrder: vi.fn().mockResolvedValue({}),
  };

  const mockPersistence = {
    getOpenExecutions: vi.fn().mockResolvedValue([]),
    updateExecution: vi.fn().mockResolvedValue(undefined),
    updateExecutionEntry: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/execution/perps/position-tracker.js');
    PositionTracker = mod.PositionTracker;
  });

  it('tracks open positions', async () => {
    const tracker = new PositionTracker(mockClient as any, mockPersistence as any);
    expect(tracker.getOpenCount()).toBe(0);

    await tracker.openPosition({
      symbol: 'ETHUSDT', asset: 'ETH', direction: 'short', side: 'SELL',
      quantity: 0.1, entryPrice: 2000, markPrice: 2000, unrealizedPnl: 0,
      notionalUsd: 200, leverage: 1, marginType: 'ISOLATED',
      clientOrderId: 'test1', openedAt: Date.now(),
    });
    expect(tracker.getOpenCount()).toBe(1);
    expect(tracker.hasPosition('ETH')).toBe(true);
    expect(tracker.getTotalExposureUsd()).toBe(200);
  });

  it('removes position on close', async () => {
    const tracker = new PositionTracker(mockClient as any, mockPersistence as any);
    await tracker.openPosition({
      symbol: 'ETHUSDT', asset: 'ETH', direction: 'short', side: 'SELL',
      quantity: 0.1, entryPrice: 2000, markPrice: 2000, unrealizedPnl: 0,
      notionalUsd: 200, leverage: 1, marginType: 'ISOLATED',
      clientOrderId: 'test1', openedAt: Date.now(),
    });
    const closed = await tracker.closePosition('ETH');
    expect(closed).toBeDefined();
    expect(closed!.asset).toBe('ETH');
    expect(tracker.getOpenCount()).toBe(0);
  });

  it('updates mark price and unrealized PnL', async () => {
    const tracker = new PositionTracker(mockClient as any, mockPersistence as any);
    await tracker.openPosition({
      symbol: 'ETHUSDT', asset: 'ETH', direction: 'short', side: 'SELL',
      quantity: 0.1, entryPrice: 2000, markPrice: 2000, unrealizedPnl: 0,
      notionalUsd: 200, leverage: 1, marginType: 'ISOLATED',
      clientOrderId: 'test1', openedAt: Date.now(),
    });
    tracker.updateMarkPrice('ETH', 1950);
    const pos = tracker.getPosition('ETH');
    expect(pos!.markPrice).toBe(1950);
    expect(pos!.unrealizedPnl).toBeCloseTo(5); // short: (2000-1950)*0.1
  });

  it('reconciles closing positions with exchange on startup (paper)', async () => {
    mockPersistence.getOpenExecutions.mockResolvedValue([
      {
        symbol: 'ETHUSDT', asset: 'ETH', direction: 'short', side: 'SELL',
        quantity: '0.1', entryPrice: '2000', leverage: 1, marginType: 'ISOLATED',
        clientOrderId: 'test1', signalTimestamp: 1706000000000,
        status: 'closing',
      },
    ]);

    const tracker = new PositionTracker(mockClient as any, mockPersistence as any);
    await tracker.reconcileOnStartup();
    expect(mockPersistence.updateExecution).toHaveBeenCalledWith('test1', expect.objectContaining({
      status: 'closed',
      exitReason: 'reconciliation',
    }));
  });

  it('adopts pending_open positions in paper mode', async () => {
    mockPersistence.getOpenExecutions.mockResolvedValue([
      {
        symbol: 'ETHUSDT', asset: 'ETH', direction: 'short', side: 'SELL',
        quantity: '0.1', entryPrice: '2000', leverage: 1, marginType: 'ISOLATED',
        clientOrderId: 'test_pending', signalTimestamp: 1706000000000,
        status: 'pending_open',
      },
    ]);

    const tracker = new PositionTracker(mockClient as any, mockPersistence as any);
    await tracker.reconcileOnStartup();
    expect(mockPersistence.updateExecution).toHaveBeenCalledWith('test_pending', expect.objectContaining({
      status: 'open',
    }));
    expect(tracker.getOpenCount()).toBe(1);
    expect(tracker.hasPosition('ETH')).toBe(true);
  });

  it('reconciles on startup with DB open positions', async () => {
    mockPersistence.getOpenExecutions.mockResolvedValue([
      {
        symbol: 'ETHUSDT', asset: 'ETH', direction: 'short', side: 'SELL',
        quantity: '0.1', entryPrice: '2000', leverage: 1, marginType: 'ISOLATED',
        clientOrderId: 'test1', signalTimestamp: 1706000000000,
        status: 'open',
      },
    ]);
    mockClient.getPositionRisk.mockResolvedValue([]);

    const tracker = new PositionTracker(mockClient as any, mockPersistence as any);
    await tracker.reconcileOnStartup();
    expect(tracker.getOpenCount()).toBe(1);
  });
});

describe('PerpsExecutor', () => {
  let PerpsExecutor: typeof import('../../src/execution/perps/perps-executor.js').PerpsExecutor;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/execution/perps/perps-executor.js');
    PerpsExecutor = mod.PerpsExecutor;
  });

  const baseConfig = {
    enabled: true,
    paperMode: true,
    leverage: 1,
    marginType: 'ISOLATED' as const,
    enableLongs: false,
    enableShorts: true,
    maxConcurrentPositions: 5,
    maxPositionSizeUsd: 150,
    minPositionSizeUsd: 10,
    maxTotalExposureUsd: 750,
    cooldownMs: 0,
    heartbeatIntervalMs: 60000,
    positionSyncIntervalMs: 600000,
    maxHoldTimeMsShort: 14400000,
    maxHoldTimeMsLong: 21600000,
    killSwitch: {
      dailyDrawdownLimitUsd: 100,
      maxTotalLossUsd: 500,
      maxConsecutiveLosses: 5,
      checkIntervalMs: 60000,
    },
    paperFill: {
      spreadBps: 2,
      slippageBps: 5,
      takerFeeBps: 2,
      maxSlippageBps: 20,
    },
  };

  const testRunId = 'test-run-001';

  it('rejects long signals when longs disabled', async () => {
    const executor = new PerpsExecutor(baseConfig, null as any, 'key', 'secret', testRunId);
    (executor as any).running = true;
    (executor as any).config.enableLongs = false;

    const saveSpy = vi.fn();
    (executor as any).persistence = { getExecutionByClientOrderId: vi.fn(), saveExecution: saveSpy };

    await executor.handleSignal({
      timestamp: Date.now(),
      asset: 'ETH',
      direction: 'long',
      zScore: 3.0,
      residual: 0.02,
      confidence: 0.9,
      entryPrice: 2000,
      positionSizeUsd: 100,
      factorContext: { pc1Return: 0.01, pc2Return: -0.005 },
      allAssetResiduals: {},
    });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('processes exits even when executor is stopped', async () => {
    const executor = new PerpsExecutor(baseConfig, null as any, 'key', 'secret', testRunId);
    (executor as any).running = false;

    const mockPosition = {
      symbol: 'ETHUSDT', asset: 'ETH', direction: 'short' as const, side: 'SELL' as const,
      quantity: 0.1, entryPrice: 2000, markPrice: 1950, unrealizedPnl: 5,
      notionalUsd: 195, leverage: 1, marginType: 'ISOLATED' as const,
      clientOrderId: 'test1', openedAt: Date.now() - 60000,
    };

    const mockTracker = {
      getPosition: vi.fn().mockReturnValue(mockPosition),
      closePosition: vi.fn().mockResolvedValue(mockPosition),
      hasPosition: vi.fn().mockReturnValue(true),
    };
    (executor as any).tracker = mockTracker;

    const mockPersistence = {
      claimClose: vi.fn().mockResolvedValue(true),
      updateExecution: vi.fn().mockResolvedValue(undefined),
    };
    (executor as any).persistence = mockPersistence;

    const mockClient = {
      placeOrder: vi.fn().mockResolvedValue({
        orderId: 1, clientOrderId: 'close1', symbol: 'ETHUSDT', side: 'BUY',
        type: 'MARKET', status: 'FILLED', avgPrice: '1950',
        executedQty: '0.1', cumQuote: '195', updateTime: Date.now(),
      }),
      roundQuantity: vi.fn().mockReturnValue(0.1),
    };
    (executor as any).client = mockClient;

    await executor.handleExit({
      timestamp: Date.now() - 60000,
      asset: 'ETH',
      direction: 'short',
      zScore: 0.3,
      residual: 0.001,
      confidence: 0.9,
      entryPrice: 2000,
      positionSizeUsd: 100,
      factorContext: { pc1Return: 0.01, pc2Return: -0.005 },
      allAssetResiduals: {},
      exitTimestamp: Date.now(),
      exitZScore: 0.3,
      holdTimeMs: 60000,
      exitPrice: 1950,
      pnlBps: 250,
      exitReason: 'zscore',
      peakPnlBps: 300,
      troughPnlBps: -50,
      regimeState: 'neutral',
      attribution: { totalPnlBps: 250, pc1PnlBps: 50, residualPnlBps: 200 },
    });

    expect(mockPersistence.claimClose).toHaveBeenCalledWith('test1');
    expect(mockClient.placeOrder).toHaveBeenCalled();
    expect(mockTracker.closePosition).toHaveBeenCalledWith('ETH');
  });

  it('blocks duplicate exit when claimClose returns false', async () => {
    const executor = new PerpsExecutor(baseConfig, null as any, 'key', 'secret', testRunId);
    (executor as any).running = true;

    const mockPosition = {
      symbol: 'ETHUSDT', asset: 'ETH', direction: 'short' as const,
      quantity: 0.1, entryPrice: 2000, clientOrderId: 'test1',
    };

    (executor as any).tracker = {
      getPosition: vi.fn().mockReturnValue(mockPosition),
      closePosition: vi.fn(),
    };

    const mockPersistence = {
      claimClose: vi.fn().mockResolvedValue(false),
      updateExecution: vi.fn(),
    };
    (executor as any).persistence = mockPersistence;

    const mockClient = { placeOrder: vi.fn() };
    (executor as any).client = mockClient;

    await executor.handleExit({
      timestamp: Date.now(),
      asset: 'ETH',
      direction: 'short',
      zScore: 0.3,
      residual: 0.001,
      confidence: 0.9,
      entryPrice: 2000,
      positionSizeUsd: 100,
      factorContext: { pc1Return: 0.01, pc2Return: -0.005 },
      allAssetResiduals: {},
      exitTimestamp: Date.now(),
      exitZScore: 0.3,
      holdTimeMs: 60000,
      exitPrice: 1950,
      pnlBps: 250,
      exitReason: 'zscore',
      peakPnlBps: 300,
      troughPnlBps: -50,
      regimeState: 'neutral',
      attribution: { totalPnlBps: 250, pc1PnlBps: 50, residualPnlBps: 200 },
    });

    expect(mockClient.placeOrder).not.toHaveBeenCalled();
  });

  it('does not call setLeverage in paper mode during start', async () => {
    const executor = new PerpsExecutor(baseConfig, null as any, 'key', 'secret', testRunId);
    const mockClient = (executor as any).client;
    const setLeverageSpy = vi.spyOn(mockClient, 'setLeverage');
    const setMarginSpy = vi.spyOn(mockClient, 'setMarginType');

    vi.spyOn(mockClient, 'refreshPrecisionCache').mockResolvedValue(undefined);
    vi.spyOn((executor as any).tracker, 'reconcileOnStartup').mockResolvedValue(undefined);
    vi.spyOn((executor as any).tracker, 'startPeriodicSync').mockImplementation(() => {});

    await executor.start();
    expect(setLeverageSpy).not.toHaveBeenCalled();
    expect(setMarginSpy).not.toHaveBeenCalled();
    await executor.stop();
  });

  it('exposes runId and mode', () => {
    const executor = new PerpsExecutor(baseConfig, null as any, 'key', 'secret', testRunId);
    expect(executor.getRunId()).toBe(testRunId);
    expect(executor.getMode()).toBe('paper');
  });

  it('uses live mode when paperMode is false', () => {
    const liveConfig = { ...baseConfig, paperMode: false };
    const executor = new PerpsExecutor(liveConfig, null as any, 'key', 'secret', 'live-run-1');
    expect(executor.getMode()).toBe('live');
  });
});
