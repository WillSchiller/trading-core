import type { Address, Hash, TransactionReceipt } from 'viem';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain, Opportunity } from '../types/index.js';
import type { QuoteResult } from './quoter.js';
import type { GasEstimate } from './gas.js';
import type { RiskCheckResult, RiskManager } from './risk.js';
import { SwapRouter, type SwapParams } from './router.js';
import { TransactionSigner, NonceError, SimulationError, ReceiptTimeoutError } from './signer.js';
import { insertExecution, updateExecutionStatus, type Execution } from '../persistence/executions.js';
import { updateOpportunityStatus } from '../persistence/opportunities.js';

export interface LiveTradeParams {
  opportunity: Opportunity;
  quote: QuoteResult;
  gasEstimate: GasEstimate;
  riskCheck: RiskCheckResult;
  tokenIn: Address;
  tokenOut: Address;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  amountIn: bigint;
  amountOutMinimum: bigint;
  fee: number;
  maxSlippageBps: number;
  estimatedProfitUsd: number;
  tradeSizeUsd: number;
}

export interface LiveTradeResult {
  executionId: bigint;
  status: 'confirmed' | 'reverted' | 'dropped' | 'timeout' | 'skipped' | 'simulation_failed';
  txHash?: Hash;
  skipReason?: string;
  receipt?: TransactionReceipt;
  actualOutput?: bigint;
  actualOutputHuman?: number;
  realizedPrice?: number;
  realizedSlippageBps?: number;
  gasCostUsd?: number;
  realizedPnlUsd?: number;
  errorMessage?: string;
}

export interface LiveTraderConfig {
  chain: Chain;
  simulateBeforeSend: boolean;
  receiptTimeoutMs: number;
  maxRetries: number;
}

export class LiveTrader {
  private logger: Logger;
  private chain: Chain;
  private config: LiveTraderConfig;
  private router: SwapRouter;
  private signer: TransactionSigner;
  private riskManager: RiskManager;

  constructor(
    config: LiveTraderConfig,
    router: SwapRouter,
    signer: TransactionSigner,
    riskManager: RiskManager
  ) {
    this.logger = createChildLogger({ component: 'live-trader', chain: config.chain });
    this.chain = config.chain;
    this.config = config;
    this.router = router;
    this.signer = signer;
    this.riskManager = riskManager;
  }

  async executeLiveTrade(params: LiveTradeParams): Promise<LiveTradeResult> {
    const { opportunity, gasEstimate, riskCheck } = params;

    this.logger.info(
      {
        opportunityId: opportunity.id?.toString(),
        pairId: opportunity.pairId,
        direction: opportunity.direction,
        spreadBps: opportunity.spreadBps,
        amountIn: params.amountIn.toString(),
        estimatedProfitUsd: params.estimatedProfitUsd,
      },
      'Processing live trade'
    );

    if (!riskCheck.allowed) {
      const skipReason = riskCheck.reason ?? 'Risk check failed';
      await this.recordSkippedTrade(opportunity, skipReason);

      return {
        executionId: 0n,
        status: 'skipped',
        skipReason,
      };
    }

    const execution = await this.createExecutionRecord(params);

    const swapParams: SwapParams = {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      fee: params.fee,
      recipient: this.signer.getAddress(),
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
    };

    const swapTx = this.router.buildExactInputSingleTx(swapParams, {
      gasLimit: gasEstimate.gasLimit,
      maxFeePerGas: gasEstimate.maxFeePerGas,
      maxPriorityFeePerGas: gasEstimate.maxPriorityFeePerGas,
    });

    if (this.config.simulateBeforeSend) {
      try {
        await this.signer.simulateTransaction({
          to: swapTx.to,
          data: swapTx.data,
          value: swapTx.value,
          gas: swapTx.gasLimit,
          maxFeePerGas: swapTx.maxFeePerGas,
          maxPriorityFeePerGas: swapTx.maxPriorityFeePerGas,
        });
      } catch (error) {
        if (error instanceof SimulationError) {
          await this.handleSimulationFailure(execution.id!, error.reason);
          return {
            executionId: execution.id!,
            status: 'simulation_failed',
            errorMessage: error.reason,
          };
        }
        throw error;
      }
    }

    this.riskManager.recordTradeSubmitted(params.tradeSizeUsd);

    let txHash: Hash;
    let retryCount = 0;

    while (retryCount <= this.config.maxRetries) {
      try {
        txHash = await this.signer.signAndSendTransaction({
          to: swapTx.to,
          data: swapTx.data,
          value: swapTx.value,
          gas: swapTx.gasLimit,
          maxFeePerGas: swapTx.maxFeePerGas,
          maxPriorityFeePerGas: swapTx.maxPriorityFeePerGas,
        });

        await updateExecutionStatus(execution.id!, {
          status: 'pending',
          txHash,
          submittedAt: new Date(),
        });

        await updateOpportunityStatus(opportunity.id!, 'submitted');

        break;
      } catch (error) {
        if (error instanceof NonceError) {
          retryCount++;
          this.logger.warn({ retryCount }, 'Nonce error, retrying');
          if (retryCount > this.config.maxRetries) {
            return this.handleSubmissionFailure(execution.id!, params.tradeSizeUsd, 'Max retries exceeded (nonce)');
          }
          continue;
        }
        return this.handleSubmissionFailure(execution.id!, params.tradeSizeUsd, (error as Error).message);
      }
    }

    try {
      const receipt = await this.signer.waitForReceipt(txHash!, this.config.receiptTimeoutMs);

      if (receipt.status === 'success') {
        return await this.handleSuccess(execution.id!, params, receipt, gasEstimate);
      } else {
        return await this.handleRevert(execution.id!, params.tradeSizeUsd, receipt);
      }
    } catch (error) {
      if (error instanceof ReceiptTimeoutError) {
        return this.handleTimeout(execution.id!, params.tradeSizeUsd, txHash!);
      }
      return this.handleSubmissionFailure(execution.id!, params.tradeSizeUsd, (error as Error).message);
    }
  }

  private async createExecutionRecord(params: LiveTradeParams): Promise<{ id: bigint }> {
    const deadline = new Date(Date.now() + 120 * 1000);
    const inputAmountHuman = Number(params.amountIn) / 10 ** params.tokenInDecimals;
    const expectedOutputHuman = Number(params.quote.amountOut) / 10 ** params.tokenOutDecimals;

    const execution: Execution = {
      opportunityId: params.opportunity.id!,
      createdAt: new Date(),
      pairId: params.opportunity.pairId,
      chain: this.chain,
      direction: params.opportunity.direction,
      poolAddress: params.opportunity.dexPoolAddress,
      inputToken: params.tokenIn,
      inputAmount: params.amountIn,
      inputAmountHuman,
      expectedOutput: params.quote.amountOut,
      expectedOutputHuman,
      quotedPrice: params.quote.quotedPrice,
      maxSlippageBps: params.maxSlippageBps,
      amountOutMinimum: params.amountOutMinimum,
      deadline,
      gasPriceGwei: params.gasEstimate.estimatedGasGwei,
      maxFeePerGas: params.gasEstimate.maxFeePerGas,
      maxPriorityFee: params.gasEstimate.maxPriorityFeePerGas,
      gasLimit: Number(params.gasEstimate.gasLimit),
      isPaperTrade: false,
      status: 'pending',
    };

    const id = await insertExecution(execution);
    return { id };
  }

  private async recordSkippedTrade(opportunity: Opportunity, reason: string): Promise<void> {
    await updateOpportunityStatus(opportunity.id!, 'skipped', reason);
    this.logger.info({ opportunityId: opportunity.id?.toString(), reason }, 'Trade skipped');
  }

  private async handleSimulationFailure(executionId: bigint, reason: string): Promise<void> {
    await updateExecutionStatus(executionId, {
      status: 'reverted',
      errorMessage: `Simulation failed: ${reason}`,
    });
    this.logger.error({ executionId: executionId.toString(), reason }, 'Simulation failed');
  }

  private async handleSubmissionFailure(
    executionId: bigint,
    tradeSizeUsd: number,
    errorMessage: string
  ): Promise<LiveTradeResult> {
    await updateExecutionStatus(executionId, {
      status: 'dropped',
      errorMessage,
    });

    this.riskManager.recordTradeCompleted(tradeSizeUsd, false);

    this.logger.error({ executionId: executionId.toString(), errorMessage }, 'Transaction submission failed');

    return {
      executionId,
      status: 'dropped',
      errorMessage,
    };
  }

  private async handleSuccess(
    executionId: bigint,
    params: LiveTradeParams,
    receipt: TransactionReceipt,
    gasEstimate: GasEstimate
  ): Promise<LiveTradeResult> {
    const actualOutput = params.quote.amountOut;
    const actualOutputHuman = Number(actualOutput) / 10 ** params.tokenOutDecimals;
    const inputAmountHuman = Number(params.amountIn) / 10 ** params.tokenInDecimals;
    const realizedPrice = actualOutputHuman / inputAmountHuman;
    const realizedSlippageBps = ((params.quote.quotedPrice - realizedPrice) / params.quote.quotedPrice) * 10000;

    const gasCostUsd = this.calculateGasCost(receipt.gasUsed, receipt.effectiveGasPrice, gasEstimate);
    const realizedPnlUsd = this.calculatePnl(params, actualOutputHuman, gasCostUsd);

    await updateExecutionStatus(executionId, {
      status: 'confirmed',
      confirmedAt: new Date(),
      confirmedBlock: receipt.blockNumber,
      gasUsed: Number(receipt.gasUsed),
      gasCostUsd,
      actualOutput,
      actualOutputHuman,
      realizedPrice,
      realizedSlippageBps,
      realizedPnlUsd,
    });

    await updateOpportunityStatus(params.opportunity.id!, 'filled');

    this.riskManager.recordTradeCompleted(params.tradeSizeUsd, true);

    this.logger.info(
      {
        executionId: executionId.toString(),
        txHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        gasCostUsd,
        realizedPnlUsd,
      },
      'Trade confirmed'
    );

    return {
      executionId,
      status: 'confirmed',
      txHash: receipt.transactionHash,
      receipt,
      actualOutput,
      actualOutputHuman,
      realizedPrice,
      realizedSlippageBps,
      gasCostUsd,
      realizedPnlUsd,
    };
  }

  private async handleRevert(
    executionId: bigint,
    tradeSizeUsd: number,
    receipt: TransactionReceipt
  ): Promise<LiveTradeResult> {
    await updateExecutionStatus(executionId, {
      status: 'reverted',
      confirmedAt: new Date(),
      confirmedBlock: receipt.blockNumber,
      gasUsed: Number(receipt.gasUsed),
      revertReason: 'Transaction reverted on-chain',
    });

    this.riskManager.recordTradeCompleted(tradeSizeUsd, false);

    this.logger.error(
      {
        executionId: executionId.toString(),
        txHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
      },
      'Trade reverted'
    );

    return {
      executionId,
      status: 'reverted',
      txHash: receipt.transactionHash,
      receipt,
      errorMessage: 'Transaction reverted on-chain',
    };
  }

  private handleTimeout(
    executionId: bigint,
    tradeSizeUsd: number,
    txHash: Hash
  ): LiveTradeResult {
    this.riskManager.recordTradeCompleted(tradeSizeUsd, false);

    this.logger.warn({ executionId: executionId.toString(), txHash }, 'Transaction receipt timeout');

    return {
      executionId,
      status: 'timeout',
      txHash,
      errorMessage: 'Receipt timeout - transaction may still confirm',
    };
  }

  private calculateGasCost(gasUsed: bigint, effectiveGasPrice: bigint, gasEstimate: GasEstimate): number {
    const gasWei = gasUsed * effectiveGasPrice;
    const gasEth = Number(gasWei) / 1e18;
    const ethPrice = gasEstimate.estimatedGasUsd / (Number(gasEstimate.estimatedGasWei) / 1e18);
    return gasEth * ethPrice;
  }

  private calculatePnl(params: LiveTradeParams, actualOutputHuman: number, gasCostUsd: number): number {
    const expectedOutputHuman = Number(params.quote.amountOut) / 10 ** params.tokenOutDecimals;
    const outputDiff = actualOutputHuman - expectedOutputHuman;
    const outputDiffUsd = outputDiff * params.opportunity.anchorMid;
    return params.estimatedProfitUsd + outputDiffUsd - gasCostUsd;
  }
}
