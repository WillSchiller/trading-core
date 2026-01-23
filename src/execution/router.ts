import { encodeFunctionData, type Address, type Hex } from 'viem';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';

export const SWAP_ROUTER_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'exactInputSingle',
    outputs: [{ name: 'amountOut', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export interface SwapParams {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96?: bigint;
  deadline?: bigint;
}

export interface SwapTransaction {
  to: Address;
  data: Hex;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface RouterConfig {
  routerAddress: Address;
  chain: Chain;
  deadlineSeconds: number;
  maxSlippageBps: number;
}

export class SwapRouter {
  private logger: Logger;
  private config: RouterConfig;

  constructor(config: RouterConfig) {
    this.logger = createChildLogger({ component: 'swap-router', chain: config.chain });
    this.config = config;
  }

  buildExactInputSingleTx(
    params: SwapParams,
    gasEstimate: { gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  ): SwapTransaction {
    const deadline = params.deadline ?? this.calculateDeadline();

    if (params.amountOutMinimum === 0n) {
      throw new RouterError('amountOutMinimum cannot be 0');
    }

    const data = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          fee: params.fee,
          recipient: params.recipient,
          deadline,
          amountIn: params.amountIn,
          amountOutMinimum: params.amountOutMinimum,
          sqrtPriceLimitX96: params.sqrtPriceLimitX96 ?? 0n,
        },
      ],
    });

    const tx: SwapTransaction = {
      to: this.config.routerAddress,
      data,
      value: 0n,
      gasLimit: gasEstimate.gasLimit,
      maxFeePerGas: gasEstimate.maxFeePerGas,
      maxPriorityFeePerGas: gasEstimate.maxPriorityFeePerGas,
    };

    this.logger.debug(
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn.toString(),
        amountOutMinimum: params.amountOutMinimum.toString(),
        fee: params.fee,
        deadline: deadline.toString(),
      },
      'Swap transaction built'
    );

    return tx;
  }

  calculateAmountOutMinimum(expectedAmountOut: bigint, maxSlippageBps?: number): bigint {
    const slippageBps = maxSlippageBps ?? this.config.maxSlippageBps;
    const slippageFactor = 10000n - BigInt(slippageBps);
    const amountOutMinimum = (expectedAmountOut * slippageFactor) / 10000n;

    this.logger.debug(
      {
        expectedAmountOut: expectedAmountOut.toString(),
        slippageBps,
        amountOutMinimum: amountOutMinimum.toString(),
      },
      'Calculated amountOutMinimum'
    );

    return amountOutMinimum;
  }

  private calculateDeadline(): bigint {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.config.deadlineSeconds);
    return deadline;
  }

  getRouterAddress(): Address {
    return this.config.routerAddress;
  }
}

export class RouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterError';
  }
}
