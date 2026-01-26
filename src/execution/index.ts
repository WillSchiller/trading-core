import type { PublicClient, Address } from 'viem';
import { Decimal } from 'decimal.js';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain, Opportunity } from '../types/index.js';
import type { AppConfig, PairConfig } from '../config/types.js';
import type { OpportunityEmitter } from '../detection/emitter.js';
import type { QuoteCache } from '../state/quote-cache.js';
import { UniswapQuoter, QuoterError, type QuoteParams } from './quoter.js';
import { GasEstimator } from './gas.js';
import { RiskManager } from './risk.js';
import { SwapRouter } from './router.js';
import { TransactionSigner } from './signer.js';
import { PaperTrader } from './paper-trader.js';
import { LiveTrader } from './live-trader.js';
import { InventoryManager } from './inventory.js';
import { BreakEvenCache } from './break-even-cache.js';
import { StatusQueue } from './status-queue.js';

export interface TokenConfig {
  address: Address;
  decimals: number;
  symbol: string;
}

export interface ExecutionManagerConfig {
  chain: Chain;
  publicClient: PublicClient;
  appConfig: AppConfig;
  pairsConfig: PairConfig[];
  quoterAddress: Address;
  routerAddress: Address;
  httpUrl: string;
  privateKey?: string;
  paperMode: boolean;
  tokenMap: Map<string, TokenConfig>;
  pairIdMap: Map<string, number>;
  quoteCache: QuoteCache;
}

export class ExecutionManager {
  private logger: Logger;
  private chain: Chain;
  private appConfig: AppConfig;
  private pairsConfig: PairConfig[];
  private paperMode: boolean;
  private tokenMap: Map<string, TokenConfig>;
  private pairIdMap: Map<string, number>;
  private quoteCache: QuoteCache;

  private quoter: UniswapQuoter;
  private gasEstimator: GasEstimator;
  private riskManager: RiskManager;
  private router: SwapRouter;
  private paperTrader: PaperTrader;
  private liveTrader?: LiveTrader;
  private signer?: TransactionSigner;
  private inventory: InventoryManager;
  private breakEvenCache: BreakEvenCache;
  private statusQueue: StatusQueue;

  private isRunning: boolean = false;
  private cachedGasPrice: { gwei: number; timestamp: number } | null = null;
  private readonly gasPriceCacheTtlMs = 10000;
  private readonly gasPriceRefreshIntervalMs = 8000;
  private gasPriceRefreshInterval: NodeJS.Timeout | null = null;
  private gasCacheStats = { hitCount: 0, missCount: 0 };

  constructor(config: ExecutionManagerConfig) {
    this.logger = createChildLogger({ component: 'execution-manager', chain: config.chain });
    this.chain = config.chain;
    this.appConfig = config.appConfig;
    this.pairsConfig = config.pairsConfig;
    this.paperMode = config.paperMode;
    this.tokenMap = config.tokenMap;
    this.pairIdMap = config.pairIdMap;
    this.quoteCache = config.quoteCache;

    this.quoter = new UniswapQuoter(config.publicClient, {
      quoterAddress: config.quoterAddress,
      chain: config.chain,
    });

    this.gasEstimator = new GasEstimator(config.publicClient, {
      chain: config.chain,
      gasBufferPercent: config.appConfig.execution.gasBufferPercent,
      maxGasGwei: config.appConfig.risk.maxGasGwei,
    });

    this.riskManager = new RiskManager(config.chain, config.appConfig.risk);

    this.router = new SwapRouter({
      routerAddress: config.routerAddress,
      chain: config.chain,
      deadlineSeconds: config.appConfig.execution.deadlineSeconds,
      maxSlippageBps: config.appConfig.execution.maxSlippageBps,
    });

    this.inventory = new InventoryManager(config.chain, config.appConfig.inventory);
    this.breakEvenCache = new BreakEvenCache({ ttlMs: 30000 });
    this.statusQueue = new StatusQueue();

    this.paperTrader = new PaperTrader(config.chain, this.inventory);

    if (config.privateKey && !config.paperMode) {
      this.signer = new TransactionSigner(config.publicClient, {
        chain: config.chain,
        httpUrl: config.httpUrl,
        privateKey: config.privateKey,
      });

      this.liveTrader = new LiveTrader(
        {
          chain: config.chain,
          simulateBeforeSend: config.appConfig.execution.simulateBeforeSend,
          receiptTimeoutMs: 120000,
          maxRetries: 2,
        },
        this.router,
        this.signer,
        this.riskManager
      );
    }

    this.logger.info(
      {
        paperMode: this.paperMode,
        hasLiveTrader: !!this.liveTrader,
        quoterAddress: config.quoterAddress,
        routerAddress: config.routerAddress,
      },
      'Execution manager initialized'
    );
  }

  subscribeToOpportunities(emitter: OpportunityEmitter): void {
    emitter.onOpportunityDetected(async (event) => {
      if (!this.isRunning) {
        return;
      }

      try {
        await this.handleOpportunity(event.opportunity);
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          {
            opportunityId: event.opportunity.id?.toString(),
            error: err.message,
          },
          'Error handling opportunity'
        );
      }
    });

    this.logger.info('Subscribed to opportunity events');
  }

  start(): void {
    if (this.isRunning) {
      this.logger.warn('Execution manager already running');
      return;
    }

    this.isRunning = true;
    this.statusQueue.start();

    this.refreshGasPrice();
    this.gasPriceRefreshInterval = setInterval(() => {
      this.refreshGasPrice();
    }, this.gasPriceRefreshIntervalMs);

    this.logger.info(
      { gasPriceRefreshIntervalMs: this.gasPriceRefreshIntervalMs },
      'Execution manager started'
    );
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Execution manager not running');
      return;
    }

    if (this.gasPriceRefreshInterval) {
      clearInterval(this.gasPriceRefreshInterval);
      this.gasPriceRefreshInterval = null;
    }

    await this.statusQueue.stop();
    this.isRunning = false;
    this.logger.info('Execution manager stopped');
  }

  setEthUsdPrice(price: number): void {
    this.gasEstimator.setEthUsdPrice(price);
  }

  getChain(): Chain {
    return this.chain;
  }

  getRiskState() {
    return this.riskManager.getState();
  }

  getInventoryState() {
    return this.inventory.getState();
  }

  getInventorySummary() {
    return this.inventory.getBalanceSummary();
  }

  haltExecution(reason: string): void {
    this.riskManager.halt(reason);
  }

  resumeExecution(): void {
    this.riskManager.resume();
  }

  getGasCacheStats(): { lastRefresh: number; cacheAgeMs: number; hitCount: number; missCount: number } {
    const now = Date.now();
    return {
      lastRefresh: this.cachedGasPrice?.timestamp ?? 0,
      cacheAgeMs: this.cachedGasPrice ? now - this.cachedGasPrice.timestamp : -1,
      hitCount: this.gasCacheStats.hitCount,
      missCount: this.gasCacheStats.missCount,
    };
  }

  getBreakEvenCacheStats() {
    return this.breakEvenCache.getStats();
  }

  private refreshGasPrice(): void {
    this.gasEstimator.getCurrentGasPrice()
      .then(({ gasPriceGwei }) => {
        const now = Date.now();
        this.cachedGasPrice = { gwei: gasPriceGwei, timestamp: now };
        this.logger.debug({ gasPriceGwei }, 'Gas price cache refreshed');
      })
      .catch((error) => {
        const err = error as Error;
        this.logger.warn({ error: err.message }, 'Failed to refresh gas price cache');
      });
  }

  private async handleOpportunity(opportunity: Opportunity): Promise<void> {
    const startTime = Date.now();
    let quoteLatencyMs = 0;
    let gasEstimateLatencyMs = 0;
    let riskCheckLatencyMs = 0;

    this.logger.info(
      {
        opportunityId: opportunity.id?.toString(),
        pairId: opportunity.pairId,
        spreadBps: opportunity.spreadBps,
        direction: opportunity.direction,
      },
      'Processing opportunity'
    );

    const pairConfig = this.pairsConfig.find((p) => {
      const canonical = `${p.base}/${p.quote}`;
      return (
        this.getPairIdFromConfig(canonical) === opportunity.pairId && p.chain === opportunity.chain
      );
    });

    if (!pairConfig) {
      this.logger.warn({ opportunityId: opportunity.id?.toString() }, 'Pair config not found');
      this.statusQueue.enqueue(opportunity.id!, 'skipped', 'Pair config not found');
      return;
    }

    const { tokenIn, tokenOut, tokenInConfig, tokenOutConfig } = this.resolveTokens(
      opportunity.direction,
      pairConfig
    );

    if (!tokenIn || !tokenOut || !tokenInConfig || !tokenOutConfig) {
      this.logger.warn(
        { opportunityId: opportunity.id?.toString(), direction: opportunity.direction },
        'Token config not found'
      );
      this.statusQueue.enqueue(opportunity.id!, 'skipped', 'Token config not found');
      return;
    }

    const tradeSizeUsd = Math.min(
      pairConfig.thresholds.maxTradeSizeUsd,
      this.appConfig.risk.maxTradeSizeUsd
    );
    const amountIn = this.calculateAmountIn(tradeSizeUsd, opportunity, tokenInConfig.decimals);

    const fee = this.getPoolFee(pairConfig, opportunity.chain);
    const pair = `${pairConfig.base}/${pairConfig.quote}`;
    const sizeBucket = this.breakEvenCache.getSizeBucket(tradeSizeUsd);

    const freshAnchorQuote = this.quoteCache.getQuoteWithStaleness({ venue: 'binance', pair });

    if (!freshAnchorQuote) {
      this.logger.warn(
        { opportunityId: opportunity.id?.toString(), pair },
        'Fresh anchor quote not available - skipping'
      );
      this.statusQueue.enqueue(opportunity.id!, 'skipped', 'Fresh anchor quote unavailable');
      return;
    }

    const quoteParams: QuoteParams = {
      tokenIn,
      tokenOut,
      amountIn,
      fee,
    };
    const invertPrice = opportunity.direction === 'buy_dex';

    const gasPricePromise = this.getCachedGasPrice();
    const feeDataPromise = this.gasEstimator.fetchFeeData();

    let quote;
    const quoteStartTime = Date.now();
    try {
      quote = await this.quoter.quoteExactInputSingle(
        quoteParams,
        opportunity.dexMid,
        tokenInConfig.decimals,
        tokenOutConfig.decimals,
        invertPrice
      );
      quoteLatencyMs = Date.now() - quoteStartTime;
    } catch (error) {
      quoteLatencyMs = Date.now() - quoteStartTime;
      if (error instanceof QuoterError) {
        this.logger.warn(
          { opportunityId: opportunity.id?.toString(), reason: error.reason, quoteLatencyMs },
          'Quote failed'
        );
        this.statusQueue.enqueue(opportunity.id!, 'skipped', `Quote failed: ${error.reason}`);
        return;
      }
      throw error;
    }

    const gasEstimateStartTime = Date.now();
    const [feeData, gasPriceGwei] = await Promise.all([feeDataPromise, gasPricePromise]);
    const gasEstimate = this.gasEstimator.estimateSwapGasWithFeeData(quote.gasEstimate, feeData);
    gasEstimateLatencyMs = Date.now() - gasEstimateStartTime;

    if (quote.slippageBps > this.appConfig.execution.maxSlippageBps) {
      this.logger.warn(
        {
          opportunityId: opportunity.id?.toString(),
          slippageBps: quote.slippageBps,
          maxSlippageBps: this.appConfig.execution.maxSlippageBps,
        },
        'Slippage exceeds max'
      );
      this.statusQueue.enqueue(opportunity.id!, 'skipped', `Slippage ${quote.slippageBps.toFixed(2)} bps > max`);
      return;
    }

    if (!this.gasEstimator.isGasPriceAcceptable(gasPriceGwei)) {
      this.statusQueue.enqueue(opportunity.id!, 'skipped', `Gas price ${gasPriceGwei.toFixed(2)} gwei > max`);
      return;
    }

    const freshAnchorMid = freshAnchorQuote.quote.mid;
    const freshDexPrice = quote.quotedPrice;

    const freshAnchorMidDecimal = new Decimal(freshAnchorMid);
    const freshDexPriceDecimal = new Decimal(freshDexPrice);
    const freshSpreadBps = freshDexPriceDecimal
      .minus(freshAnchorMidDecimal)
      .dividedBy(freshAnchorMidDecimal)
      .times(10000)
      .toNumber();
    const spreadDecay = Math.abs(opportunity.spreadBps) - Math.abs(freshSpreadBps);

    const feeTierBps = new Decimal(fee).dividedBy(100).toNumber();
    const gasBps = new Decimal(gasEstimate.estimatedGasUsd)
      .dividedBy(tradeSizeUsd)
      .times(10000)
      .toNumber();

    let breakEvenBps: number;
    let cacheHit = false;
    const cachedBreakEven = this.breakEvenCache.get(pair, sizeBucket);
    if (cachedBreakEven) {
      breakEvenBps = cachedBreakEven.breakEvenBps;
      cacheHit = true;
    } else {
      breakEvenBps = feeTierBps + Math.abs(quote.slippageBps) + gasBps;
    }

    const edgeBufferBps = 10;
    const requiredSpreadBps = breakEvenBps + edgeBufferBps;

    const totalLatencyMs = Date.now() - startTime;
    this.logger.info(
      {
        opportunityId: opportunity.id?.toString(),
        originalSpreadBps: opportunity.spreadBps,
        freshSpreadBps,
        spreadDecay,
        requiredSpreadBps,
        breakEvenCacheHit: cacheHit,
        anchorAgeMs: freshAnchorQuote.staleDurationMs,
        quoteLatencyMs,
        gasEstimateLatencyMs,
        riskCheckLatencyMs,
        totalLatencyMs,
      },
      'Spread re-validation'
    );

    this.breakEvenCache.refresh(pair, sizeBucket, feeTierBps, gasBps, quote.slippageBps);

    if (Math.abs(freshSpreadBps) < requiredSpreadBps) {
      const reason = `Fresh spread ${Math.abs(freshSpreadBps).toFixed(1)} bps < required ${requiredSpreadBps.toFixed(1)} bps (original: ${Math.abs(opportunity.spreadBps).toFixed(1)} bps, decay: ${spreadDecay.toFixed(1)} bps)`;
      this.logger.info(
        {
          opportunityId: opportunity.id?.toString(),
          freshSpreadBps,
          requiredSpreadBps,
          feeTierBps,
          slippageBps: quote.slippageBps,
          gasBps,
          quoteLatencyMs,
          gasEstimateLatencyMs,
          riskCheckLatencyMs,
          totalLatencyMs,
        },
        'Below break-even threshold (fresh spread)'
      );
      this.statusQueue.enqueue(opportunity.id!, 'skipped', reason);
      return;
    }

    const tokenInScale = new Decimal(10).pow(tokenInConfig.decimals);
    const tokenOutScale = new Decimal(10).pow(tokenOutConfig.decimals);
    const inputAmountHuman = new Decimal(amountIn.toString()).dividedBy(tokenInScale).toNumber();
    const outputAmountHuman = new Decimal(quote.amountOut.toString()).dividedBy(tokenOutScale).toNumber();

    const inputAmountDecimal = new Decimal(inputAmountHuman);
    const outputAmountDecimal = new Decimal(outputAmountHuman);
    let inputValueUsd: Decimal;
    let outputValueUsd: Decimal;
    if (opportunity.direction === 'buy_dex') {
      inputValueUsd = inputAmountDecimal;
      outputValueUsd = outputAmountDecimal.times(freshAnchorMid);
    } else {
      inputValueUsd = inputAmountDecimal.times(freshAnchorMid);
      outputValueUsd = outputAmountDecimal;
    }
    const grossPnlUsd = outputValueUsd.minus(inputValueUsd);
    const estimatedProfitUsd = grossPnlUsd.minus(gasEstimate.estimatedGasUsd).toNumber();

    const riskCheckStartTime = Date.now();
    const riskCheck = await this.riskManager.checkTradeAllowed({
      tradeSizeUsd,
      gasPriceGwei,
      estimatedProfitUsd,
      estimatedGasUsd: gasEstimate.estimatedGasUsd,
    });
    riskCheckLatencyMs = Date.now() - riskCheckStartTime;

    const amountOutMinimum = this.router.calculateAmountOutMinimum(quote.amountOut);

    const tradeParams = {
      opportunity,
      quote,
      gasEstimate,
      riskCheck,
      tokenIn,
      tokenOut,
      tokenInDecimals: tokenInConfig.decimals,
      tokenOutDecimals: tokenOutConfig.decimals,
      tokenInSymbol: tokenInConfig.symbol,
      tokenOutSymbol: tokenOutConfig.symbol,
      amountIn,
      amountOutMinimum,
      fee,
      maxSlippageBps: this.appConfig.execution.maxSlippageBps,
      estimatedProfitUsd,
      tradeSizeUsd,
    };

    if (this.paperMode) {
      await this.paperTrader.executePaperTrade(tradeParams);
    } else if (this.liveTrader) {
      await this.liveTrader.executeLiveTrade(tradeParams);
    } else {
      this.logger.error('Live mode requested but no live trader available');
      this.statusQueue.enqueue(opportunity.id!, 'skipped', 'No live trader configured');
    }
  }

  private resolveTokens(
    direction: 'buy_dex' | 'sell_dex',
    pairConfig: PairConfig
  ): {
    tokenIn: Address | undefined;
    tokenOut: Address | undefined;
    tokenInConfig: TokenConfig | undefined;
    tokenOutConfig: TokenConfig | undefined;
  } {
    const baseToken = this.tokenMap.get(pairConfig.base);
    const quoteToken = this.tokenMap.get(pairConfig.quote);

    if (direction === 'buy_dex') {
      return {
        tokenIn: quoteToken?.address,
        tokenOut: baseToken?.address,
        tokenInConfig: quoteToken,
        tokenOutConfig: baseToken,
      };
    } else {
      return {
        tokenIn: baseToken?.address,
        tokenOut: quoteToken?.address,
        tokenInConfig: baseToken,
        tokenOutConfig: quoteToken,
      };
    }
  }

  private calculateAmountIn(
    tradeSizeUsd: number,
    opportunity: Opportunity,
    tokenDecimals: number
  ): bigint {
    const tokenPriceUsd =
      opportunity.direction === 'buy_dex'
        ? new Decimal(1)
        : new Decimal(opportunity.anchorMid);

    const amountHuman = new Decimal(tradeSizeUsd).dividedBy(tokenPriceUsd);
    const scale = new Decimal(10).pow(tokenDecimals);
    return BigInt(amountHuman.times(scale).floor().toString());
  }

  private getPoolFee(pairConfig: PairConfig, chain: Chain): number {
    const venues = pairConfig.venues as Record<string, unknown>;
    const uniswapV3Venues = venues.uniswap_v3 as Record<string, Array<{ feeTier?: number; primary?: boolean }>> | undefined;

    if (!uniswapV3Venues) {
      return 3000;
    }

    const chainPools = uniswapV3Venues[chain];
    if (!chainPools || chainPools.length === 0) {
      return 3000;
    }

    const primaryPool = chainPools.find((p) => p.primary);
    return primaryPool?.feeTier ?? chainPools[0]?.feeTier ?? 3000;
  }

  private getPairIdFromConfig(canonical: string): number {
    return this.pairIdMap.get(canonical) ?? 0;
  }

  private async getCachedGasPrice(): Promise<number> {
    const now = Date.now();
    if (this.cachedGasPrice && now - this.cachedGasPrice.timestamp < this.gasPriceCacheTtlMs) {
      this.gasCacheStats.hitCount++;
      return this.cachedGasPrice.gwei;
    }

    this.gasCacheStats.missCount++;
    const { gasPriceGwei } = await this.gasEstimator.getCurrentGasPrice();
    this.cachedGasPrice = { gwei: gasPriceGwei, timestamp: now };
    return gasPriceGwei;
  }
}

export { UniswapQuoter, type QuoteParams, type QuoteResult, QuoterError } from './quoter.js';
export { GasEstimator, type GasEstimate } from './gas.js';
export { RiskManager, type RiskState, type RiskCheckResult, type TradeParams } from './risk.js';
export { SwapRouter, type SwapParams, type SwapTransaction, RouterError } from './router.js';
export { TransactionSigner, NonceError, SimulationError, ReceiptTimeoutError } from './signer.js';
export { PaperTrader, type PaperTradeParams, type PaperTradeResult } from './paper-trader.js';
export { LiveTrader, type LiveTradeParams, type LiveTradeResult } from './live-trader.js';
export { SlippageCalibrator, type CalibrationConfig, type SlippagePoint } from './slippage-calibrator.js';
export { InventoryManager, type InventoryConfig, type InventoryState } from './inventory.js';
export { BreakEvenCache, type BreakEvenEntry, type SizeBucket } from './break-even-cache.js';
export { StatusQueue } from './status-queue.js';
