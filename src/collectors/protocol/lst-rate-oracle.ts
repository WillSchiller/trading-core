import { EventEmitter } from 'events';
import type { PublicClient, Address } from 'viem';
import { createChildLogger, type Logger } from '../../utils/logger.js';
import type { NormalizedQuote, Chain } from '../../types/index.js';

export interface LstConfig {
  symbol: string;
  address: Address;
  rateMethod: string;
  decimals: number;
  canonical: string; // e.g., "wstETH/WETH"
}

export interface LstRateOracleConfig {
  chain: Chain;
  tokens: LstConfig[];
  pollIntervalMs: number;
}

const LST_RATE_ABI = [
  // wstETH - returns stETH per wstETH (how much stETH you get for 1 wstETH)
  {
    name: 'stEthPerToken',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  // weETH - returns eETH per weETH
  {
    name: 'getRate',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  // rETH - returns ETH per rETH
  {
    name: 'getExchangeRate',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  // cbETH - returns ETH per cbETH
  {
    name: 'exchangeRate',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

export class LstRateOracle extends EventEmitter {
  private logger: Logger;
  private config: LstRateOracleConfig;
  private client: PublicClient;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(config: LstRateOracleConfig, client: PublicClient) {
    super();
    this.config = config;
    this.client = client;
    this.logger = createChildLogger({
      chain: config.chain,
      component: 'lst-rate-oracle',
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    this.logger.info(
      { tokens: this.config.tokens.map((t) => t.symbol), pollIntervalMs: this.config.pollIntervalMs },
      'Starting LST rate oracle'
    );

    await this.fetchAllRates();

    this.pollTimer = setInterval(() => {
      this.fetchAllRates().catch((err) => {
        this.logger.error({ error: (err as Error).message }, 'Failed to fetch LST rates');
      });
    }, this.config.pollIntervalMs);

    this.emit('connected', { venue: 'protocol', chain: this.config.chain });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.logger.info('LST rate oracle stopped');
  }

  private async fetchAllRates(): Promise<void> {
    const startTime = Date.now();

    for (const token of this.config.tokens) {
      try {
        const rate = await this.fetchRate(token);
        if (rate !== null) {
          const quote: NormalizedQuote = {
            ts: new Date(),
            receivedTsMs: Date.now(),
            venue: 'protocol',
            pair: token.canonical,
            chain: this.config.chain,
            mid: rate,
            latencyMs: Date.now() - startTime,
          };
          this.emit('quote', quote);
          this.logger.debug({ symbol: token.symbol, rate, canonical: token.canonical }, 'LST rate fetched');
        }
      } catch (error) {
        this.logger.warn(
          { symbol: token.symbol, error: (error as Error).message },
          'Failed to fetch LST rate'
        );
      }
    }
  }

  private async fetchRate(token: LstConfig): Promise<number | null> {
    const methodAbi = LST_RATE_ABI.find((m) => m.name === token.rateMethod);
    if (!methodAbi) {
      this.logger.error({ symbol: token.symbol, method: token.rateMethod }, 'Unknown rate method');
      return null;
    }

    const result = await this.client.readContract({
      address: token.address,
      abi: [methodAbi],
      functionName: token.rateMethod as 'stEthPerToken' | 'getRate' | 'getExchangeRate' | 'exchangeRate',
    });

    const rawRate = result as bigint;
    const rate = Number(rawRate) / 10 ** token.decimals;
    return rate;
  }
}

// Token configs for Base
export const BASE_LST_TOKENS: LstConfig[] = [
  {
    symbol: 'wstETH',
    address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
    rateMethod: 'stEthPerToken',
    decimals: 18,
    canonical: 'wstETH/WETH',
  },
  {
    symbol: 'weETH',
    address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',
    rateMethod: 'getRate',
    decimals: 18,
    canonical: 'weETH/WETH',
  },
  {
    symbol: 'rETH',
    address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c',
    rateMethod: 'getExchangeRate',
    decimals: 18,
    canonical: 'rETH/WETH',
  },
];

// Token configs for Mainnet
export const MAINNET_LST_TOKENS: LstConfig[] = [
  {
    symbol: 'wstETH',
    address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    rateMethod: 'stEthPerToken',
    decimals: 18,
    canonical: 'wstETH/WETH',
  },
  {
    symbol: 'rETH',
    address: '0xae78736Cd615f374D3085123A210448E74Fc6393',
    rateMethod: 'getExchangeRate',
    decimals: 18,
    canonical: 'rETH/WETH',
  },
  {
    symbol: 'cbETH',
    address: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704',
    rateMethod: 'exchangeRate',
    decimals: 18,
    canonical: 'cbETH/WETH',
  },
];
