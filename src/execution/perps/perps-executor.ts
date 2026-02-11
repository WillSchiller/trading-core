import type { Pool } from 'pg';
import { createChildLogger } from '../../utils/logger.js';
import { sendAlert } from '../../utils/alerts.js';
import { PerpsPersistence } from './perps-persistence.js';
import { PositionTracker } from './position-tracker.js';
import { KillSwitch } from './kill-switch.js';
import {
  assetToSymbol,
  directionToSide,
  closingSide,
  makeClientOrderId,
} from './types.js';
import type {
  PerpsExecutionConfig,
  PerpsPosition,
  PerpsMode,
  PerpsExchangeClient,
  OrderResult,
} from './types.js';
import { toMicros, fromMicros, mulDiv } from './money.js';
import type { PCASignalEvent, PCAExitEvent } from '../../research/pca-stat-arb.js';

export class PerpsExecutor {
  private readonly client: PerpsExchangeClient;
  private readonly persistence: PerpsPersistence;
  private readonly tracker: PositionTracker;
  private readonly killSwitch: KillSwitch;
  private readonly config: PerpsExecutionConfig;
  private readonly excludeAssets: Set<string>;
  private readonly runId: string;
  private readonly mode: PerpsMode;
  private readonly log;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastTradeAt = 0;
  private running = false;
  private exitLocks = new Set<string>();
  private priceCallback: ((quote: { venue: string; pair: string; mid: number }) => void) | null = null;
  private suspendUntil = 0;
  private lastMarginCheckAt = 0;
  private static readonly MARGIN_CHECK_INTERVAL_MS = 300_000;
  private static readonly MARGIN_SUSPEND_MS = 300_000;

  constructor(config: PerpsExecutionConfig, pool: Pool, client: PerpsExchangeClient, runId: string) {
    this.config = config;
    this.excludeAssets = new Set((config as any).excludeAssets ?? []);
    this.runId = runId;
    this.mode = config.paperMode ? 'paper' : 'live';
    this.log = createChildLogger({ component: 'perps-executor', runId, mode: this.mode, exchange: client.exchange });
    this.client = client;
    this.persistence = new PerpsPersistence(pool, runId, this.mode);
    this.tracker = new PositionTracker(this.client, this.persistence);
    this.killSwitch = new KillSwitch(config.killSwitch, this.client, this.persistence, this.tracker);
  }

  async start(): Promise<void> {
    this.log.info({
      paperMode: this.config.paperMode,
      leverage: this.config.leverage,
      marginType: this.config.marginType,
      enableLongs: this.config.enableLongs,
      enableShorts: this.config.enableShorts,
      maxPositions: this.config.maxConcurrentPositions,
      maxPositionSizeUsd: this.config.maxPositionSizeUsd,
      runId: this.runId,
      mode: this.mode,
    }, 'Starting perps executor');

    await this.client.refreshPrecisionCache();

    if (!this.config.paperMode) {
      this.log.info({ leverage: this.config.leverage, marginType: this.config.marginType }, 'Leverage will be set per-asset before each entry order');
    }

    try {
      await this.tracker.reconcileOnStartup();
    } catch (err) {
      this.log.error({ error: (err as Error).message, runId: this.runId }, 'Failed to reconcile positions on startup — continuing without sync');
    }
    this.tracker.startPeriodicSync(this.config.positionSyncIntervalMs);

    if (!this.config.paperMode) {
      try {
        await this.checkMarginHealth();
      } catch (err) {
        this.log.error({ error: (err as Error).message, runId: this.runId }, 'Failed margin health check on startup — continuing');
      }
    }

    this.heartbeatTimer = setInterval(() => {
      this.onHeartbeat().catch(err =>
        this.log.error({ error: (err as Error).message }, 'Heartbeat error')
      );
    }, this.config.heartbeatIntervalMs);

    this.running = true;
    this.log.info('Perps executor started');

    sendAlert(
      `📊 *Perps Executor Started*\nMode: ${this.mode}\nRun: ${this.runId.slice(0, 8)}\nLeverage: ${this.config.leverage}x\nMax positions: ${this.config.maxConcurrentPositions}`,
      'info'
    ).catch(() => {});
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.tracker.stopPeriodicSync();
    this.log.info({ openPositions: this.tracker.getOpenCount() }, 'Perps executor stopped');
  }

  async handleSignal(event: PCASignalEvent): Promise<void> {
    if (!this.running) return;

    const { asset, direction, timestamp: signalTimestamp } = event;
    const symbol = assetToSymbol(asset);
    const side = directionToSide(direction);
    const clientOrderId = makeClientOrderId(signalTimestamp, asset, side);

    if (direction === 'short' && !this.config.enableShorts) return;
    if (direction === 'long' && !this.config.enableLongs) return;
    if (this.excludeAssets.has(asset)) return;

    const existing = await this.persistence.getExecutionByClientOrderId(clientOrderId);
    if (existing) {
      this.log.debug({ clientOrderId, status: existing.status }, 'Signal already processed (idempotent skip)');
      return;
    }

    if (this.tracker.hasPosition(asset)) {
      this.log.debug({ asset }, 'Already have open position for asset');
      return;
    }

    const killCheck = await this.killSwitch.check();
    if (!killCheck.safe) {
      this.log.warn({ asset, reason: killCheck.reason }, 'Kill switch prevents new trade');
      return;
    }

    if (this.tracker.getOpenCount() >= this.config.maxConcurrentPositions) {
      this.log.debug({ asset, openCount: this.tracker.getOpenCount() }, 'Max concurrent positions reached');
      return;
    }

    const totalExposure = Number(this.tracker.getTotalExposureUsd());
    const positionSizeUsd = Math.min(event.positionSizeUsd, this.config.maxPositionSizeUsd);
    if (positionSizeUsd < this.config.minPositionSizeUsd) {
      this.log.debug({ asset, positionSizeUsd }, 'Position size below minimum');
      return;
    }
    if (totalExposure + positionSizeUsd > this.config.maxTotalExposureUsd) {
      this.log.debug({ asset, totalExposure, positionSizeUsd }, 'Would exceed max total exposure');
      return;
    }

    const now = Date.now();
    if (now < this.suspendUntil) {
      this.log.debug({ asset, resumesInMs: this.suspendUntil - now }, 'Trading suspended (insufficient margin)');
      return;
    }

    if (now - this.lastTradeAt < this.config.cooldownMs) {
      this.log.debug({ asset, cooldownRemaining: this.config.cooldownMs - (now - this.lastTradeAt) }, 'In cooldown');
      return;
    }

    const quantity = positionSizeUsd / event.entryPrice;
    const roundedQty = this.client.roundQuantity(symbol, quantity);
    if (parseFloat(roundedQty) <= 0) {
      this.log.warn({ asset, quantity, roundedQty }, 'Quantity rounds to zero');
      return;
    }

    const notionalStr = String(event.entryPrice * parseFloat(roundedQty));
    const pendingId = await this.persistence.saveExecution({
      symbol,
      asset,
      direction,
      side,
      entryPrice: String(event.entryPrice),
      exitPrice: null,
      quantity: roundedQty,
      notionalUsd: notionalStr,
      realizedPnl: null,
      unrealizedPnl: null,
      clientOrderId,
      entryOrderId: null,
      exitOrderId: null,
      status: 'pending_open',
      isPaperTrade: this.config.paperMode,
      signalTimestamp,
      zScore: event.zScore,
      residual: event.residual,
      confidence: event.confidence,
      exitReason: null,
      leverage: this.config.leverage,
      marginType: this.config.marginType,
    });

    if (pendingId === -1) {
      this.log.debug({ clientOrderId }, 'Duplicate pending_open (idempotent skip)');
      return;
    }

    if (!this.config.paperMode) {
      try {
        await this.client.setLeverage(symbol, this.config.leverage);
      } catch (err) {
        this.log.warn({ symbol, error: (err as Error).message }, 'Failed to set leverage before entry');
      }
    }

    const useOrderType = this.config.orderType ?? 'taker';
    let orderResponse: OrderResult;
    try {
      orderResponse = await this.client.placeOrder({
        symbol,
        side,
        quantity: roundedQty,
        clientOrderId,
        markPrice: event.entryPrice,
        orderType: useOrderType,
      });
    } catch (err) {
      const errMsg = (err as Error).message;
      this.log.error({ asset, symbol, error: errMsg, exchange: this.client.exchange }, 'Failed to place entry order');
      await this.persistence.updateExecution(clientOrderId, { status: 'failed', exitReason: 'order_rejected' });
      if (errMsg.includes('-2019') || errMsg.includes('Margin is insufficient')) {
        this.suspendUntil = Date.now() + PerpsExecutor.MARGIN_SUSPEND_MS;
        this.log.warn({ suspendMinutes: PerpsExecutor.MARGIN_SUSPEND_MS / 60000 }, 'Insufficient margin — suspending new entries');
        sendAlert(
          `⚠️ *Margin Insufficient* [${this.mode}/${this.runId.slice(0, 8)}]\nNew entries suspended for 5 min\nCheck Futures wallet balance`,
          'warn'
        ).catch(() => {});
      }
      return;
    }

    if (orderResponse.status === 'RESTING' && orderResponse.exchangeOrderId) {
      const oid = orderResponse.exchangeOrderId;
      const timeoutMs = this.config.makerTimeoutMs ?? 15000;
      this.log.info({ asset, oid, timeoutMs }, 'Entry ALO resting — waiting for fill');
      const fillResult = await this.client.waitForFill(oid, timeoutMs);
      if (fillResult.status === 'FILLED') {
        orderResponse = { ...orderResponse, status: 'FILLED', filledQty: roundedQty };
      } else {
        await this.client.cancelOrder(oid);
        this.log.info({ asset, oid }, 'Entry ALO timed out — canceled');
        await this.persistence.updateExecution(clientOrderId, { status: 'failed', exitReason: 'maker_timeout' });
        return;
      }
    }

    if (orderResponse.status === 'REJECTED') {
      this.log.warn({ asset, symbol, status: orderResponse.status, exchange: this.client.exchange }, 'Entry order rejected');
      await this.persistence.updateExecution(clientOrderId, { status: 'failed', exitReason: 'order_rejected' });
      return;
    }
    if (orderResponse.status === 'CANCELED' || orderResponse.filledQty === '0' || orderResponse.filledQty === '0.0') {
      this.log.warn({ asset, symbol, status: orderResponse.status, exchange: this.client.exchange }, 'Entry order got no fill');
      await this.persistence.updateExecution(clientOrderId, { status: 'failed', exitReason: 'no_fill' });
      return;
    }

    this.lastTradeAt = Date.now();

    const filledQty = orderResponse.filledQty;
    const entryPriceStr = orderResponse.avgPrice !== '0'
      ? orderResponse.avgPrice
      : String(event.entryPrice);
    const notionalUsd = String(Number(entryPriceStr) * Number(filledQty));

    await this.persistence.updateExecutionEntry(clientOrderId, {
      status: 'open',
      entryPrice: entryPriceStr,
      quantity: filledQty,
      notionalUsd,
      entryOrderId: orderResponse.exchangeOrderId ?? 'unknown',
    });

    const position: PerpsPosition = {
      symbol,
      asset,
      direction,
      side,
      quantity: filledQty,
      entryPrice: entryPriceStr,
      markPrice: entryPriceStr,
      unrealizedPnl: '0',
      notionalUsd,
      leverage: this.config.leverage,
      marginType: this.config.marginType,
      clientOrderId,
      openedAt: signalTimestamp,
      peakPnlBps: 0,
      trailingActivated: false,
    };

    await this.tracker.openPosition(position);

    this.log.info({
      asset, symbol, direction, side, quantity: filledQty,
      entryPrice: entryPriceStr, notionalUsd: Number(notionalUsd).toFixed(2),
      zScore: event.zScore.toFixed(2), clientOrderId,
      mode: this.mode, runId: this.runId, exchange: this.client.exchange,
    }, 'Perps position opened');
  }

  async handleExit(event: PCAExitEvent): Promise<void> {
    const { asset, direction, exitReason, exitPrice, pnlBps } = event;
    const position = this.tracker.getPosition(asset);

    if (!position) {
      this.log.debug({ asset }, 'No tracked position to exit');
      return;
    }

    if (this.exitLocks.has(asset)) {
      this.log.debug({ asset }, 'Exit already in progress (lock held)');
      return;
    }
    this.exitLocks.add(asset);

    try {
      const claimed = await this.persistence.claimClose(position.clientOrderId);
      if (!claimed) {
        this.log.debug({ asset, clientOrderId: position.clientOrderId }, 'Position already closing/closed (CAS failed)');
        return;
      }

      const closeSide = closingSide(direction);
      const closeOrderId = `pca_close_${Date.now()}_${asset}_${closeSide}`;

      let closeQty = position.quantity;
      if (!this.client.isPaperMode()) {
        try {
          const exchangePositions = await this.client.getPositions(position.symbol);
          const ep = exchangePositions.find(p => p.symbol === position.symbol);
          if (!ep) {
            this.log.info({ asset }, 'Position already gone from exchange, marking closed');
            await this.tracker.closePosition(asset);
            await this.persistence.updateExecution(position.clientOrderId, {
              status: 'closed',
              exitReason: exitReason,
              realizedPnl: '0',
            });
            return;
          }
          closeQty = ep.qty;
        } catch (err) {
          this.log.warn({ asset, error: (err as Error).message }, 'Failed to verify exchange position size, using tracked qty');
        }
      }

      const exitOrderType = this.config.orderType ?? 'taker';
      let closeResponse: OrderResult;
      try {
        closeResponse = await this.client.placeOrder({
          symbol: position.symbol,
          side: closeSide,
          quantity: closeQty,
          clientOrderId: closeOrderId,
          reduceOnly: true,
          markPrice: exitPrice,
          orderType: exitOrderType,
        });
      } catch (err) {
        this.log.error({ asset, error: (err as Error).message, exchange: this.client.exchange }, 'Failed to place exit order');
        await this.persistence.updateExecution(position.clientOrderId, { status: 'open' });
        return;
      }

      if (closeResponse.status === 'RESTING' && closeResponse.exchangeOrderId) {
        const oid = closeResponse.exchangeOrderId;
        const timeoutMs = this.config.exitMakerTimeoutMs ?? 10000;
        this.log.info({ asset, oid, timeoutMs }, 'Exit ALO resting — waiting for fill');
        const fillResult = await this.client.waitForFill(oid, timeoutMs);
        if (fillResult.status === 'FILLED') {
          closeResponse = { ...closeResponse, status: 'FILLED', filledQty: closeQty };
        } else {
          await this.client.cancelOrder(oid);
          if (this.config.exitFallbackToTaker !== false) {
            this.log.info({ asset, oid }, 'Exit ALO timed out — falling back to IOC taker');
            const takerOrderId = `${closeOrderId}_taker`;
            try {
              closeResponse = await this.client.placeOrder({
                symbol: position.symbol,
                side: closeSide,
                quantity: closeQty,
                clientOrderId: takerOrderId,
                reduceOnly: true,
                markPrice: exitPrice,
                orderType: 'taker',
              });
            } catch (err) {
              this.log.error({ asset, error: (err as Error).message }, 'Taker fallback exit failed');
              await this.persistence.updateExecution(position.clientOrderId, { status: 'open' });
              return;
            }
          } else {
            this.log.warn({ asset, oid }, 'Exit ALO timed out — no taker fallback configured');
            await this.persistence.updateExecution(position.clientOrderId, { status: 'open' });
            return;
          }
        }
      }

      const exitPriceStr = closeResponse.avgPrice !== '0'
        ? closeResponse.avgPrice
        : String(exitPrice);

      const entryMicros = toMicros(position.entryPrice);
      const exitMicros = toMicros(exitPriceStr);
      const qtyMicros = toMicros(position.quantity);
      const priceDiffMicros = direction === 'short'
        ? entryMicros - exitMicros
        : exitMicros - entryMicros;
      const realizedPnlMicros = mulDiv(priceDiffMicros, qtyMicros);
      const realizedPnl = fromMicros(realizedPnlMicros);
      const realizedPnlNum = Number(realizedPnl);

      await this.tracker.closePosition(asset);
      await this.persistence.updateExecution(position.clientOrderId, {
        status: 'closed',
        exitPrice: exitPriceStr,
        exitOrderId: closeOrderId,
        realizedPnl,
        exitReason: exitReason,
      });

      this.log.info({
        asset, direction, exitReason,
        entryPrice: position.entryPrice,
        exitPrice: exitPriceStr,
        realizedPnl,
        pnlBps: pnlBps?.toFixed(1),
        holdTimeMs: Date.now() - position.openedAt,
        mode: this.mode,
      }, 'Perps position closed');

      if (Math.abs(realizedPnlNum) > 1) {
        sendAlert(
          `${realizedPnlNum > 0 ? '✅' : '❌'} *Perps ${direction.toUpperCase()} ${asset}* [${this.mode}]\nPnL: $${realizedPnlNum.toFixed(2)}\nReason: ${exitReason}\nEntry: $${Number(position.entryPrice).toFixed(2)} → Exit: $${Number(exitPriceStr).toFixed(2)}`,
          realizedPnlNum > 0 ? 'info' : 'warn'
        ).catch(() => {});
      }
    } finally {
      this.exitLocks.delete(asset);
    }
  }

  private async onHeartbeat(): Promise<void> {
    await this.killSwitch.check();

    if (!this.config.paperMode) {
      const now = Date.now();
      if (now - this.lastMarginCheckAt > PerpsExecutor.MARGIN_CHECK_INTERVAL_MS) {
        await this.checkMarginHealth();
      }
    }

    const positions = this.tracker.getOpenPositions();
    if (positions.length === 0) return;

    let totalUnrealized = 0;
    for (const pos of positions) {
      totalUnrealized += Number(pos.unrealizedPnl);

      const holdTimeMs = Date.now() - pos.openedAt;
      const maxHoldTimeMs = pos.direction === 'short'
        ? this.config.maxHoldTimeMsShort
        : this.config.maxHoldTimeMsLong;

      if (holdTimeMs > maxHoldTimeMs) {
        this.log.warn({ asset: pos.asset, holdTimeMs, maxHoldTimeMs }, 'Heartbeat time-stop triggered');
        await this.forceClosePosition(pos, 'time_stop');
        continue;
      }

      const entryPrice = Number(pos.entryPrice);
      const markPrice = Number(pos.markPrice);
      if (entryPrice > 0 && markPrice > 0) {
        const rawReturn = (markPrice - entryPrice) / entryPrice;
        const pnlBps = (pos.direction === 'short' ? -rawReturn : rawReturn) * 10000;

        if (pnlBps <= -this.config.heartbeatStopLossBps) {
          this.log.warn({ asset: pos.asset, pnlBps: pnlBps.toFixed(1), stopLossBps: this.config.heartbeatStopLossBps }, 'Heartbeat stop-loss triggered');
          await this.forceClosePosition(pos, 'heartbeat_stop_loss');
          continue;
        }

        pos.peakPnlBps = Math.max(pos.peakPnlBps, pnlBps);
        const { activationPnlBps, trailStopBps } = this.config.trailingStop;
        if (pnlBps >= activationPnlBps) {
          pos.trailingActivated = true;
        }
        if (pos.trailingActivated) {
          const drawdownFromPeak = pos.peakPnlBps - pnlBps;
          if (drawdownFromPeak >= trailStopBps) {
            this.log.info({ asset: pos.asset, pnlBps: pnlBps.toFixed(1), peakBps: pos.peakPnlBps.toFixed(1), drawdown: drawdownFromPeak.toFixed(1) }, 'Trailing stop triggered');
            await this.forceClosePosition(pos, 'trailing_stop');
            continue;
          }
        }
      }

    }

    if (positions.length > 0) {
      this.log.debug({
        openPositions: positions.length,
        totalUnrealizedPnl: totalUnrealized.toFixed(4),
        totalExposureUsd: Number(this.tracker.getTotalExposureUsd()).toFixed(2),
      }, 'Heartbeat');
    }
  }

  private async forceClosePosition(pos: PerpsPosition, reason: string): Promise<void> {
    if (this.exitLocks.has(pos.asset)) return;
    this.exitLocks.add(pos.asset);

    try {
      const claimed = await this.persistence.claimClose(pos.clientOrderId);
      if (!claimed) return;

      const side = closingSide(pos.direction);
      const closeOrderId = `hb_close_${Date.now()}_${pos.asset}_${side}`;

      let closeQty = pos.quantity;
      if (!this.client.isPaperMode()) {
        try {
          const exchangePositions = await this.client.getPositions(pos.symbol);
          const ep = exchangePositions.find(p => p.symbol === pos.symbol);
          if (!ep) {
            this.log.info({ asset: pos.asset }, 'Position already gone from exchange, marking closed');
            await this.tracker.closePosition(pos.asset);
            await this.persistence.updateExecution(pos.clientOrderId, {
              status: 'closed',
              exitReason: reason,
              realizedPnl: '0',
            });
            return;
          }
          closeQty = ep.qty;
        } catch (err) {
          this.log.warn({ asset: pos.asset, error: (err as Error).message }, 'Failed to verify exchange position size, using tracked qty');
        }
      }

      const forceExitOrderType = this.config.orderType ?? 'taker';
      let closeResponse: OrderResult;
      try {
        closeResponse = await this.client.placeOrder({
          symbol: pos.symbol,
          side,
          quantity: closeQty,
          clientOrderId: closeOrderId,
          reduceOnly: true,
          markPrice: Number(pos.markPrice),
          orderType: forceExitOrderType,
        });
      } catch (err) {
        this.log.error({ asset: pos.asset, error: (err as Error).message, exchange: this.client.exchange }, 'Heartbeat force-close failed');
        await this.persistence.updateExecution(pos.clientOrderId, { status: 'open' });
        return;
      }

      if (closeResponse.status === 'RESTING' && closeResponse.exchangeOrderId) {
        const oid = closeResponse.exchangeOrderId;
        const timeoutMs = this.config.exitMakerTimeoutMs ?? 10000;
        this.log.info({ asset: pos.asset, oid, timeoutMs }, 'Force-close ALO resting — waiting for fill');
        const fillResult = await this.client.waitForFill(oid, timeoutMs);
        if (fillResult.status === 'FILLED') {
          closeResponse = { ...closeResponse, status: 'FILLED', filledQty: closeQty };
        } else {
          await this.client.cancelOrder(oid);
          if (this.config.exitFallbackToTaker !== false) {
            this.log.info({ asset: pos.asset, oid }, 'Force-close ALO timed out — falling back to IOC taker');
            const takerOrderId = `${closeOrderId}_taker`;
            try {
              closeResponse = await this.client.placeOrder({
                symbol: pos.symbol,
                side,
                quantity: closeQty,
                clientOrderId: takerOrderId,
                reduceOnly: true,
                markPrice: Number(pos.markPrice),
                orderType: 'taker',
              });
            } catch (err) {
              this.log.error({ asset: pos.asset, error: (err as Error).message }, 'Taker fallback force-close failed');
              await this.persistence.updateExecution(pos.clientOrderId, { status: 'open' });
              return;
            }
          } else {
            await this.persistence.updateExecution(pos.clientOrderId, { status: 'open' });
            return;
          }
        }
      }

      const exitPriceStr = closeResponse.avgPrice !== '0'
        ? closeResponse.avgPrice
        : pos.markPrice;

      const entryMicros = toMicros(pos.entryPrice);
      const exitMicros = toMicros(exitPriceStr);
      const qtyMicros = toMicros(pos.quantity);
      const priceDiffMicros = pos.direction === 'short'
        ? entryMicros - exitMicros
        : exitMicros - entryMicros;
      const realizedPnlMicros = mulDiv(priceDiffMicros, qtyMicros);
      const realizedPnl = fromMicros(realizedPnlMicros);

      await this.tracker.closePosition(pos.asset);
      await this.persistence.updateExecution(pos.clientOrderId, {
        status: 'closed',
        exitPrice: exitPriceStr,
        exitOrderId: closeOrderId,
        realizedPnl,
        exitReason: reason,
      });

      this.log.info({ asset: pos.asset, reason, exitPrice: exitPriceStr, realizedPnl }, 'Heartbeat force-closed position');
    } finally {
      this.exitLocks.delete(pos.asset);
    }
  }

  private async checkMarginHealth(): Promise<void> {
    this.lastMarginCheckAt = Date.now();
    try {
      const account = await this.client.getAccountInfo();
      const wallet = parseFloat(account.walletBalance ?? '0');
      const currentExposure = parseFloat(this.tracker.getTotalExposureUsd());
      const headroom = wallet - (currentExposure / this.config.leverage);

      this.log.info({
        walletBalance: wallet.toFixed(2),
        currentExposure: currentExposure.toFixed(2),
        headroom: headroom.toFixed(2),
      }, 'Margin health check');

      if (headroom < 0) {
        this.log.warn({
          walletBalance: wallet.toFixed(2),
          currentExposure: currentExposure.toFixed(2),
          shortfall: (-headroom).toFixed(2),
        }, 'LOW MARGIN — wallet balance below current exposure requirement');
        sendAlert(
          `⚠️ *Low Margin* [${this.mode}/${this.runId.slice(0, 8)}]\nWallet: $${wallet.toFixed(2)}\nExposure: $${currentExposure.toFixed(2)}\nShortfall: $${(-headroom).toFixed(2)}`,
          'warn'
        ).catch(() => {});
      }
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, 'Failed to check margin health (API key/permissions issue?)');
    }
  }

  updateMarkPrice(asset: string, price: number): void {
    this.tracker.updateMarkPrice(asset, price);
  }

  getPriceCallback(): (quote: { venue: string; pair: string; mid: number }) => void {
    if (!this.priceCallback) {
      this.priceCallback = (quote) => {
        const asset = quote.pair.split('/')[0];
        if (asset && this.tracker.hasPosition(asset)) {
          this.tracker.updateMarkPrice(asset, quote.mid);
        }
      };
    }
    return this.priceCallback;
  }

  getTracker(): PositionTracker {
    return this.tracker;
  }

  getKillSwitch(): KillSwitch {
    return this.killSwitch;
  }

  isRunning(): boolean {
    return this.running;
  }

  getRunId(): string {
    return this.runId;
  }

  getMode(): PerpsMode {
    return this.mode;
  }
}
