import type { Address } from 'viem';
import { Decimal } from 'decimal.js';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain, Opportunity } from '../types/index.js';
import type { QuoteResult } from './quoter.js';
import type { GasEstimate } from './gas.js';
import type { RiskCheckResult } from './risk.js';
import { insertExecution, updateExecutionStatus, type Execution } from '../persistence/executions.js';
import { updateOpportunityStatus } from '../persistence/opportunities.js';
import type { InventoryManager } from './inventory.js';
import { alertTradeProfit } from '../utils/alerts.js';

export interface PaperTradeParams {
  opportunity: Opportunity;
  quote: QuoteResult;
  gasEstimate: GasEstimate;
  riskCheck: RiskCheckResult;
  tokenIn: Address;
  tokenOut: Address;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  fee: number;
  maxSlippageBps: number;
  estimatedProfitUsd: number;
}

export interface PaperTradeResult {
  executionId: bigint;
  status: 'simulated' | 'skipped';
  skipReason?: string;
  simulatedOutput: bigint;
  simulatedOutputHuman: number;
  simulatedPrice: number;
  simulatedSlippageBps: number;
  simulatedGasUsd: number;
  simulatedPnlUsd: number;
}

export class PaperTrader {
  private logger: Logger;
  private chain: Chain;
  private inventory?: InventoryManager;

  constructor(chain: Chain, inventory?: InventoryManager) {
    this.logger = createChildLogger({ component: 'paper-trader', chain });
    this.chain = chain;
    this.inventory = inventory;
  }

  async executePaperTrade(params: PaperTradeParams): Promise<PaperTradeResult> {
    const { opportunity, quote, gasEstimate, riskCheck } = params;

    const inputAmountHuman = Number(params.amountIn) / 10 ** params.tokenInDecimals;

    this.logger.info(
      {
        opportunityId: opportunity.id?.toString(),
        pairId: opportunity.pairId,
        direction: opportunity.direction,
        spreadBps: opportunity.spreadBps,
        quotedPrice: quote.quotedPrice,
        slippageBps: quote.slippageBps,
        estimatedGasUsd: gasEstimate.estimatedGasUsd,
        estimatedProfitUsd: params.estimatedProfitUsd,
        riskAllowed: riskCheck.allowed,
        tokenIn: params.tokenInSymbol,
        tokenOut: params.tokenOutSymbol,
        amountIn: inputAmountHuman,
      },
      'Processing paper trade'
    );

    if (!riskCheck.allowed) {
      const skipReason = riskCheck.reason ?? 'Risk check failed';
      await this.recordSkippedTrade(opportunity, skipReason, params.estimatedProfitUsd);

      return {
        executionId: 0n,
        status: 'skipped',
        skipReason,
        simulatedOutput: 0n,
        simulatedOutputHuman: 0,
        simulatedPrice: 0,
        simulatedSlippageBps: 0,
        simulatedGasUsd: gasEstimate.estimatedGasUsd,
        simulatedPnlUsd: 0,
      };
    }

    if (this.inventory) {
      const hasBalance = this.inventory.hasEnoughBalance(params.tokenInSymbol, inputAmountHuman);
      if (!hasBalance) {
        const available = this.inventory.getBalance(params.tokenInSymbol);
        const skipReason = `Insufficient ${params.tokenInSymbol}: need ${inputAmountHuman.toFixed(4)}, have ${available.toFixed(4)}`;

        this.logger.info(
          {
            opportunityId: opportunity.id?.toString(),
            tokenIn: params.tokenInSymbol,
            required: inputAmountHuman,
            available,
          },
          'Trade skipped - insufficient inventory'
        );

        await this.recordSkippedTrade(opportunity, skipReason, params.estimatedProfitUsd);

        return {
          executionId: 0n,
          status: 'skipped',
          skipReason,
          simulatedOutput: 0n,
          simulatedOutputHuman: 0,
          simulatedPrice: 0,
          simulatedSlippageBps: 0,
          simulatedGasUsd: gasEstimate.estimatedGasUsd,
          simulatedPnlUsd: 0,
        };
      }
    }

    const deadline = new Date(Date.now() + 120 * 1000);

    const tokenOutScale = new Decimal(10).pow(params.tokenOutDecimals);
    const expectedOutputHuman = new Decimal(quote.amountOut.toString()).dividedBy(tokenOutScale).toNumber();

    const simulatedSlippageBps = this.simulateSlippage(quote.slippageBps);
    const slippageFactor = new Decimal(1).minus(new Decimal(simulatedSlippageBps).dividedBy(10000));
    const simulatedOutput = BigInt(slippageFactor.times(quote.amountOut.toString()).floor().toString());
    const simulatedOutputHuman = new Decimal(simulatedOutput.toString()).dividedBy(tokenOutScale).toNumber();
    const simulatedPrice = new Decimal(simulatedOutputHuman).dividedBy(inputAmountHuman).toNumber();

    const simulatedGasUsd = this.simulateGasCost(gasEstimate.estimatedGasUsd);
    const simulatedPnlUsd = this.calculatePnl(
      opportunity,
      inputAmountHuman,
      simulatedOutputHuman,
      simulatedGasUsd
    );

    const execution: Execution = {
      opportunityId: opportunity.id!,
      createdAt: new Date(),
      pairId: opportunity.pairId,
      chain: this.chain,
      direction: opportunity.direction,
      poolAddress: opportunity.dexPoolAddress,
      inputToken: params.tokenIn,
      inputAmount: params.amountIn,
      inputAmountHuman,
      expectedOutput: quote.amountOut,
      expectedOutputHuman,
      quotedPrice: quote.quotedPrice,
      maxSlippageBps: params.maxSlippageBps,
      amountOutMinimum: params.amountOutMinimum,
      deadline,
      gasPriceGwei: gasEstimate.estimatedGasGwei,
      maxFeePerGas: gasEstimate.maxFeePerGas,
      maxPriorityFee: gasEstimate.maxPriorityFeePerGas,
      gasLimit: Number(gasEstimate.gasLimit),
      isPaperTrade: true,
      status: 'pending',
    };

    const executionId = await insertExecution(execution);

    await updateExecutionStatus(executionId, {
      status: 'confirmed',
      confirmedAt: new Date(),
      gasUsed: Number(quote.gasEstimate),
      gasCostUsd: simulatedGasUsd,
      actualOutput: simulatedOutput,
      actualOutputHuman: simulatedOutputHuman,
      realizedPrice: simulatedPrice,
      realizedSlippageBps: simulatedSlippageBps,
      realizedPnlUsd: simulatedPnlUsd,
    });

    await updateOpportunityStatus(opportunity.id!, 'filled', undefined, params.estimatedProfitUsd);

    if (this.inventory) {
      this.inventory.executeTrade(
        params.tokenInSymbol,
        inputAmountHuman,
        params.tokenOutSymbol,
        simulatedOutputHuman
      );
    }

    this.logger.info(
      {
        executionId: executionId.toString(),
        opportunityId: opportunity.id?.toString(),
        simulatedOutputHuman,
        simulatedPrice,
        simulatedSlippageBps,
        simulatedGasUsd,
        simulatedPnlUsd,
        inventoryUpdate: this.inventory ? {
          deducted: { token: params.tokenInSymbol, amount: inputAmountHuman },
          received: { token: params.tokenOutSymbol, amount: simulatedOutputHuman },
          newBalances: this.inventory.getBalanceSummary(),
        } : undefined,
      },
      'Paper trade completed'
    );

    alertTradeProfit(
      opportunity.pairCanonical || `pair:${opportunity.pairId}`,
      opportunity.direction,
      simulatedPnlUsd,
      Math.abs(opportunity.spreadBps)
    ).catch((err) => this.logger.error({ error: (err as Error).message }, 'Failed to send trade alert'));

    return {
      executionId,
      status: 'simulated',
      simulatedOutput,
      simulatedOutputHuman,
      simulatedPrice,
      simulatedSlippageBps,
      simulatedGasUsd,
      simulatedPnlUsd,
    };
  }

  private async recordSkippedTrade(opportunity: Opportunity, reason: string, estimatedProfitUsd?: number): Promise<void> {
    await updateOpportunityStatus(opportunity.id!, 'skipped', reason, estimatedProfitUsd);

    this.logger.info(
      {
        opportunityId: opportunity.id?.toString(),
        reason,
        estimatedProfitUsd,
      },
      'Trade skipped'
    );
  }

  private simulateSlippage(expectedSlippageBps: number): number {
    const variance = new Decimal('0.2');
    const randomFactor = new Decimal(1).plus(
      new Decimal(Math.random()).minus('0.5').times(variance)
    );
    const result = new Decimal(expectedSlippageBps).times(randomFactor);
    return Decimal.max(0, result).toNumber();
  }

  private simulateGasCost(estimatedGasUsd: number): number {
    const variance = new Decimal('0.15');
    const randomFactor = new Decimal(1).plus(
      new Decimal(Math.random()).minus('0.5').times(variance)
    );
    return new Decimal(estimatedGasUsd).times(randomFactor).toNumber();
  }

  private calculatePnl(
    opportunity: Opportunity,
    inputAmountHuman: number,
    outputAmountHuman: number,
    gasCostUsd: number
  ): number {
    const inputDecimal = new Decimal(inputAmountHuman);
    const outputDecimal = new Decimal(outputAmountHuman);
    const anchorMid = new Decimal(opportunity.anchorMid);
    const gas = new Decimal(gasCostUsd);

    let tradeSizeUsd: Decimal;
    let outputValueUsd: Decimal;

    if (opportunity.direction === 'buy_dex') {
      tradeSizeUsd = inputDecimal;
      outputValueUsd = outputDecimal.times(anchorMid);
    } else {
      tradeSizeUsd = inputDecimal.times(anchorMid);
      outputValueUsd = outputDecimal;
    }

    const grossPnl = outputValueUsd.minus(tradeSizeUsd);
    const netPnl = grossPnl.minus(gas);

    return netPnl.toNumber();
  }
}
