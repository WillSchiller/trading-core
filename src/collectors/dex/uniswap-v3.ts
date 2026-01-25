import { EventEmitter } from 'events';
import type { Address } from 'viem';
import { createChildLogger, type Logger } from '../../utils/logger.js';
import type { ChainProvider } from '../../chain/provider.js';
import type { BlockWatcher } from '../../chain/block-watcher.js';
import { PoolEventWatcher, type PoolEvent } from '../../chain/pool-event-watcher.js';
import { PoolStateTracker } from '../../chain/pool-state-tracker.js';
import { UNISWAP_V3_POOL_ABI, ERC20_ABI } from '../../chain/contracts.js';
import type { NormalizedQuote, Chain } from '../../types/index.js';

export interface PoolConfig {
  address: Address;
  token0: Address;
  token1: Address;
  token0Decimals: number;
  token1Decimals: number;
  token0Symbol: string;
  token1Symbol: string;
  feeTier: number;
  canonical: string;
  invertPrice: boolean;
}

export interface UniswapV3ConnectorConfig {
  chain: Chain;
  pools: PoolConfig[];
  useEventDriven?: boolean;
  statsIntervalMs?: number;
  adaptivePolling?: boolean;
  baseThresholdBps?: number; // Used to calculate polling frequency
}

export class UniswapV3Connector extends EventEmitter {
  private logger: Logger;
  private config: Required<UniswapV3ConnectorConfig>;
  private provider: ChainProvider;
  private blockWatcher: BlockWatcher;
  private poolEventWatcher: PoolEventWatcher | null = null;
  private poolStateTracker: PoolStateTracker | null = null;
  private isRunning = false;
  private statsTimer: NodeJS.Timeout | null = null;
  private lastPollBlock: bigint = 0n;
  private currentPollInterval: number = 10; // Start conservative, adaptive will adjust
  private spreadProximity: number = 0; // 0 = far from threshold, 1 = at threshold

  constructor(config: UniswapV3ConnectorConfig, provider: ChainProvider, blockWatcher: BlockWatcher) {
    super();
    this.config = {
      ...config,
      useEventDriven: config.useEventDriven ?? false,
      statsIntervalMs: config.statsIntervalMs ?? 60000,
      adaptivePolling: config.adaptivePolling ?? true,
      baseThresholdBps: config.baseThresholdBps ?? 15, // Default 15 bps threshold
    };
    this.provider = provider;
    this.blockWatcher = blockWatcher;
    this.logger = createChildLogger({
      chain: config.chain,
      component: 'uniswap-v3-connector',
    });
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Uniswap V3 connector already running');
      return;
    }

    this.isRunning = true;
    this.logger.info(
      {
        poolCount: this.config.pools.length,
        eventDriven: this.config.useEventDriven,
      },
      'Starting Uniswap V3 connector'
    );

    if (this.config.useEventDriven) {
      await this.startEventDrivenMode();
    } else {
      this.startPollingMode();
    }

    if (this.config.useEventDriven && this.poolStateTracker) {
      this.statsTimer = setInterval(() => {
        this.poolStateTracker!.logStats();
      }, this.config.statsIntervalMs);
    }

    this.emit('connected', { venue: 'uniswap_v3', chain: this.config.chain });
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Uniswap V3 connector');
    this.isRunning = false;

    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    if (this.poolEventWatcher) {
      await this.poolEventWatcher.stop();
      this.poolEventWatcher.removeAllListeners();
      this.poolEventWatcher = null;
    }

    if (this.poolStateTracker && this.config.useEventDriven) {
      this.poolStateTracker.logStats();
    }

    this.poolStateTracker = null;
    this.blockWatcher.removeAllListeners('block');
  }

  private async startEventDrivenMode(): Promise<void> {
    const poolAddresses = this.config.pools.map((p) => p.address);

    this.poolStateTracker = new PoolStateTracker({
      chain: this.config.chain,
      initialPools: poolAddresses,
    });

    this.poolEventWatcher = new PoolEventWatcher(
      {
        chain: this.config.chain,
        poolAddresses,
      },
      this.provider
    );

    this.poolEventWatcher.on('pool-event', (event: PoolEvent) => {
      this.poolStateTracker!.markDirty(event.poolAddress, event.blockNumber);
    });

    await this.poolEventWatcher.start();

    this.blockWatcher.on('block', (blockInfo: { blockNumber: bigint; timestamp: number }) =>
      this.handleNewBlockEventDriven(blockInfo.blockNumber)
    );

    this.logger.info('Event-driven mode activated');

    // Do initial fetch for all pools since we may have missed the first block event
    const currentBlock = this.blockWatcher.getLastBlock();
    if (currentBlock > 0n) {
      this.logger.info({ blockNumber: currentBlock.toString() }, 'Performing initial pool fetch');
      await this.handleNewBlockEventDriven(currentBlock);
    }
  }

  private startPollingMode(): void {
    this.logger.info({ listenerCount: this.blockWatcher.listenerCount('block') }, 'Registering block listener');

    this.blockWatcher.on('block', (blockInfo: { blockNumber: bigint; timestamp: number }) => {
      this.logger.info({ blockNumber: blockInfo.blockNumber.toString(), timestamp: blockInfo.timestamp }, 'Block event received in Uniswap connector');
      this.handleNewBlockPolling(blockInfo.blockNumber);
    });

    this.logger.info({ listenerCount: this.blockWatcher.listenerCount('block') }, 'Polling mode activated (legacy)');
  }

  private async handleNewBlockEventDriven(blockNumber: bigint): Promise<void> {
    if (!this.isRunning || !this.poolStateTracker) return;

    this.poolStateTracker.updateGlobalBlock(blockNumber);

    const dirtyPools = this.poolStateTracker.getDirtyPools();
    const cleanPools = this.poolStateTracker.getCleanPools();

    this.logger.debug(
      {
        blockNumber: blockNumber.toString(),
        dirtyPools: dirtyPools.length,
        cleanPools: cleanPools.length,
        totalPools: this.config.pools.length,
      },
      'Processing block (event-driven)'
    );

    if (dirtyPools.length === 0) {
      this.logger.debug(
        { blockNumber: blockNumber.toString() },
        'No dirty pools, skipping RPC calls'
      );
      return;
    }

    const poolConfigMap = new Map(this.config.pools.map((p) => [p.address.toLowerCase(), p]));
    const promises = dirtyPools.map((poolAddress) => {
      const pool = poolConfigMap.get(poolAddress.toLowerCase());
      if (!pool) {
        this.logger.warn({ pool: poolAddress }, 'Pool config not found for dirty pool');
        return Promise.resolve(null);
      }

      return this.fetchPoolQuote(pool, blockNumber).catch((error) => {
        this.logger.error(
          {
            pool: pool.address,
            canonical: pool.canonical,
            error: error.message,
          },
          'Failed to fetch pool quote'
        );
        return null;
      });
    });

    const quotes = await Promise.all(promises);

    for (const quote of quotes) {
      if (quote) {
        this.emit('quote', quote);
      }
    }
  }

  private async handleNewBlockPolling(blockNumber: bigint): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn({ blockNumber: blockNumber.toString() }, 'Received block but connector not running');
      return;
    }

    // Adaptive polling: skip blocks based on spread proximity
    if (this.config.adaptivePolling && this.lastPollBlock > 0n) {
      const blocksSinceLastPoll = blockNumber - this.lastPollBlock;
      if (blocksSinceLastPoll < BigInt(this.currentPollInterval)) {
        this.logger.debug(
          { blockNumber: blockNumber.toString(), blocksSinceLastPoll: blocksSinceLastPoll.toString(), currentPollInterval: this.currentPollInterval },
          'Skipping block due to adaptive polling'
        );
        return; // Skip this block
      }
    }

    this.lastPollBlock = blockNumber;
    this.logger.info(
      { blockNumber: blockNumber.toString(), pollInterval: this.currentPollInterval },
      'Processing block (polling)'
    );

    try {
      const quotes = await this.fetchAllPoolsMulticall(blockNumber);
      for (const quote of quotes) {
        if (quote) {
          this.emit('quote', quote);
        }
      }
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Multicall failed, falling back to individual calls');
      const promises = this.config.pools.map((pool) =>
        this.fetchPoolQuote(pool, blockNumber).catch((err) => {
          this.logger.error({ pool: pool.address, error: err.message }, 'Failed to fetch pool quote');
          return null;
        })
      );
      const quotes = await Promise.all(promises);
      for (const quote of quotes) {
        if (quote) {
          this.emit('quote', quote);
        }
      }
    }
  }

  // Called by opportunity detector to update spread proximity
  public updateSpreadProximity(spreadBps: number, thresholdBps: number): void {
    // Calculate proximity: 0 = no spread, 1 = at threshold
    this.spreadProximity = thresholdBps > 0 ? Math.min(1, spreadBps / thresholdBps) : 0;

    const oldInterval = this.currentPollInterval;

    // Adaptive polling intervals based on spread proximity to threshold
    if (this.spreadProximity < 0.3) {
      this.currentPollInterval = 10; // Far: every 10 blocks (~20 sec)
    } else if (this.spreadProximity < 0.5) {
      this.currentPollInterval = 5; // Medium: every 5 blocks (~10 sec)
    } else if (this.spreadProximity < 0.7) {
      this.currentPollInterval = 3; // Getting close: every 3 blocks (~6 sec)
    } else if (this.spreadProximity < 0.9) {
      this.currentPollInterval = 2; // Close: every 2 blocks (~4 sec)
    } else {
      this.currentPollInterval = 1; // Very close/above: every block
    }

    if (oldInterval !== this.currentPollInterval) {
      this.logger.info(
        {
          spreadBps: spreadBps.toFixed(1),
          thresholdBps,
          proximity: (this.spreadProximity * 100).toFixed(0) + '%',
          pollInterval: this.currentPollInterval,
        },
        'Adjusted poll interval'
      );
    }
  }

  private async fetchAllPoolsMulticall(blockNumber: bigint): Promise<(NormalizedQuote | null)[]> {
    const startTime = Date.now();
    const client = this.provider.getPublicClient();

    const slot0Calls = this.config.pools.map((pool) => ({
      address: pool.address,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: 'slot0' as const,
    }));

    const liquidityCalls = this.config.pools.map((pool) => ({
      address: pool.address,
      abi: UNISWAP_V3_POOL_ABI,
      functionName: 'liquidity' as const,
    }));

    const results = await client.multicall({
      contracts: [...slot0Calls, ...liquidityCalls],
      allowFailure: true,
    });

    const slot0Results = results.slice(0, this.config.pools.length);
    const liquidityResults = results.slice(this.config.pools.length);
    const latencyMs = Date.now() - startTime;

    const quotes: (NormalizedQuote | null)[] = [];

    for (let i = 0; i < this.config.pools.length; i++) {
      const pool = this.config.pools[i];
      const slot0Result = slot0Results[i];
      const liquidityResult = liquidityResults[i];

      if (slot0Result.status === 'failure' || liquidityResult.status === 'failure') {
        this.logger.warn({ pool: pool.address, canonical: pool.canonical }, 'Multicall failed for pool');
        quotes.push(null);
        continue;
      }

      const slot0 = slot0Result.result as readonly [bigint, number, number, number, number, number, boolean];
      const sqrtPriceX96 = slot0[0];
      const liquidity = liquidityResult.result as bigint;

      const price = this.sqrtPriceX96ToPrice(
        sqrtPriceX96,
        pool.token0Decimals,
        pool.token1Decimals,
        pool.invertPrice
      );

      quotes.push({
        ts: new Date(),
        receivedTsMs: Date.now(),
        venue: 'uniswap_v3',
        pair: pool.canonical,
        chain: this.config.chain,
        mid: price,
        blockNumber,
        sqrtPriceX96,
        liquidity,
        latencyMs,
      });
    }

    this.logger.debug(
      { blockNumber: blockNumber.toString(), poolCount: this.config.pools.length, latencyMs },
      'Multicall fetched all pools'
    );

    return quotes;
  }

  private async fetchPoolQuote(pool: PoolConfig, blockNumber: bigint): Promise<NormalizedQuote | null> {
    const startTime = Date.now();

    try {
      const client = this.provider.getPublicClient();

      const [slot0Result, liquidityResult] = await Promise.all([
        client.readContract({
          address: pool.address,
          abi: UNISWAP_V3_POOL_ABI,
          functionName: 'slot0',
        }),
        client.readContract({
          address: pool.address,
          abi: UNISWAP_V3_POOL_ABI,
          functionName: 'liquidity',
        }),
      ]);

      const sqrtPriceX96 = slot0Result[0];
      const liquidity = liquidityResult;

      if (this.poolStateTracker && this.config.useEventDriven) {
        this.poolStateTracker.markClean(pool.address, blockNumber, sqrtPriceX96);
      }

      const price = this.sqrtPriceX96ToPrice(
        sqrtPriceX96,
        pool.token0Decimals,
        pool.token1Decimals,
        pool.invertPrice
      );

      const latencyMs = Date.now() - startTime;

      return {
        ts: new Date(),
        receivedTsMs: Date.now(),
        venue: 'uniswap_v3',
        pair: pool.canonical,
        chain: this.config.chain,
        mid: price,
        blockNumber,
        sqrtPriceX96,
        liquidity,
        latencyMs,
      };
    } catch (error) {
      this.logger.error(
        {
          pool: pool.address,
          canonical: pool.canonical,
          error: (error as Error).message,
        },
        'Failed to fetch slot0'
      );
      return null;
    }
  }

  private sqrtPriceX96ToPrice(
    sqrtPriceX96: bigint,
    token0Decimals: number,
    token1Decimals: number,
    invertPrice: boolean
  ): number {
    // sqrtPriceX96 = sqrt(token1/token0) * 2^96
    // price = (sqrtPriceX96 / 2^96)^2 = token1/token0 (in raw units)
    //
    // To avoid precision loss with large BigInts, we use a different approach:
    // price = sqrtPriceX96^2 / 2^192
    //
    // We shift the calculation to maintain precision:
    // Multiply by 10^18 for precision, then divide at the end

    const PRECISION = 10n ** 18n;
    const Q192 = 2n ** 192n;

    // Calculate price with high precision using BigInt
    // priceRaw = sqrtPriceX96^2 * PRECISION / Q192
    const sqrtSquared = sqrtPriceX96 * sqrtPriceX96;
    const priceRawScaled = (sqrtSquared * PRECISION) / Q192;

    // Convert to number (now safe since we've reduced the magnitude)
    let price = Number(priceRawScaled) / Number(PRECISION);

    // Adjust for token decimals
    // price_raw is token1/token0 in raw units
    // price_human = price_raw * 10^(token0Decimals - token1Decimals)
    const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
    price = price * decimalAdjustment;

    // Invert if canonical pair has base token as token1
    if (invertPrice) {
      price = 1 / price;
    }

    return price;
  }

  public getOptimizationStats(): {
    enabled: boolean;
    stats?: {
      totalPools: number;
      dirtyPools: number;
      cleanPools: number;
      totalEvents: number;
      totalFetches: number;
      totalSavedFetches: number;
      savingsRate: number;
    };
  } {
    if (!this.config.useEventDriven || !this.poolStateTracker) {
      return { enabled: false };
    }

    return {
      enabled: true,
      stats: this.poolStateTracker.getStats(),
    };
  }

  public static async initializePool(
    poolAddress: Address,
    provider: ChainProvider,
    feeTier: number,
    canonical: string
  ): Promise<PoolConfig> {
    const client = provider.getPublicClient();

    const [token0Address, token1Address] = await Promise.all([
      client.readContract({
        address: poolAddress,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: 'token0',
      }),
      client.readContract({
        address: poolAddress,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: 'token1',
      }),
    ]);

    const [token0Decimals, token1Decimals, token0Symbol, token1Symbol] = await Promise.all([
      client.readContract({
        address: token0Address,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
      client.readContract({
        address: token1Address,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
      client.readContract({
        address: token0Address,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }),
      client.readContract({
        address: token1Address,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }),
    ]);

    // Determine if we need to invert the price
    // canonical format is "BASE/QUOTE" (e.g., "WETH/USDC" means price in USDC per WETH)
    // sqrtPriceX96 gives token1/token0 price
    // If base token is token0, we want token1/token0 (no inversion)
    // If base token is token1, we want token0/token1 (invert)
    const [baseSymbol] = canonical.split('/');
    const normalizedBase = baseSymbol === 'ETH' ? 'WETH' : baseSymbol;
    const normalizedToken0 = token0Symbol === 'ETH' ? 'WETH' : token0Symbol;

    // Invert if the base token of the canonical pair is token1 (not token0)
    const invertPrice = normalizedBase !== normalizedToken0;

    return {
      address: poolAddress,
      token0: token0Address,
      token1: token1Address,
      token0Decimals: Number(token0Decimals),
      token1Decimals: Number(token1Decimals),
      token0Symbol,
      token1Symbol,
      feeTier,
      canonical,
      invertPrice,
    };
  }
}
