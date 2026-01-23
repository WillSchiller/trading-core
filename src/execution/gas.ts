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
}

const ETH_USD_FALLBACK = 3000;

export class GasEstimator {
  private logger: Logger;
  private publicClient: PublicClient;
  private config: GasEstimatorConfig;
  private ethUsdPrice: number;

  constructor(publicClient: PublicClient, config: GasEstimatorConfig) {
    this.logger = createChildLogger({ component: 'gas-estimator', chain: config.chain });
    this.publicClient = publicClient;
    this.config = config;
    this.ethUsdPrice = ETH_USD_FALLBACK;
  }

  setEthUsdPrice(price: number): void {
    this.ethUsdPrice = price;
    this.logger.debug({ ethUsdPrice: price }, 'ETH/USD price updated');
  }

  async estimateSwapGas(gasLimitEstimate: bigint): Promise<GasEstimate> {
    const feeData = await this.publicClient.estimateFeesPerGas();

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
    const feeData = await this.publicClient.estimateFeesPerGas();

    const maxFeePerGas = feeData.maxFeePerGas ?? 0n;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1000000000n;
    const gasPriceGwei = Number(maxFeePerGas) / 1e9;

    return { maxFeePerGas, maxPriorityFeePerGas, gasPriceGwei };
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
