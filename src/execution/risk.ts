import { createChildLogger, type Logger } from '../utils/logger.js';
import { alertSystemHalt, alertConsecutiveReverts } from '../utils/alerts.js';
import type { Chain } from '../types/index.js';
import type { RiskConfig } from '../config/types.js';

const MIN_PROFIT_ABOVE_GAS_USD = 0.50;

export interface RiskState {
  chain: Chain;
  openExposureUsd: number;
  tradesLastHour: number;
  lastTradeAt: Date | null;
  cooldownUntil: Date | null;
  isHalted: boolean;
  haltReason: string | null;
  consecutiveReverts: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface TradeParams {
  tradeSizeUsd: number;
  gasPriceGwei: number;
  estimatedProfitUsd: number;
  estimatedGasUsd: number;
}

export class RiskManager {
  private logger: Logger;
  private config: RiskConfig;
  private state: RiskState;
  private tradeTimestamps: Date[];

  constructor(chain: Chain, config: RiskConfig) {
    this.logger = createChildLogger({ component: 'risk-manager', chain });
    this.config = config;
    this.state = {
      chain,
      openExposureUsd: 0,
      tradesLastHour: 0,
      lastTradeAt: null,
      cooldownUntil: null,
      isHalted: false,
      haltReason: null,
      consecutiveReverts: 0,
    };
    this.tradeTimestamps = [];
  }

  checkTradeAllowed(params: TradeParams): RiskCheckResult {
    if (this.state.isHalted) {
      return { allowed: false, reason: `System halted: ${this.state.haltReason}` };
    }

    const cooldownCheck = this.checkCooldown();
    if (!cooldownCheck.allowed) {
      return cooldownCheck;
    }

    const tradeSizeCheck = this.checkTradeSize(params.tradeSizeUsd);
    if (!tradeSizeCheck.allowed) {
      return tradeSizeCheck;
    }

    const exposureCheck = this.checkExposure(params.tradeSizeUsd);
    if (!exposureCheck.allowed) {
      return exposureCheck;
    }

    const rateCheck = this.checkTradeRate();
    if (!rateCheck.allowed) {
      return rateCheck;
    }

    const gasCheck = this.checkGasPrice(params.gasPriceGwei);
    if (!gasCheck.allowed) {
      return gasCheck;
    }

    const profitCheck = this.checkProfitability(params.estimatedProfitUsd, params.estimatedGasUsd);
    if (!profitCheck.allowed) {
      return profitCheck;
    }

    return { allowed: true };
  }

  private checkCooldown(): RiskCheckResult {
    if (!this.state.cooldownUntil) {
      return { allowed: true };
    }

    const now = new Date();
    if (now < this.state.cooldownUntil) {
      const remainingMs = this.state.cooldownUntil.getTime() - now.getTime();
      return {
        allowed: false,
        reason: `Cooldown active, ${Math.ceil(remainingMs / 1000)}s remaining`,
      };
    }

    this.state.cooldownUntil = null;
    return { allowed: true };
  }

  private checkTradeSize(tradeSizeUsd: number): RiskCheckResult {
    if (tradeSizeUsd > this.config.maxTradeSizeUsd) {
      return {
        allowed: false,
        reason: `Trade size $${tradeSizeUsd.toFixed(2)} exceeds max $${this.config.maxTradeSizeUsd}`,
      };
    }
    return { allowed: true };
  }

  private checkExposure(tradeSizeUsd: number): RiskCheckResult {
    const projectedExposure = this.state.openExposureUsd + tradeSizeUsd;
    if (projectedExposure > this.config.maxOpenExposureUsd) {
      return {
        allowed: false,
        reason: `Projected exposure $${projectedExposure.toFixed(2)} exceeds max $${this.config.maxOpenExposureUsd}`,
      };
    }
    return { allowed: true };
  }

  private checkTradeRate(): RiskCheckResult {
    this.pruneOldTrades();

    if (this.tradeTimestamps.length >= this.config.maxTradesPerHour) {
      return {
        allowed: false,
        reason: `Rate limit: ${this.tradeTimestamps.length}/${this.config.maxTradesPerHour} trades in last hour`,
      };
    }
    return { allowed: true };
  }

  private checkGasPrice(gasPriceGwei: number): RiskCheckResult {
    if (gasPriceGwei > this.config.maxGasGwei) {
      return {
        allowed: false,
        reason: `Gas price ${gasPriceGwei.toFixed(2)} gwei exceeds max ${this.config.maxGasGwei}`,
      };
    }
    return { allowed: true };
  }

  private checkProfitability(estimatedProfitUsd: number, estimatedGasUsd: number): RiskCheckResult {
    if (this.config.skipProfitCheckForTesting) {
      this.logger.debug({ estimatedProfitUsd, estimatedGasUsd }, 'Profit check skipped for testing');
      return { allowed: true };
    }

    const minRequiredProfit = estimatedGasUsd + MIN_PROFIT_ABOVE_GAS_USD;

    if (estimatedProfitUsd < minRequiredProfit) {
      return {
        allowed: false,
        reason: `Unprofitable: profit $${estimatedProfitUsd.toFixed(4)} < min required $${minRequiredProfit.toFixed(4)} (gas $${estimatedGasUsd.toFixed(4)} + $${MIN_PROFIT_ABOVE_GAS_USD})`,
      };
    }
    return { allowed: true };
  }

  recordTradeSubmitted(tradeSizeUsd: number): void {
    const now = new Date();
    this.tradeTimestamps.push(now);
    this.state.lastTradeAt = now;
    this.state.openExposureUsd += tradeSizeUsd;
    this.state.tradesLastHour = this.tradeTimestamps.length;

    this.logger.info(
      {
        tradeSizeUsd,
        openExposureUsd: this.state.openExposureUsd,
        tradesLastHour: this.state.tradesLastHour,
      },
      'Trade submitted'
    );
  }

  recordTradeCompleted(tradeSizeUsd: number, success: boolean): void {
    this.state.openExposureUsd = Math.max(0, this.state.openExposureUsd - tradeSizeUsd);

    if (success) {
      this.state.consecutiveReverts = 0;
    } else {
      this.state.consecutiveReverts++;
      this.logger.warn(
        { consecutiveReverts: this.state.consecutiveReverts },
        'Trade reverted'
      );

      alertConsecutiveReverts(this.state.chain, this.state.consecutiveReverts).catch(() => {});

      if (this.state.consecutiveReverts >= this.config.haltOnConsecutiveReverts) {
        this.halt(`${this.state.consecutiveReverts} consecutive reverts`);
      }
    }

    this.startCooldown();

    this.logger.info(
      {
        tradeSizeUsd,
        success,
        openExposureUsd: this.state.openExposureUsd,
        consecutiveReverts: this.state.consecutiveReverts,
      },
      'Trade completed'
    );
  }

  halt(reason: string): void {
    this.state.isHalted = true;
    this.state.haltReason = reason;
    this.logger.error({ reason }, 'System halted');
    alertSystemHalt(reason).catch(() => {});
  }

  resume(): void {
    this.state.isHalted = false;
    this.state.haltReason = null;
    this.state.consecutiveReverts = 0;
    this.logger.info('System resumed');
  }

  getState(): RiskState {
    this.pruneOldTrades();
    return { ...this.state, tradesLastHour: this.tradeTimestamps.length };
  }

  isHalted(): boolean {
    return this.state.isHalted;
  }

  private startCooldown(): void {
    const cooldownUntil = new Date(Date.now() + this.config.cooldownSeconds * 1000);
    this.state.cooldownUntil = cooldownUntil;
    this.logger.debug(
      { cooldownSeconds: this.config.cooldownSeconds },
      'Cooldown started'
    );
  }

  private pruneOldTrades(): void {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    this.tradeTimestamps = this.tradeTimestamps.filter((ts) => ts > oneHourAgo);
  }
}
