import { Mutex } from 'async-mutex';
import { Decimal } from 'decimal.js';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';

export interface InventoryConfig {
  initialBalances: Record<string, number>;
  trackingEnabled: boolean;
}

export interface InventoryState {
  balances: Map<string, number>;
  totalTradesExecuted: number;
  totalTradesSkipped: number;
  skippedByInsufficientFunds: number;
}

export class InventoryManager {
  private logger: Logger;
  private balances: Map<string, number>;
  private initialBalances: Map<string, number>;
  private trackingEnabled: boolean;
  private totalTradesExecuted: number = 0;
  private totalTradesSkipped: number = 0;
  private skippedByInsufficientFunds: number = 0;
  private readonly mutex: Mutex;
  private static readonly MUTEX_WARN_THRESHOLD_MS = 200;

  constructor(chain: Chain, config: InventoryConfig) {
    this.logger = createChildLogger({ component: 'inventory', chain });
    this.trackingEnabled = config.trackingEnabled;
    this.mutex = new Mutex();

    this.balances = new Map();
    this.initialBalances = new Map();

    for (const [token, amount] of Object.entries(config.initialBalances)) {
      const normalizedToken = token.toUpperCase();
      this.balances.set(normalizedToken, amount);
      this.initialBalances.set(normalizedToken, amount);
    }

    this.logger.info(
      {
        trackingEnabled: this.trackingEnabled,
        balances: Object.fromEntries(this.balances),
      },
      'Inventory manager initialized'
    );
  }

  hasEnoughBalance(token: string, amount: number): boolean {
    if (!this.trackingEnabled) {
      return true;
    }

    const normalizedToken = token.toUpperCase();
    const balance = this.balances.get(normalizedToken) ?? 0;
    return balance >= amount;
  }

  getBalance(token: string): number {
    const normalizedToken = token.toUpperCase();
    return this.balances.get(normalizedToken) ?? 0;
  }

  private getBalanceUnsafe(token: string): number {
    return this.balances.get(token) ?? 0;
  }

  deductBalance(token: string, amount: number): boolean {
    if (!this.trackingEnabled) {
      return true;
    }

    const normalizedToken = token.toUpperCase();
    const current = this.balances.get(normalizedToken) ?? 0;

    if (current < amount) {
      this.logger.warn(
        {
          token: normalizedToken,
          required: amount,
          available: current,
        },
        'Insufficient balance for deduction'
      );
      return false;
    }

    const newBalance = new Decimal(current).minus(amount).toNumber();
    this.balances.set(normalizedToken, newBalance);
    return true;
  }

  private deductBalanceUnsafe(token: string, amount: number): void {
    const current = this.balances.get(token) ?? 0;
    const newBalance = new Decimal(current).minus(amount).toNumber();
    this.balances.set(token, newBalance);
  }

  addBalance(token: string, amount: number): void {
    if (!this.trackingEnabled) {
      return;
    }

    const normalizedToken = token.toUpperCase();
    const current = this.balances.get(normalizedToken) ?? 0;
    const newBalance = new Decimal(current).plus(amount).toNumber();
    this.balances.set(normalizedToken, newBalance);
  }

  private addBalanceUnsafe(token: string, amount: number): void {
    const current = this.balances.get(token) ?? 0;
    const newBalance = new Decimal(current).plus(amount).toNumber();
    this.balances.set(token, newBalance);
  }

  private async runWithMutexTiming<T>(operation: string, fn: () => T): Promise<T> {
    const startTime = Date.now();
    return this.mutex.runExclusive(() => {
      const waitMs = Date.now() - startTime;
      if (waitMs > InventoryManager.MUTEX_WARN_THRESHOLD_MS) {
        this.logger.warn(
          { component: 'InventoryManager', operation, waitMs, threshold: InventoryManager.MUTEX_WARN_THRESHOLD_MS },
          'Mutex wait exceeded threshold'
        );
      } else {
        this.logger.debug({ component: 'InventoryManager', operation, waitMs }, 'Mutex acquired');
      }
      return fn();
    });
  }

  async executeTrade(
    tokenIn: string,
    amountIn: number,
    tokenOut: string,
    amountOut: number
  ): Promise<{ success: boolean; reason?: string }> {
    return this.runWithMutexTiming('executeTrade', () => {
      if (!this.trackingEnabled) {
        this.totalTradesExecuted++;
        return { success: true };
      }

      const normalizedIn = tokenIn.toUpperCase();
      const normalizedOut = tokenOut.toUpperCase();
      const currentBalance = this.getBalanceUnsafe(normalizedIn);

      if (currentBalance < amountIn) {
        this.totalTradesSkipped++;
        this.skippedByInsufficientFunds++;

        this.logger.info(
          {
            tokenIn: normalizedIn,
            required: amountIn,
            available: currentBalance,
            tokenOut: normalizedOut,
            amountOut,
          },
          'Trade skipped - insufficient balance'
        );

        return {
          success: false,
          reason: `Insufficient ${normalizedIn}: need ${amountIn.toFixed(4)}, have ${currentBalance.toFixed(4)}`,
        };
      }

      this.deductBalanceUnsafe(normalizedIn, amountIn);
      this.addBalanceUnsafe(normalizedOut, amountOut);
      this.totalTradesExecuted++;

      this.logger.info(
        {
          tokenIn: normalizedIn,
          amountIn,
          tokenOut: normalizedOut,
          amountOut,
          newBalanceIn: this.getBalanceUnsafe(normalizedIn),
          newBalanceOut: this.getBalanceUnsafe(normalizedOut),
        },
        'Trade executed - inventory updated'
      );

      return { success: true };
    });
  }

  async getState(): Promise<InventoryState> {
    return this.runWithMutexTiming('getState', () => ({
      balances: new Map(this.balances),
      totalTradesExecuted: this.totalTradesExecuted,
      totalTradesSkipped: this.totalTradesSkipped,
      skippedByInsufficientFunds: this.skippedByInsufficientFunds,
    }));
  }

  async getBalanceSummary(): Promise<Record<string, { initial: number; current: number; change: number }>> {
    return this.runWithMutexTiming('getBalanceSummary', () => {
      const summary: Record<string, { initial: number; current: number; change: number }> = {};

      for (const [token, current] of this.balances) {
        const initial = this.initialBalances.get(token) ?? 0;
        const change = new Decimal(current).minus(initial).toNumber();
        summary[token] = {
          initial,
          current,
          change,
        };
      }

      return summary;
    });
  }

  async reset(): Promise<void> {
    await this.runWithMutexTiming('reset', () => {
      this.balances = new Map(this.initialBalances);
      this.totalTradesExecuted = 0;
      this.totalTradesSkipped = 0;
      this.skippedByInsufficientFunds = 0;
    });

    this.logger.info(
      { balances: Object.fromEntries(this.balances) },
      'Inventory reset to initial balances'
    );
  }

  isTrackingEnabled(): boolean {
    return this.trackingEnabled;
  }
}
