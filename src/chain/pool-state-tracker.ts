import type { Address } from 'viem';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';

export interface PoolState {
  poolAddress: Address;
  lastBlock: bigint;
  lastSqrtPriceX96: bigint | null;
  dirty: boolean;
  lastEventBlock: bigint | null;
  lastFetchBlock: bigint | null;
  totalEvents: number;
  totalFetches: number;
  savedFetches: number;
}

export interface PoolStateTrackerConfig {
  chain: Chain;
  initialPools: Address[];
}

export class PoolStateTracker {
  private logger: Logger;
  private poolStates: Map<Address, PoolState> = new Map();
  private globalLastBlock: bigint = 0n;

  constructor(config: PoolStateTrackerConfig) {
    this.logger = createChildLogger({
      chain: config.chain,
      component: 'pool-state-tracker',
    });

    for (const poolAddress of config.initialPools) {
      this.initializePool(poolAddress);
    }

    this.logger.info(
      { poolCount: config.initialPools.length },
      'Pool state tracker initialized'
    );
  }

  private initializePool(poolAddress: Address): void {
    const normalized = poolAddress.toLowerCase() as Address;
    this.poolStates.set(normalized, {
      poolAddress: normalized,
      lastBlock: 0n,
      lastSqrtPriceX96: null,
      dirty: true,
      lastEventBlock: null,
      lastFetchBlock: null,
      totalEvents: 0,
      totalFetches: 0,
      savedFetches: 0,
    });
  }

  public markDirty(poolAddress: Address, blockNumber: bigint): void {
    const normalized = poolAddress.toLowerCase() as Address;
    let state = this.poolStates.get(normalized);

    if (!state) {
      this.initializePool(normalized);
      state = this.poolStates.get(normalized)!;
    }

    state.dirty = true;
    state.lastEventBlock = blockNumber;
    state.totalEvents++;

    this.logger.debug(
      {
        pool: normalized,
        blockNumber: blockNumber.toString(),
        totalEvents: state.totalEvents,
      },
      'Pool marked dirty'
    );
  }

  public markClean(
    poolAddress: Address,
    blockNumber: bigint,
    sqrtPriceX96: bigint
  ): void {
    const normalized = poolAddress.toLowerCase() as Address;
    const state = this.poolStates.get(normalized);

    if (!state) {
      this.logger.warn({ pool: normalized }, 'Attempted to mark unknown pool clean');
      return;
    }

    state.dirty = false;
    state.lastBlock = blockNumber;
    state.lastFetchBlock = blockNumber;
    state.lastSqrtPriceX96 = sqrtPriceX96;
    state.totalFetches++;

    this.logger.debug(
      {
        pool: normalized,
        blockNumber: blockNumber.toString(),
        sqrtPriceX96: sqrtPriceX96.toString(),
        totalFetches: state.totalFetches,
      },
      'Pool marked clean'
    );
  }

  public isDirty(poolAddress: Address): boolean {
    const normalized = poolAddress.toLowerCase() as Address;
    const state = this.poolStates.get(normalized);
    return state?.dirty ?? true;
  }

  public getPoolState(poolAddress: Address): PoolState | undefined {
    const normalized = poolAddress.toLowerCase() as Address;
    return this.poolStates.get(normalized);
  }

  public getAllStates(): Map<Address, PoolState> {
    return new Map(this.poolStates);
  }

  public updateGlobalBlock(blockNumber: bigint): void {
    if (blockNumber > this.globalLastBlock) {
      this.globalLastBlock = blockNumber;
    }
  }

  public getGlobalLastBlock(): bigint {
    return this.globalLastBlock;
  }

  public getDirtyPools(): Address[] {
    const dirty: Address[] = [];
    for (const [address, state] of this.poolStates.entries()) {
      if (state.dirty) {
        dirty.push(address);
      }
    }
    return dirty;
  }

  public getCleanPools(): Address[] {
    const clean: Address[] = [];
    for (const [address, state] of this.poolStates.entries()) {
      if (!state.dirty) {
        clean.push(address);
      }
    }
    return clean;
  }

  public calculateSavedFetches(): number {
    let totalSaved = 0;
    for (const state of this.poolStates.values()) {
      state.savedFetches = state.totalEvents - state.totalFetches;
      totalSaved += state.savedFetches;
    }
    return totalSaved;
  }

  public getStats(): {
    totalPools: number;
    dirtyPools: number;
    cleanPools: number;
    totalEvents: number;
    totalFetches: number;
    totalSavedFetches: number;
    savingsRate: number;
  } {
    let totalEvents = 0;
    let totalFetches = 0;
    let dirtyCount = 0;

    for (const state of this.poolStates.values()) {
      totalEvents += state.totalEvents;
      totalFetches += state.totalFetches;
      if (state.dirty) dirtyCount++;
    }

    const totalSavedFetches = this.calculateSavedFetches();
    const savingsRate = totalEvents > 0 ? (totalSavedFetches / totalEvents) * 100 : 0;

    return {
      totalPools: this.poolStates.size,
      dirtyPools: dirtyCount,
      cleanPools: this.poolStates.size - dirtyCount,
      totalEvents,
      totalFetches,
      totalSavedFetches,
      savingsRate,
    };
  }

  public logStats(): void {
    const stats = this.getStats();
    this.logger.info(
      {
        totalPools: stats.totalPools,
        dirtyPools: stats.dirtyPools,
        cleanPools: stats.cleanPools,
        totalEvents: stats.totalEvents,
        totalFetches: stats.totalFetches,
        savedFetches: stats.totalSavedFetches,
        savingsRate: `${stats.savingsRate.toFixed(1)}%`,
      },
      'Pool state tracker stats'
    );
  }

  public resetStats(): void {
    for (const state of this.poolStates.values()) {
      state.totalEvents = 0;
      state.totalFetches = 0;
      state.savedFetches = 0;
    }
    this.logger.info('Pool state tracker stats reset');
  }
}
