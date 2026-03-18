import { createChildLogger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';
import { PolymarketPersistence } from './persistence.js';
import type { PolymarketConfig } from './types.js';

const log = createChildLogger({ component: 'pm-risk' });

export class PolymarketRiskManager {
  private triggered = false;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private pendingExposure = 0;

  constructor(
    private readonly config: PolymarketConfig,
    private readonly persistence: PolymarketPersistence,
  ) {}

  isTriggered(): boolean {
    return this.triggered;
  }

  startPeriodicCheck(): void {
    this.checkTimer = setInterval(
      () => this.checkKillSwitch().catch(e => log.error({ err: e }, 'Kill switch check error')),
      this.config.killSwitchCheckIntervalMs,
    );
  }

  stop(): void {
    if (this.checkTimer) { clearInterval(this.checkTimer); this.checkTimer = null; }
  }

  async canTrade(proposedSizeUsd: number, conditionId: string): Promise<{ allowed: boolean; reason?: string; release?: () => void }> {
    if (this.triggered) {
      return { allowed: false, reason: 'Kill switch triggered' };
    }

    const limits = this.config.riskLimits;

    const [totalExposure, openMarkets, dailyPnl, existingPosition] = await Promise.all([
      this.persistence.getTotalExposure(),
      this.persistence.getOpenMarketsCount(),
      this.persistence.getDailyPnl(),
      this.persistence.getPositionByCondition(conditionId),
    ]);

    const effectiveExposure = totalExposure + this.pendingExposure;
    if (effectiveExposure + proposedSizeUsd > limits.maxTotalExposureUsd) {
      return { allowed: false, reason: `Total exposure ${effectiveExposure.toFixed(0)} + ${proposedSizeUsd.toFixed(0)} exceeds limit ${limits.maxTotalExposureUsd}` };
    }

    const positionNotional = existingPosition ? existingPosition.notional : 0;
    if (positionNotional + proposedSizeUsd > limits.maxPositionUsd) {
      return { allowed: false, reason: `Position notional ${positionNotional.toFixed(0)} + ${proposedSizeUsd.toFixed(0)} exceeds limit ${limits.maxPositionUsd}` };
    }

    const MAX_TRADES_PER_MARKET = 3;
    if (existingPosition && existingPosition.tradeCount >= MAX_TRADES_PER_MARKET) {
      return { allowed: false, reason: `Market has ${existingPosition.tradeCount} trades, max ${MAX_TRADES_PER_MARKET} (anti-martingale)` };
    }

    if (!existingPosition && openMarkets >= limits.maxMarketsOpen) {
      return { allowed: false, reason: `Open markets ${openMarkets} at limit ${limits.maxMarketsOpen}` };
    }

    if (dailyPnl < -limits.dailyLossLimitUsd) {
      return { allowed: false, reason: `Daily PnL ${dailyPnl.toFixed(2)} exceeds loss limit -${limits.dailyLossLimitUsd}` };
    }

    this.pendingExposure += proposedSizeUsd;
    const release = () => { this.pendingExposure = Math.max(0, this.pendingExposure - proposedSizeUsd); };

    return { allowed: true, release };
  }

  async checkKillSwitch(): Promise<void> {
    if (this.triggered) return;

    const [dailyPnl, totalExposure, openMarkets] = await Promise.all([
      this.persistence.getDailyPnl(),
      this.persistence.getTotalExposure(),
      this.persistence.getOpenMarketsCount(),
    ]);

    const limits = this.config.riskLimits;

    if (dailyPnl < -limits.dailyLossLimitUsd) {
      const reason = `Daily PnL ${dailyPnl.toFixed(2)} hit loss limit -${limits.dailyLossLimitUsd}`;
      await this.trigger(reason, dailyPnl, totalExposure, openMarkets);
    }
  }

  private async trigger(reason: string, dailyPnl: number, totalExposure: number, positionsOpen: number): Promise<void> {
    this.triggered = true;
    log.error({ reason, dailyPnl, totalExposure, positionsOpen }, 'POLYMARKET KILL SWITCH TRIGGERED');

    await this.persistence.saveKillSwitchEvent({ reason, dailyPnl, totalExposure, positionsOpen });

    sendAlert(
      `🚨 *PM KILL SWITCH*\n\nReason: ${reason}\nDaily PnL: $${dailyPnl.toFixed(2)}\nExposure: $${totalExposure.toFixed(2)}\nPositions: ${positionsOpen}`,
      'critical',
    ).catch(err => log.error({ error: (err as Error).message }, 'Failed to send kill switch alert'));
  }

  reset(): void {
    this.triggered = false;
    log.info('Kill switch reset');
  }
}
