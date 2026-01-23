import { EventEmitter } from 'events';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { ChainProvider } from './provider.js';
import type { Chain } from '../types/index.js';

export interface BlockWatcherConfig {
  chain: Chain;
  pollIntervalMs?: number;
  blockCacheSize?: number;
}

export interface BlockInfo {
  blockNumber: bigint;
  timestamp: number;
}

export class BlockWatcher extends EventEmitter {
  private logger: Logger;
  private config: Required<BlockWatcherConfig>;
  private provider: ChainProvider;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastBlock: bigint = 0n;
  private isRunning = false;
  private blockTimestampCache: Map<string, number> = new Map();

  constructor(config: BlockWatcherConfig, provider: ChainProvider) {
    super();
    this.config = {
      ...config,
      pollIntervalMs: config.pollIntervalMs ?? 2000,
      blockCacheSize: config.blockCacheSize ?? 100,
    };
    this.provider = provider;
    this.logger = createChildLogger({ chain: config.chain, component: 'block-watcher' });
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Block watcher already running');
      return;
    }

    this.isRunning = true;
    this.logger.info({ pollIntervalMs: this.config.pollIntervalMs }, 'Starting block watcher');

    try {
      const blockInfo = await this.fetchBlockWithTimestamp(await this.provider.getCurrentBlock());
      this.lastBlock = blockInfo.blockNumber;
      this.logger.info(
        {
          blockNumber: blockInfo.blockNumber.toString(),
          timestamp: blockInfo.timestamp,
        },
        'Initial block retrieved'
      );
      this.emit('block', blockInfo);
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Failed to get initial block');
    }

    this.poll();
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping block watcher');
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public getLastBlock(): bigint {
    return this.lastBlock;
  }

  public getBlockTimestamp(blockNumber: bigint): number | undefined {
    return this.blockTimestampCache.get(blockNumber.toString());
  }

  public async fetchBlockWithTimestamp(blockNumber: bigint): Promise<BlockInfo> {
    const cached = this.blockTimestampCache.get(blockNumber.toString());
    if (cached !== undefined) {
      return { blockNumber, timestamp: cached };
    }

    try {
      const block = await this.provider.getPublicClient().getBlock({ blockNumber });
      const timestamp = Number(block.timestamp) * 1000;

      this.cacheBlockTimestamp(blockNumber, timestamp);

      return { blockNumber, timestamp };
    } catch (error) {
      this.logger.error(
        {
          error: (error as Error).message,
          blockNumber: blockNumber.toString(),
        },
        'Failed to fetch block'
      );
      return { blockNumber, timestamp: Date.now() };
    }
  }

  private cacheBlockTimestamp(blockNumber: bigint, timestamp: number): void {
    const key = blockNumber.toString();
    this.blockTimestampCache.set(key, timestamp);

    if (this.blockTimestampCache.size > this.config.blockCacheSize) {
      const firstKey = this.blockTimestampCache.keys().next().value;
      if (firstKey) {
        this.blockTimestampCache.delete(firstKey);
      }
    }
  }

  private poll(): void {
    if (!this.isRunning) return;

    this.pollTimer = setTimeout(async () => {
      try {
        const currentBlock = await this.provider.getCurrentBlock();

        if (currentBlock > this.lastBlock) {
          const blockDiff = currentBlock - this.lastBlock;

          const blockInfo = await this.fetchBlockWithTimestamp(currentBlock);

          this.logger.debug(
            {
              blockNumber: blockInfo.blockNumber.toString(),
              diff: blockDiff.toString(),
              timestamp: blockInfo.timestamp,
            },
            'New block detected'
          );

          this.lastBlock = currentBlock;
          this.emit('block', blockInfo);
        }
      } catch (error) {
        this.logger.error({ error: (error as Error).message }, 'Failed to poll block number');
      }

      this.poll();
    }, this.config.pollIntervalMs);
  }
}
