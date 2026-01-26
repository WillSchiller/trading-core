import type { PublicClient } from 'viem';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';

export interface GasEstimate {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFeePerGas: bigint;
  gasLimit: bigint;
  estimatedGasWei: bigint;
  estimatedGasGwei: number;
  estimatedGasUsd: number;
}

export interface GasEstimatorConfig {
  chain: Chain;
  gasBufferPercent: number;
  maxGasGwei: number;
  gasCacheTtlMs?: number;
}

const ETH_USD_FALLBACK = 3000;
const DEFAULT_GAS_CACHE_TTL_MS = 10000;
const DEFAULT_ETH_PRICE_STALENESS_MS = 60000;

interface CachedGasPrice {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasPriceGwei: number;
  timestamp: number;
}

interface EthPriceState {
  price: number;
  updatedAt: number;
  source: 'live' | 'fallback';
}

export class GasEstimator {
  private logger: Logger;
  private publicClient: PublicClient;
  private config: Required<GasEstimatorConfig>;
  private ethPriceState: EthPriceState;
  private ethPriceStalenessTtlMs: number;
  private cachedGasPrice: CachedGasPrice | null = null;

  constructor(publicClient: PublicClient, config: GasEstimatorConfig) {
    this.logger = createChildLogger({ component: 'gas-estimator', chain: config.chain });
    this.publicClient = publicClient;
    this.config = {
      ...config,
      gasCacheTtlMs: config.gasCacheTtlMs ?? DEFAULT_GAS_CACHE_TTL_MS,
    };
    this.ethPriceStalenessTtlMs = DEFAULT_ETH_PRICE_STALENESS_MS;
    this.ethPriceState = {
      price: ETH_USD_FALLBACK,
      updatedAt: 0,
      source: 'fallback',
    };
    this.logger.warn(
      { fallbackPrice: ETH_USD_FALLBACK },
      'Using fallback ETH/USD price - call setEthUsdPrice() with live data'
    );
  }

  setEthUsdPrice(price: number): void {
    this.ethPriceState = {
      price,
      updatedAt: Date.now(),
      source: 'live',
    };
    this.logger.debug({ ethUsdPrice: price }, 'ETH/USD price updated');
  }

  setEthPriceStalenessTtl(ttlMs: number): void {
    this.ethPriceStalenessTtlMs = ttlMs;
  }

  getEthPriceState(): { price: number; isStale: boolean; ageMs: number; source: 'live' | 'fallback' } {
    const now = Date.now();
    const ageMs = now - this.ethPriceState.updatedAt;
    const isStale = this.ethPriceState.source === 'fallback' || ageMs > this.ethPriceStalenessTtlMs;
    return {
      price: this.ethPriceState.price,
      isStale,
      ageMs,
      source: this.ethPriceState.source,
    };
  }

  private get ethUsdPrice(): number {
    const state = this.getEthPriceState();
    if (state.isStale) {
      this.logger.warn(
        {
          price: state.price,
          ageMs: state.ageMs,
          source: state.source,
          staleTtlMs: this.ethPriceStalenessTtlMs,
        },
        'ETH/USD price is stale'
      );
    }
    return state.price;
  }

  async estimateSwapGas(gasLimitEstimate: bigint): Promise<GasEstimate> {
    const feeData = await this.publicClient.estimateFeesPerGas();
    return this.estimateSwapGasWithFeeData(gasLimitEstimate, feeData);
  }

  estimateSwapGasWithFeeData(
    gasLimitEstimate: bigint,
    feeData: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }
  ): GasEstimate {
    const baseFeePerGas = feeData.maxFeePerGas ?? 0n;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1000000000n;

    const maxFeePerGas = baseFeePerGas + maxPriorityFeePerGas;

    const gasLimitWithBuffer = this.applyBuffer(gasLimitEstimate);

    const estimatedGasWei = maxFeePerGas * gasLimitWithBuffer;

    const estimatedGasGwei = Number(maxFeePerGas) / 1e9;
    const estimatedGasEth = Number(estimatedGasWei) / 1e18;
    const estimatedGasUsd = estimatedGasEth * this.ethUsdPrice;

    const estimate: GasEstimate = {
      maxFeePerGas,
      maxPriorityFeePerGas,
      baseFeePerGas,
      gasLimit: gasLimitWithBuffer,
      estimatedGasWei,
      estimatedGasGwei,
      estimatedGasUsd,
    };

    this.logger.debug(
      {
        baseFeeGwei: Number(baseFeePerGas) / 1e9,
        maxFeeGwei: estimatedGasGwei,
        priorityFeeGwei: Number(maxPriorityFeePerGas) / 1e9,
        gasLimit: gasLimitWithBuffer.toString(),
        estimatedGasUsd,
      },
      'Gas estimated'
    );

    return estimate;
  }

  async getCurrentGasPrice(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasPriceGwei: number }> {
    const now = Date.now();

    if (this.cachedGasPrice && (now - this.cachedGasPrice.timestamp) < this.config.gasCacheTtlMs) {
      this.logger.debug(
        {
          cacheAgeMs: now - this.cachedGasPrice.timestamp,
          gasPriceGwei: this.cachedGasPrice.gasPriceGwei,
        },
        'Using cached gas price'
      );
      return {
        maxFeePerGas: this.cachedGasPrice.maxFeePerGas,
        maxPriorityFeePerGas: this.cachedGasPrice.maxPriorityFeePerGas,
        gasPriceGwei: this.cachedGasPrice.gasPriceGwei,
      };
    }

    const feeData = await this.publicClient.estimateFeesPerGas();

    const maxFeePerGas = feeData.maxFeePerGas ?? 0n;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1000000000n;
    const gasPriceGwei = Number(maxFeePerGas) / 1e9;

    this.cachedGasPrice = {
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasPriceGwei,
      timestamp: now,
    };

    this.logger.debug({ gasPriceGwei }, 'Gas price fetched and cached');

    return { maxFeePerGas, maxPriorityFeePerGas, gasPriceGwei };
  }

  async fetchFeeData(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
    return this.publicClient.estimateFeesPerGas();
  }

  invalidateGasCache(): void {
    this.cachedGasPrice = null;
    this.logger.debug('Gas price cache invalidated');
  }

  isGasPriceAcceptable(gasPriceGwei: number): boolean {
    const acceptable = gasPriceGwei <= this.config.maxGasGwei;
    if (!acceptable) {
      this.logger.warn(
        { gasPriceGwei, maxGasGwei: this.config.maxGasGwei },
        'Gas price exceeds maximum'
      );
    }
    return acceptable;
  }

  isProfitable(estimatedProfitUsd: number, estimatedGasUsd: number): boolean {
    const profitable = estimatedProfitUsd > estimatedGasUsd;
    this.logger.debug(
      { estimatedProfitUsd, estimatedGasUsd, profitable },
      'Profitability check'
    );
    return profitable;
  }

  private applyBuffer(gasLimit: bigint): bigint {
    const buffer = (gasLimit * BigInt(this.config.gasBufferPercent)) / 100n;
    return gasLimit + buffer;
  }

  calculateGasUsd(gasUsed: bigint, gasPriceWei: bigint): number {
    const gasWei = gasUsed * gasPriceWei;
    const gasEth = Number(gasWei) / 1e18;
    return gasEth * this.ethUsdPrice;
  }
}
