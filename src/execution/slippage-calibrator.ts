import type { PublicClient, Address } from 'viem';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';
import { getPool } from '../persistence/client.js';

const QUOTER_V2_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'quoteExactInputSingle',
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export interface CalibrationConfig {
  chain: Chain;
  quoterAddress: Address;
  pools: Array<{
    address: Address;
    feeTierBps: number;
    token0: Address;
    token1: Address;
    token0Decimals: number;
    token1Decimals: number;
    token0Symbol: string;
    token1Symbol: string;
  }>;
  notionalSizes: number[];
  edgeBufferBps: number;
  gasUsd: number;
}

export interface SlippagePoint {
  poolAddress: string;
  chain: Chain;
  feeTierBps: number;
  direction: 'buy' | 'sell';
  notionalUsd: number;
  slippageBps: number;
  breakEvenBps: number;
  gasBps: number;
  recommendedMinSpreadBps: number;
  quoteAmountIn: bigint;
  quoteAmountOut: bigint;
  midPrice: number;
}

export class SlippageCalibrator {
  private logger: Logger;
  private config: CalibrationConfig;
  private publicClient: PublicClient;
  private intervalId?: NodeJS.Timeout;

  constructor(config: CalibrationConfig, publicClient: PublicClient) {
    this.config = config;
    this.publicClient = publicClient;
    this.logger = createChildLogger({ component: 'slippage-calibrator', chain: config.chain });
  }

  async calibrateAll(): Promise<SlippagePoint[]> {
    const results: SlippagePoint[] = [];

    for (const pool of this.config.pools) {
      for (const notional of this.config.notionalSizes) {
        try {
          const buyPoint = await this.calibratePoint(pool, notional, 'buy');
          if (buyPoint) results.push(buyPoint);

          const sellPoint = await this.calibratePoint(pool, notional, 'sell');
          if (sellPoint) results.push(sellPoint);
        } catch (error) {
          this.logger.error({ pool: pool.address, notional, error: (error as Error).message }, 'Calibration failed');
        }
      }
    }

    await this.persistResults(results);
    this.logCalibrationTable(results);

    return results;
  }

  private async calibratePoint(
    pool: CalibrationConfig['pools'][0],
    notionalUsd: number,
    direction: 'buy' | 'sell'
  ): Promise<SlippagePoint | null> {
    const midPrice = await this.getMidPrice(pool);
    if (!midPrice) return null;

    let tokenIn: Address;
    let tokenOut: Address;
    let amountIn: bigint;
    let tokenInDecimals: number;
    let tokenOutDecimals: number;

    if (direction === 'buy') {
      tokenIn = pool.token0;
      tokenOut = pool.token1;
      tokenInDecimals = pool.token0Decimals;
      tokenOutDecimals = pool.token1Decimals;
      const token0Amount = notionalUsd / this.getToken0UsdPrice(pool, midPrice);
      amountIn = BigInt(Math.floor(token0Amount * 10 ** pool.token0Decimals));
    } else {
      tokenIn = pool.token1;
      tokenOut = pool.token0;
      tokenInDecimals = pool.token1Decimals;
      tokenOutDecimals = pool.token0Decimals;
      const token1Amount = notionalUsd / this.getToken1UsdPrice(pool, midPrice);
      amountIn = BigInt(Math.floor(token1Amount * 10 ** pool.token1Decimals));
    }

    const feeTier = pool.feeTierBps * 100;

    try {
      const result = await this.publicClient.simulateContract({
        address: this.config.quoterAddress,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn,
          tokenOut,
          amountIn,
          fee: feeTier,
          sqrtPriceLimitX96: 0n,
        }],
      });

      const amountOut = result.result[0];

      const amountInHuman = Number(amountIn) / 10 ** tokenInDecimals;
      const amountOutHuman = Number(amountOut) / 10 ** tokenOutDecimals;

      let execPrice: number;
      if (direction === 'buy') {
        execPrice = amountOutHuman / amountInHuman;
      } else {
        execPrice = amountInHuman / amountOutHuman;
      }

      const slippageBps = Math.abs((execPrice / midPrice - 1) * 10000);
      const gasBps = (this.config.gasUsd / notionalUsd) * 10000;
      const breakEvenBps = pool.feeTierBps + slippageBps + gasBps;
      const recommendedMinSpreadBps = breakEvenBps + this.config.edgeBufferBps;

      return {
        poolAddress: pool.address,
        chain: this.config.chain,
        feeTierBps: pool.feeTierBps,
        direction,
        notionalUsd,
        slippageBps,
        breakEvenBps,
        gasBps,
        recommendedMinSpreadBps,
        quoteAmountIn: amountIn,
        quoteAmountOut: amountOut,
        midPrice,
      };
    } catch (error) {
      this.logger.warn({ pool: pool.address, notional: notionalUsd, direction, error: (error as Error).message }, 'Quote failed');
      return null;
    }
  }

  private getToken0UsdPrice(pool: CalibrationConfig['pools'][0], midPrice: number): number {
    const symbol = pool.token0Symbol.toUpperCase();
    if (symbol === 'USDC' || symbol === 'USDBC') return 1;
    if (symbol === 'WETH') return 3200;
    if (symbol === 'CBETH' || symbol === 'WEETH' || symbol === 'WSTETH' || symbol === 'RETH') {
      return 3200 * midPrice;
    }
    return 3200;
  }

  private getToken1UsdPrice(pool: CalibrationConfig['pools'][0], midPrice: number): number {
    const symbol = pool.token1Symbol.toUpperCase();
    if (symbol === 'USDC' || symbol === 'USDBC') return 1;
    if (symbol === 'WETH') return 3200;
    if (symbol === 'CBETH' || symbol === 'WEETH' || symbol === 'WSTETH' || symbol === 'RETH') {
      return 3200 / midPrice;
    }
    return 3200;
  }

  private async getMidPrice(pool: CalibrationConfig['pools'][0]): Promise<number | null> {
    try {
      const slot0 = await this.publicClient.readContract({
        address: pool.address,
        abi: [{ inputs: [], name: 'slot0', outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' }, { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' }, { name: 'unlocked', type: 'bool' }], stateMutability: 'view', type: 'function' }],
        functionName: 'slot0',
      });

      const sqrtPriceX96 = slot0[0];
      const Q96 = 2n ** 96n;
      const price = (Number(sqrtPriceX96) / Number(Q96)) ** 2;
      const decimalAdjustment = 10 ** (pool.token0Decimals - pool.token1Decimals);
      return price * decimalAdjustment;
    } catch {
      return null;
    }
  }

  private async persistResults(results: SlippagePoint[]): Promise<void> {
    const pool = getPool();
    const query = `
      INSERT INTO slippage_curves (
        pool_address, chain, fee_tier_bps, direction, notional_usd,
        slippage_bps, break_even_bps, gas_bps, recommended_min_spread_bps,
        quote_amount_in, quote_amount_out, mid_price
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `;

    for (const r of results) {
      try {
        await pool.query(query, [
          r.poolAddress, r.chain, r.feeTierBps, r.direction, r.notionalUsd,
          r.slippageBps, r.breakEvenBps, r.gasBps, r.recommendedMinSpreadBps,
          r.quoteAmountIn.toString(), r.quoteAmountOut.toString(), r.midPrice,
        ]);
      } catch (error) {
        this.logger.error({ error: (error as Error).message }, 'Failed to persist slippage point');
      }
    }
  }

  private logCalibrationTable(results: SlippagePoint[]): void {
    const grouped = new Map<string, SlippagePoint[]>();
    for (const r of results) {
      const key = `${r.poolAddress}-${r.direction}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(r);
    }

    for (const [key, points] of grouped) {
      const sorted = points.sort((a, b) => a.notionalUsd - b.notionalUsd);
      this.logger.info({ pool: key.split('-')[0].slice(0, 10), direction: sorted[0].direction }, 'Slippage curve:');

      for (const p of sorted) {
        this.logger.info({
          notional: `$${p.notionalUsd}`,
          slippage: `${p.slippageBps.toFixed(1)} bps`,
          fee: `${p.feeTierBps} bps`,
          breakEven: `${p.breakEvenBps.toFixed(1)} bps`,
          minSpread: `${p.recommendedMinSpreadBps.toFixed(0)} bps`,
        }, 'Calibration point');
      }
    }
  }

  startPeriodicCalibration(intervalMs: number = 5 * 60 * 1000): void {
    this.logger.info({ intervalMs }, 'Starting periodic calibration');
    this.calibrateAll().catch(e => this.logger.error({ error: e.message }, 'Initial calibration failed'));
    this.intervalId = setInterval(() => {
      this.calibrateAll().catch(e => this.logger.error({ error: e.message }, 'Periodic calibration failed'));
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  async getRecommendedMinSpread(poolAddress: string, direction: 'buy' | 'sell', notionalUsd: number): Promise<number | null> {
    const pool = getPool();
    const result = await pool.query(`
      SELECT recommended_min_spread_bps
      FROM latest_slippage_curves
      WHERE pool_address = $1 AND direction = $2 AND notional_usd <= $3
      ORDER BY notional_usd DESC
      LIMIT 1
    `, [poolAddress, direction, notionalUsd]);

    return result.rows[0]?.recommended_min_spread_bps ?? null;
  }
}
