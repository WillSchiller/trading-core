import { createChildLogger } from '../../utils/logger.js';
import { sendAlert } from '../../utils/alerts.js';
import { toMicros, fromMicros, formatUsd, configToMicros, mulDiv } from './money.js';
import { BinanceFuturesClient } from './binance-client.js';
import { PerpsPersistence } from './perps-persistence.js';
import { PositionTracker } from './position-tracker.js';
import { closingSide } from './types.js';
import type { KillSwitchConfig, PerpsPosition } from './types.js';

const log = createChildLogger({ component: 'kill-switch' });

export class KillSwitch {
  private triggered = false;
  private lastDailyReset = this.getUtcMidnight();
  private failedCloses: PerpsPosition[] = [];

  constructor(
    private readonly config: KillSwitchConfig,
    private readonly client: BinanceFuturesClient,
    private readonly persistence: PerpsPersistence,
    private readonly tracker: PositionTracker,
  ) {}

  isTriggered(): boolean {
    return this.triggered;
  }

  async check(): Promise<{ safe: boolean; reason?: string }> {
    if (this.failedCloses.length > 0) {
      await this.retryFailedCloses();
    }

    if (this.triggered) return { safe: false, reason: 'Kill switch already triggered' };

    this.checkDailyReset();

    const [dailyPnlMicros, totalPnlMicros, consecutiveLosses] = await Promise.all([
      this.persistence.getDailyPnlMicros(),
      this.persistence.getTotalPnlMicros(),
      this.persistence.getConsecutiveLosses(),
    ]);

    const dailyLimitMicros = configToMicros(this.config.dailyDrawdownLimitUsd);
    const totalLimitMicros = configToMicros(this.config.maxTotalLossUsd);

    if (dailyPnlMicros <= -dailyLimitMicros) {
      const reason = `Daily drawdown limit hit: $${formatUsd(dailyPnlMicros)} (limit: -$${this.config.dailyDrawdownLimitUsd})`;
      await this.trigger(reason, dailyPnlMicros, totalPnlMicros, consecutiveLosses);
      return { safe: false, reason };
    }

    if (totalPnlMicros <= -totalLimitMicros) {
      const reason = `Total loss cap hit: $${formatUsd(totalPnlMicros)} (limit: -$${this.config.maxTotalLossUsd})`;
      await this.trigger(reason, dailyPnlMicros, totalPnlMicros, consecutiveLosses);
      return { safe: false, reason };
    }

    if (consecutiveLosses >= this.config.maxConsecutiveLosses) {
      const reason = `Consecutive losses: ${consecutiveLosses} (limit: ${this.config.maxConsecutiveLosses})`;
      await this.trigger(reason, dailyPnlMicros, totalPnlMicros, consecutiveLosses);
      return { safe: false, reason };
    }

    return { safe: true };
  }

  private async trigger(reason: string, dailyPnlMicros: bigint, totalPnlMicros: bigint, consecutiveLosses: number): Promise<void> {
    this.triggered = true;
    log.error({ reason, dailyPnl: fromMicros(dailyPnlMicros), totalPnl: fromMicros(totalPnlMicros), consecutiveLosses }, 'KILL SWITCH TRIGGERED');

    const closedCount = await this.closeAllPositions();

    await this.persistence.saveKillSwitchEvent({
      reason,
      dailyPnl: fromMicros(dailyPnlMicros),
      totalPnl: fromMicros(totalPnlMicros),
      consecutiveLosses,
      positionsClosedCount: closedCount,
    });

    const failedList = this.failedCloses.map(p => p.asset).join(', ');
    sendAlert(
      `🚨 *KILL SWITCH TRIGGERED*\n\nReason: ${reason}\nDaily PnL: $${formatUsd(dailyPnlMicros)}\nTotal PnL: $${formatUsd(totalPnlMicros)}\nPositions closed: ${closedCount}${this.failedCloses.length > 0 ? `\n⚠️ Failed to close: ${failedList}` : ''}`,
      'critical'
    ).catch(err => log.error({ error: (err as Error).message }, 'Failed to send kill switch alert'));
  }

  async closeAllPositions(): Promise<number> {
    const positions = this.tracker.getOpenPositions();
    let closed = 0;
    for (const pos of positions) {
      const success = await this.closeOnePosition(pos);
      if (success) {
        closed++;
      } else {
        this.failedCloses.push(pos);
      }
    }
    return closed;
  }

  private async closeOnePosition(pos: PerpsPosition): Promise<boolean> {
    try {
      const side = closingSide(pos.direction);
      const closeOrderId = `ks_${Date.now()}_${pos.asset}_${side}`;
      const closeResponse = await this.client.placeOrder({
        symbol: pos.symbol,
        side,
        quantity: pos.quantity,
        clientOrderId: closeOrderId,
        reduceOnly: true,
      });

      const exitPriceStr = closeResponse.avgPrice !== '0'
        ? closeResponse.avgPrice
        : String(pos.markPrice);

      const entryMicros = toMicros(String(pos.entryPrice));
      const exitMicros = toMicros(exitPriceStr);
      const qtyMicros = toMicros(String(pos.quantity));
      const priceDiffMicros = pos.direction === 'short'
        ? entryMicros - exitMicros
        : exitMicros - entryMicros;
      const realizedPnlMicros = mulDiv(priceDiffMicros, qtyMicros);

      await this.tracker.closePosition(pos.asset);
      await this.persistence.updateExecution(pos.clientOrderId, {
        status: 'closed',
        exitReason: 'kill_switch',
        exitOrderId: closeOrderId,
        exitPrice: exitPriceStr,
        realizedPnl: fromMicros(realizedPnlMicros),
      });
      log.info({ asset: pos.asset, symbol: pos.symbol, exitPrice: exitPriceStr, realizedPnl: fromMicros(realizedPnlMicros) }, 'Kill switch closed position');
      return true;
    } catch (err) {
      log.error({ asset: pos.asset, error: (err as Error).message }, 'Failed to close position during kill switch');
      return false;
    }
  }

  private async retryFailedCloses(): Promise<void> {
    const stillFailed: PerpsPosition[] = [];
    for (const pos of this.failedCloses) {
      if (!this.tracker.hasPosition(pos.asset)) continue;
      const freshPos = this.tracker.getPosition(pos.asset);
      if (!freshPos) continue;

      const success = await this.closeOnePosition(freshPos);
      if (!success) {
        stillFailed.push(freshPos);
      }
    }

    if (stillFailed.length > 0 && stillFailed.length < this.failedCloses.length) {
      log.info({ remaining: stillFailed.length }, 'Some failed closes succeeded on retry');
    }
    if (stillFailed.length > 0) {
      log.error({ assets: stillFailed.map(p => p.asset) }, 'Kill switch still has unclosed positions');
    }
    this.failedCloses = stillFailed;
  }

  reset(): void {
    this.triggered = false;
    this.failedCloses = [];
    log.info('Kill switch reset');
  }

  private checkDailyReset(): void {
    const now = this.getUtcMidnight();
    if (now > this.lastDailyReset) {
      this.lastDailyReset = now;
      if (this.triggered) {
        log.info('Daily reset: kill switch remains triggered (requires manual reset for total loss / consecutive)');
      }
    }
  }

  private getUtcMidnight(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
}
