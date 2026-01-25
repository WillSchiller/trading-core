import { EventEmitter } from 'events';
import type { Address, Log } from 'viem';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { ChainProvider } from './provider.js';
import type { Chain } from '../types/index.js';

export interface PoolEventConfig {
  chain: Chain;
  poolAddresses: Address[];
}

export interface PoolEvent {
  poolAddress: Address;
  blockNumber: bigint;
  eventType: 'Swap' | 'Mint' | 'Burn' | 'Flash';
  timestamp: number;
}

const UNISWAP_V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const UNISWAP_V3_MINT_TOPIC = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';
const UNISWAP_V3_BURN_TOPIC = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c';
const UNISWAP_V3_FLASH_TOPIC = '0xbdbdb71d7860376ba52b25a5028beea23581364a40522f6bcfb86bb1f2dca633';

const AERODROME_SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const AERODROME_MINT_TOPIC = '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f';
const AERODROME_BURN_TOPIC = '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496';

const RELEVANT_TOPICS = [
  UNISWAP_V3_SWAP_TOPIC,
  UNISWAP_V3_MINT_TOPIC,
  UNISWAP_V3_BURN_TOPIC,
  UNISWAP_V3_FLASH_TOPIC,
  AERODROME_SWAP_TOPIC,
  AERODROME_MINT_TOPIC,
  AERODROME_BURN_TOPIC,
];

export class PoolEventWatcher extends EventEmitter {
  private logger: Logger;
  private config: PoolEventConfig;
  private provider: ChainProvider;
  private isRunning = false;
  private wsUnsubscribe: (() => void) | null = null;
  private fallbackPollTimer: NodeJS.Timeout | null = null;
  private lastProcessedBlock: bigint = 0n;
  private eventCounts: Map<Address, number> = new Map();

  constructor(config: PoolEventConfig, provider: ChainProvider) {
    super();
    this.config = config;
    this.provider = provider;
    this.logger = createChildLogger({
      chain: config.chain,
      component: 'pool-event-watcher',
    });
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Pool event watcher already running');
      return;
    }

    this.isRunning = true;
    this.logger.info(
      {
        poolCount: this.config.poolAddresses.length,
        pools: this.config.poolAddresses,
      },
      'Starting pool event watcher'
    );

    // Always use HTTP polling - WebSocket subscriptions are unreliable
    this.logger.info('Using HTTP polling for pool events');
    this.startPollingFallback();
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping pool event watcher');
    this.isRunning = false;

    if (this.wsUnsubscribe) {
      this.wsUnsubscribe();
      this.wsUnsubscribe = null;
      this.logger.info('WebSocket log subscription unsubscribed');
    }

    if (this.fallbackPollTimer) {
      clearTimeout(this.fallbackPollTimer);
      this.fallbackPollTimer = null;
    }
  }

  public getEventCounts(): Map<Address, number> {
    return new Map(this.eventCounts);
  }

  public resetEventCounts(): void {
    this.eventCounts.clear();
  }

  private startPollingFallback(): void {
    if (!this.isRunning) return;

    this.fallbackPollTimer = setTimeout(async () => {
      try {
        await this.pollRecentLogs();
      } catch (error) {
        this.logger.error({ error: (error as Error).message }, 'Failed to poll logs');
      }

      this.startPollingFallback();
    }, 2000);
  }

  private async pollRecentLogs(): Promise<void> {
    const client = this.provider.getPublicClient();
    const currentBlock = await client.getBlockNumber();

    if (this.lastProcessedBlock === 0n) {
      this.lastProcessedBlock = currentBlock - 1n;
    }

    if (currentBlock <= this.lastProcessedBlock) {
      return;
    }

    const logs = await client.getLogs({
      address: this.config.poolAddresses,
      fromBlock: this.lastProcessedBlock + 1n,
      toBlock: currentBlock,
    });

    await this.handleLogs(logs);
    this.lastProcessedBlock = currentBlock;
  }

  private async handleLogs(logs: Log[]): Promise<void> {
    const relevantLogs = logs.filter(
      (log) =>
        log.topics[0] &&
        RELEVANT_TOPICS.includes(log.topics[0].toLowerCase())
    );

    if (relevantLogs.length === 0) {
      return;
    }

    const blockTimestamps = new Map<bigint, number>();
    const client = this.provider.getPublicClient();

    for (const log of relevantLogs) {
      if (!log.address || !log.blockNumber) continue;

      let timestamp = blockTimestamps.get(log.blockNumber);
      if (timestamp === undefined) {
        try {
          const block = await client.getBlock({ blockNumber: log.blockNumber });
          timestamp = Number(block.timestamp) * 1000;
          blockTimestamps.set(log.blockNumber, timestamp);
        } catch (error) {
          this.logger.error(
            {
              error: (error as Error).message,
              blockNumber: log.blockNumber.toString(),
            },
            'Failed to fetch block timestamp'
          );
          timestamp = Date.now();
        }
      }

      const eventType = this.getEventType(log.topics[0]!);
      const poolAddress = log.address.toLowerCase() as Address;

      const currentCount = this.eventCounts.get(poolAddress) ?? 0;
      this.eventCounts.set(poolAddress, currentCount + 1);

      const event: PoolEvent = {
        poolAddress,
        blockNumber: log.blockNumber,
        eventType,
        timestamp,
      };

      this.logger.info(
        {
          pool: poolAddress,
          eventType,
          blockNumber: log.blockNumber.toString(),
          totalEvents: currentCount + 1,
        },
        'Pool event detected'
      );

      this.emit('pool-event', event);
    }

    this.logger.info(
      {
        totalLogs: logs.length,
        relevantLogs: relevantLogs.length,
        pools: Array.from(new Set(relevantLogs.map((l) => l.address))),
      },
      'Processed pool events'
    );
  }

  private getEventType(topic: string): 'Swap' | 'Mint' | 'Burn' | 'Flash' {
    const topicLower = topic.toLowerCase();
    if (topicLower === UNISWAP_V3_SWAP_TOPIC || topicLower === AERODROME_SWAP_TOPIC) {
      return 'Swap';
    }
    if (topicLower === UNISWAP_V3_MINT_TOPIC || topicLower === AERODROME_MINT_TOPIC) {
      return 'Mint';
    }
    if (topicLower === UNISWAP_V3_BURN_TOPIC || topicLower === AERODROME_BURN_TOPIC) {
      return 'Burn';
    }
    if (topicLower === UNISWAP_V3_FLASH_TOPIC) {
      return 'Flash';
    }
    return 'Swap';
  }
}
