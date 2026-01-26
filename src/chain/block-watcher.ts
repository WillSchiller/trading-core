import { EventEmitter } from 'events';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { ChainProvider } from './provider.js';
import type { Chain } from '../types/index.js';

export interface BlockWatcherConfig {
  chain: Chain;
  pollIntervalMs?: number;
  blockCacheSize?: number;
  useWebSocket?: boolean;
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
  private wsUnsubscribe: (() => void) | null = null;
  private lastBlockTime: number = 0;
  private wsWatchdogTimer: NodeJS.Timeout | null = null;

  constructor(config: BlockWatcherConfig, provider: ChainProvider) {
    super();
    this.config = {
      ...config,
      pollIntervalMs: config.pollIntervalMs ?? 2000,
      blockCacheSize: config.blockCacheSize ?? 100,
      useWebSocket: config.useWebSocket ?? true,
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

    try {
      const blockInfo = await this.fetchBlockWithTimestamp(await this.provider.getCurrentBlock());
      this.lastBlock = blockInfo.blockNumber;
      this.lastBlockTime = Date.now();
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

    if (this.config.useWebSocket) {
      const wsClient = this.provider.getWsPublicClient();
      if (wsClient) {
        this.logger.info('Starting WebSocket block subscription');
        try {
          this.wsUnsubscribe = wsClient.watchBlocks({
            onBlock: async (block) => {
              try {
                await this.handleNewBlock(block.number, Number(block.timestamp) * 1000);
              } catch (error) {
                this.logger.error(
                  { error: (error as Error).message, blockNumber: block.number.toString() },
                  'Error handling block in WebSocket callback'
                );
              }
            },
            onError: (error) => {
              this.logger.error({ error: error.message }, 'WebSocket block subscription error');
              this.logger.warn('Falling back to HTTP polling');
              this.wsUnsubscribe = null;
              if (this.wsWatchdogTimer) {
                clearInterval(this.wsWatchdogTimer);
                this.wsWatchdogTimer = null;
              }
              this.poll();
            },
          });
          this.logger.info('WebSocket block subscription active');
          this.startWsWatchdog();
          return;
        } catch (error) {
          this.logger.warn(
            { error: (error as Error).message },
            'Failed to start WebSocket subscription, using HTTP polling'
          );
        }
      } else {
        this.logger.info('No WebSocket client available, using HTTP polling');
      }
    } else {
      this.logger.info({ pollIntervalMs: this.config.pollIntervalMs }, 'Starting HTTP polling mode');
    }

    this.poll();
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping block watcher');
    this.isRunning = false;

    if (this.wsWatchdogTimer) {
      clearInterval(this.wsWatchdogTimer);
      this.wsWatchdogTimer = null;
    }

    if (this.wsUnsubscribe) {
      this.wsUnsubscribe();
      this.wsUnsubscribe = null;
      this.logger.info('WebSocket subscription unsubscribed');
    }

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

  private async handleNewBlock(blockNumber: bigint, timestamp: number): Promise<void> {
    if (blockNumber <= this.lastBlock) {
      return;
    }

    const blockDiff = blockNumber - this.lastBlock;
    this.cacheBlockTimestamp(blockNumber, timestamp);
    this.lastBlockTime = Date.now();

    this.logger.info(
      {
        blockNumber: blockNumber.toString(),
        diff: blockDiff.toString(),
        timestamp,
      },
      'New block detected'
    );

    this.lastBlock = blockNumber;
    this.emit('block', { blockNumber, timestamp });
  }

  private startWsWatchdog(): void {
    const watchdogIntervalMs = 10000; // Check every 10 seconds
    const maxBlockAgeMs = 15000; // If no block for 15 seconds, fall back to polling

    this.wsWatchdogTimer = setInterval(() => {
      const timeSinceLastBlock = Date.now() - this.lastBlockTime;
      if (this.lastBlockTime > 0 && timeSinceLastBlock > maxBlockAgeMs) {
        this.logger.warn(
          { timeSinceLastBlock, maxBlockAgeMs },
          'WebSocket not receiving blocks, falling back to HTTP polling'
        );
        if (this.wsUnsubscribe && typeof this.wsUnsubscribe === 'function') {
          try {
            this.wsUnsubscribe();
          } catch (e) {
            this.logger.warn({ error: (e as Error).message }, 'Error unsubscribing WebSocket');
          }
        }
        this.wsUnsubscribe = null;
        if (this.wsWatchdogTimer) {
          clearInterval(this.wsWatchdogTimer);
          this.wsWatchdogTimer = null;
        }
        this.poll();
      }
    }, watchdogIntervalMs);
  }

  private poll(): void {
    if (!this.isRunning) return;

    this.pollTimer = setTimeout(async () => {
      try {
        const currentBlock = await this.provider.getCurrentBlock();

        if (currentBlock > this.lastBlock) {
          const blockInfo = await this.fetchBlockWithTimestamp(currentBlock);
          await this.handleNewBlock(blockInfo.blockNumber, blockInfo.timestamp);
        }
      } catch (error) {
        this.logger.error({ error: (error as Error).message }, 'Failed to poll block number');
      }

      this.poll();
    }, this.config.pollIntervalMs);
  }
}
