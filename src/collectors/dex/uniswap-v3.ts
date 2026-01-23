import { EventEmitter } from 'events';
import type { Address } from 'viem';
import { createChildLogger, type Logger } from '../../utils/logger.js';
import type { ChainProvider } from '../../chain/provider.js';
import type { BlockWatcher } from '../../chain/block-watcher.js';
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
}

export class UniswapV3Connector extends EventEmitter {
  private logger: Logger;
  private config: UniswapV3ConnectorConfig;
  private provider: ChainProvider;
  private blockWatcher: BlockWatcher;
  private isRunning = false;

  constructor(config: UniswapV3ConnectorConfig, provider: ChainProvider, blockWatcher: BlockWatcher) {
    super();
    this.config = config;
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
    this.logger.info({ poolCount: this.config.pools.length }, 'Starting Uniswap V3 connector');

    this.blockWatcher.on('block', (blockInfo: { blockNumber: bigint; timestamp: number }) => this.handleNewBlock(blockInfo.blockNumber));

    this.emit('connected', { venue: 'uniswap_v3', chain: this.config.chain });
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Uniswap V3 connector');
    this.isRunning = false;
    this.blockWatcher.removeAllListeners('block');
  }

  private async handleNewBlock(blockNumber: bigint): Promise<void> {
    if (!this.isRunning) return;

    this.logger.debug({ blockNumber: blockNumber.toString() }, 'Processing new block');

    const promises = this.config.pools.map((pool) =>
      this.fetchPoolQuote(pool, blockNumber).catch((error) => {
        this.logger.error(
          {
            pool: pool.address,
            canonical: pool.canonical,
            error: error.message,
          },
          'Failed to fetch pool quote'
        );
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
