import type { PublicClient, Address } from 'viem';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';

export const QUOTER_V2_ABI = [
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

export interface QuoteParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  fee: number;
  sqrtPriceLimitX96?: bigint;
}

export interface QuoteResult {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
  quotedPrice: number;
  slippageBps: number;
}

export interface QuoterConfig {
  quoterAddress: Address;
  chain: Chain;
}

export class UniswapQuoter {
  private logger: Logger;
  private publicClient: PublicClient;
  private quoterAddress: Address;

  constructor(publicClient: PublicClient, config: QuoterConfig) {
    this.logger = createChildLogger({ component: 'quoter', chain: config.chain });
    this.publicClient = publicClient;
    this.quoterAddress = config.quoterAddress;
  }

  async quoteExactInputSingle(
    params: QuoteParams,
    expectedPrice: number,
    tokenInDecimals: number,
    tokenOutDecimals: number,
    invertPrice: boolean = false
  ): Promise<QuoteResult> {
    this.logger.debug(
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn.toString(),
        fee: params.fee,
      },
      'Requesting quote'
    );

    try {
      const result = await this.publicClient.simulateContract({
        address: this.quoterAddress,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            amountIn: params.amountIn,
            fee: params.fee,
            sqrtPriceLimitX96: params.sqrtPriceLimitX96 ?? 0n,
          },
        ],
      });

      const [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] = result.result;

      const quotedPrice = this.calculateQuotedPrice(
        params.amountIn,
        amountOut,
        tokenInDecimals,
        tokenOutDecimals,
        invertPrice
      );

      const slippageBps = this.calculateSlippage(expectedPrice, quotedPrice);

      const quoteResult: QuoteResult = {
        amountOut,
        sqrtPriceX96After,
        initializedTicksCrossed,
        gasEstimate,
        quotedPrice,
        slippageBps,
      };

      this.logger.info(
        {
          amountIn: params.amountIn.toString(),
          amountOut: amountOut.toString(),
          quotedPrice,
          expectedPrice,
          slippageBps,
          gasEstimate: gasEstimate.toString(),
          ticksCrossed: initializedTicksCrossed,
        },
        'Quote received'
      );

      return quoteResult;
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        {
          error: err.message,
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: params.amountIn.toString(),
        },
        'Quote failed'
      );
      throw new QuoterError('Quote failed', err.message, params);
    }
  }

  private calculateQuotedPrice(
    amountIn: bigint,
    amountOut: bigint,
    tokenInDecimals: number,
    tokenOutDecimals: number,
    invertPrice: boolean
  ): number {
    const amountInAdjusted = Number(amountIn) / 10 ** tokenInDecimals;
    const amountOutAdjusted = Number(amountOut) / 10 ** tokenOutDecimals;
    // invertPrice=true for buy_dex (USDC->WETH), returns price in base/quote terms
    return invertPrice
      ? amountInAdjusted / amountOutAdjusted
      : amountOutAdjusted / amountInAdjusted;
  }

  private calculateSlippage(expectedPrice: number, quotedPrice: number): number {
    return ((expectedPrice - quotedPrice) / expectedPrice) * 10000;
  }
}

export class QuoterError extends Error {
  public readonly reason: string;
  public readonly params: QuoteParams;

  constructor(message: string, reason: string, params: QuoteParams) {
    super(message);
    this.name = 'QuoterError';
    this.reason = reason;
    this.params = params;
  }
}
