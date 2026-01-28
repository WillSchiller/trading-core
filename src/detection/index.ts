import { createChildLogger, type Logger } from '../utils/logger.js';
import type { QuoteCache } from '../state/quote-cache.js';
import type { AppConfig, PairConfig } from '../config/types.js';
import type { Chain, Opportunity, TradeDirection } from '../types/index.js';
import type { PoolConfig } from '../config/types.js';
import { calculateSpread } from './spread-calculator.js';
import {
  thresholdFilter,
  durationFilter,
  depthFilter,
  stalenessFilter,
  volatilityFilter,
  anchorConfidenceFilter,
  thinMarketBufferFilter,
  timeAlignmentFilter,
  quoteRefreshFilter,
  gasAdjustedThresholdFilter,
  getMaxTimeSkewMs,
  getMinSpreadBpsMultiplier,
  getMinDurationMsMultiplier,
  getMinQuoteRefreshes,
  type FilterResult,
  type QuoteRefreshState,
} from './filters.js';
import { OpportunityEmitter } from './emitter.js';
import { DetectionQueue } from './detection-queue.js';
import { insertOpportunity } from '../persistence/opportunities.js';

export interface OpportunityDetectorConfig {
  quoteCache: QuoteCache;
  appConfig: AppConfig;
  pairsConfig: PairConfig[];
  venueIdMap: Map<string, number>;
  pairIdMap: Map<string, number>;
  onSpreadUpdate?: (chain: Chain, pair: string, spreadBps: number, thresholdBps: number) => void;
  getGasPrice?: (chain: Chain) => Promise<number | undefined>;
}

interface DetectionCycle {
  pair: string;
  chain: Chain;
  pairId: number;
  anchorMid?: number;
  confirmMid?: number;
  dexMid?: number;
  spreadBps?: number;
  passed: boolean;
  reasons: string[];
  duration?: number;
}

interface OpenOpportunity {
  id: bigint;
  oppKey: string;
  openedAt: Date;
  lastSeenAt: Date;
  lastUpdateAt: number;
  maxSpreadBps: number;
  consecutiveAbove: number;
  consecutiveBelow: number;
  pairId: number;
  chain: Chain;
  anchorVenueId: number;
  dexVenueId: number;
  direction: TradeDirection;
  poolAddress: string;
}

const HYSTERESIS_BPS = 2;
const CONSECUTIVE_TICKS_REQUIRED = 2;

function getAnchorVenue(pairConfig: PairConfig): string {
  const venues = pairConfig.venues as Record<string, { isAnchor?: boolean }>;
  for (const [venue, config] of Object.entries(venues)) {
    if (config?.isAnchor) {
      return venue;
    }
  }
  return 'binance';
}

function getConfirmVenue(_pairConfig: PairConfig, anchorVenue: string): string | null {
  if (anchorVenue === 'protocol') {
    return null;
  }
  return anchorVenue === 'binance' ? 'coinbase' : null;
}
const UPDATE_THROTTLE_MS = 250;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30000;

export class OpportunityDetector {
  private logger: Logger;
  private quoteCache: QuoteCache;
  private appConfig: AppConfig;
  private pairsConfig: PairConfig[];
  private venueIdMap: Map<string, number>;
  private pairIdMap: Map<string, number>;
  private emitter: OpportunityEmitter;
  private detectionQueue: DetectionQueue;
  private gapFirstSeen: Map<string, number>;
  private quoteRefreshMap: Map<string, QuoteRefreshState>;
  private intervalHandle: NodeJS.Timeout | null;
  private isRunning: boolean;
  private cycleInProgress: boolean;
  private openOpportunities: Map<string, OpenOpportunity>;
  private onSpreadUpdate?: (chain: Chain, pair: string, spreadBps: number, thresholdBps: number) => void;
  private getGasPrice?: (chain: Chain) => Promise<number | undefined>;
  private consecutiveFailures: number;
  private circuitBreakerOpen: boolean;
  private circuitBreakerOpenedAt: number;

  constructor(config: OpportunityDetectorConfig) {
    this.logger = createChildLogger({ component: 'opportunity-detector' });
    this.quoteCache = config.quoteCache;
    this.appConfig = config.appConfig;
    this.pairsConfig = config.pairsConfig;
    this.venueIdMap = config.venueIdMap;
    this.pairIdMap = config.pairIdMap;
    this.emitter = new OpportunityEmitter();
    this.detectionQueue = new DetectionQueue();
    this.gapFirstSeen = new Map();
    this.quoteRefreshMap = new Map();
    this.intervalHandle = null;
    this.isRunning = false;
    this.cycleInProgress = false;
    this.openOpportunities = new Map();
    this.onSpreadUpdate = config.onSpreadUpdate;
    this.getGasPrice = config.getGasPrice;
    this.consecutiveFailures = 0;
    this.circuitBreakerOpen = false;
    this.circuitBreakerOpenedAt = 0;
  }

  public start(): void {
    if (this.isRunning) {
      this.logger.warn('Opportunity detector already running');
      return;
    }

    this.isRunning = true;
    const tickInterval = this.appConfig.system.tickIntervalMs;

    this.logger.info({ tickInterval }, 'Starting opportunity detector');

    this.detectionQueue.start();

    this.intervalHandle = setInterval(() => {
      this.runDetectionCycle().catch((err) => {
        this.logger.error({ err }, 'Error in detection cycle');
      });
    }, tickInterval);
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Opportunity detector not running');
      return;
    }

    this.isRunning = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    await this.detectionQueue.stop();

    this.logger.info('Opportunity detector stopped');
  }

  public getEmitter(): OpportunityEmitter {
    return this.emitter;
  }

  private async runDetectionCycle(): Promise<void> {
    if (this.cycleInProgress) {
      this.logger.warn('Detection cycle still in progress, skipping this tick');
      return;
    }

    if (this.circuitBreakerOpen) {
      const elapsed = Date.now() - this.circuitBreakerOpenedAt;
      if (elapsed < CIRCUIT_BREAKER_COOLDOWN_MS) {
        this.logger.debug(
          { elapsedMs: elapsed, cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS },
          'Circuit breaker open, skipping detection cycle'
        );
        return;
      }
      this.logger.info('Circuit breaker cooldown elapsed, resuming detection');
      this.circuitBreakerOpen = false;
      this.consecutiveFailures = 0;
    }

    this.cycleInProgress = true;
    const startTime = Date.now();

    try {
      const enabledPairs = this.pairsConfig.filter((p) => p.enabled !== false);

      await Promise.all(enabledPairs.map((pairConfig) => this.detectForPair(pairConfig)));

      const duration = Date.now() - startTime;
      this.consecutiveFailures = 0;

      if (duration > 50) {
        this.logger.warn({ duration }, 'Detection cycle took longer than 50ms');
      } else {
        this.logger.debug({ duration }, 'Detection cycle completed');
      }
    } catch (err) {
      this.consecutiveFailures++;
      this.logger.error(
        { err, consecutiveFailures: this.consecutiveFailures },
        'Detection cycle failed'
      );

      if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitBreakerOpen = true;
        this.circuitBreakerOpenedAt = Date.now();
        this.logger.error(
          {
            consecutiveFailures: this.consecutiveFailures,
            threshold: CIRCUIT_BREAKER_THRESHOLD,
            cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
          },
          'Circuit breaker triggered - detection paused'
        );
      }
    } finally {
      this.cycleInProgress = false;
    }
  }

  public isCircuitBreakerOpen(): boolean {
    return this.circuitBreakerOpen;
  }

  public resetCircuitBreaker(): void {
    this.circuitBreakerOpen = false;
    this.consecutiveFailures = 0;
    this.logger.info('Circuit breaker manually reset');
  }

  private async detectForPair(pairConfig: PairConfig): Promise<void> {
    const pair = `${pairConfig.base}/${pairConfig.quote}`;
    const chain = pairConfig.chain;

    const pairId = this.pairIdMap.get(pair);
    if (!pairId) {
      this.logger.warn({ pair }, 'Pair ID not found in map');
      return;
    }

    const anchorVenue = getAnchorVenue(pairConfig);
    const confirmVenue = getConfirmVenue(pairConfig, anchorVenue);

    const anchorQuote = this.quoteCache.getQuoteWithStaleness({
      venue: anchorVenue,
      pair,
    });

    const confirmQuote = confirmVenue && this.appConfig.detection.requireConfirmationVenue
      ? this.quoteCache.getQuoteWithStaleness({
          venue: confirmVenue,
          pair,
        })
      : undefined;

    const dexQuote = this.quoteCache.getQuoteWithStaleness({
      venue: 'uniswap_v3',
      pair,
      chain,
    });

    if (!anchorQuote || !dexQuote) {
      return;
    }

    const quotes = [anchorQuote, dexQuote];
    if (confirmQuote) {
      quotes.push(confirmQuote);
    }

    const stalenessResult = stalenessFilter({ quotes });
    if (!stalenessResult.passed) {
      this.closeStaleOpportunities(pair, chain, pairId);
      return;
    }

    const timeAlignmentResult = timeAlignmentFilter({
      anchorQuote: anchorQuote.quote,
      dexQuote: dexQuote.quote,
      maxTimeSkewMs: getMaxTimeSkewMs(chain),
    });
    if (!timeAlignmentResult.passed) {
      this.logger.debug(
        { pair, chain, reason: timeAlignmentResult.reason },
        'Quote time alignment check failed'
      );
      return;
    }

    const spreadResult = calculateSpread({
      anchorQuote: anchorQuote.quote,
      confirmQuote: confirmQuote?.quote,
      dexQuote: dexQuote.quote,
    });

    const spreadMultiplier = getMinSpreadBpsMultiplier(chain);
    const durationMultiplier = getMinDurationMsMultiplier(chain);
    const adjustedMinSpreadBps = pairConfig.thresholds.minSpreadBps * spreadMultiplier;
    const adjustedMinDurationMs = pairConfig.thresholds.minDurationMs * durationMultiplier;

    // Notify listeners about current spread vs threshold for adaptive polling
    if (this.onSpreadUpdate) {
      this.onSpreadUpdate(chain, pair, spreadResult.spreadBps, adjustedMinSpreadBps);
    }

    const reasons: string[] = [];
    const filters: FilterResult[] = [];

    const thresholdResult = thresholdFilter({
      spreadBps: spreadResult.spreadBps,
      minSpreadBps: adjustedMinSpreadBps,
    });
    filters.push(thresholdResult);
    reasons.push(thresholdResult.reason);

    if (!thresholdResult.passed) {
      this.logDetectionCycle({
        pair,
        chain,
        pairId,
        anchorMid: spreadResult.anchorMid,
        confirmMid: spreadResult.confirmMid,
        dexMid: spreadResult.dexMid,
        spreadBps: spreadResult.spreadBps,
        passed: false,
        reasons,
      });
      return;
    }

    const hasThinMarketQuotes = quotes.some((q) => q.isThinMarket === true);
    if (hasThinMarketQuotes && pairConfig.thresholds.thinMarketBufferBps) {
      const thinMarketResult = thinMarketBufferFilter({
        spreadBps: spreadResult.spreadBps,
        minSpreadBps: adjustedMinSpreadBps,
        thinMarketBufferBps: pairConfig.thresholds.thinMarketBufferBps,
        hasThinMarketQuotes,
      });
      filters.push(thinMarketResult);
      reasons.push(thinMarketResult.reason);

      if (!thinMarketResult.passed) {
        this.logDetectionCycle({
          pair,
          chain,
          pairId,
          anchorMid: spreadResult.anchorMid,
          confirmMid: spreadResult.confirmMid,
          dexMid: spreadResult.dexMid,
          spreadBps: spreadResult.spreadBps,
          passed: false,
          reasons,
        });
        return;
      }
    }

    let gasGwei: number | undefined;
    if (chain === 'mainnet' && this.getGasPrice) {
      try {
        gasGwei = await this.getGasPrice(chain);
      } catch (err) {
        this.logger.debug({ err, chain }, 'Failed to get gas price for filter');
      }
    }

    const gasAdjustedResult = gasAdjustedThresholdFilter({
      spreadBps: spreadResult.spreadBps,
      minSpreadBps: adjustedMinSpreadBps,
      chain,
      gasGwei,
      gasBpsPerGwei: this.appConfig.detection.gasBpsPerGwei ?? 0.5,
      defaultGasGwei: this.appConfig.detection.defaultGasGwei ?? 50,
    });
    filters.push(gasAdjustedResult);
    reasons.push(gasAdjustedResult.reason);

    if (!gasAdjustedResult.passed) {
      this.logDetectionCycle({
        pair,
        chain,
        pairId,
        anchorMid: spreadResult.anchorMid,
        confirmMid: spreadResult.confirmMid,
        dexMid: spreadResult.dexMid,
        spreadBps: spreadResult.spreadBps,
        passed: false,
        reasons,
      });
      return;
    }

    const pairChainKey = `${pair}:${chain}`;
    const durationResult = durationFilter({
      pairChainKey,
      currentSpreadBps: spreadResult.spreadBps,
      minSpreadBps: adjustedMinSpreadBps,
      minDurationMs: adjustedMinDurationMs,
      gapFirstSeenMap: this.gapFirstSeen,
      quoteRefreshMap: this.quoteRefreshMap,
    });
    filters.push(durationResult);
    reasons.push(durationResult.reason);

    if (!durationResult.passed) {
      this.logDetectionCycle({
        pair,
        chain,
        pairId,
        anchorMid: spreadResult.anchorMid,
        confirmMid: spreadResult.confirmMid,
        dexMid: spreadResult.dexMid,
        spreadBps: spreadResult.spreadBps,
        passed: false,
        reasons,
      });
      return;
    }

    const quoteRefreshResult = quoteRefreshFilter({
      pairChainKey,
      anchorQuote: anchorQuote.quote,
      dexQuote: dexQuote.quote,
      confirmQuote: confirmQuote?.quote,
      spreadDirection: spreadResult.direction,
      minQuoteRefreshes: getMinQuoteRefreshes(chain),
      quoteRefreshMap: this.quoteRefreshMap,
    });
    filters.push(quoteRefreshResult);
    reasons.push(quoteRefreshResult.reason);

    if (!quoteRefreshResult.passed) {
      this.logDetectionCycle({
        pair,
        chain,
        pairId,
        anchorMid: spreadResult.anchorMid,
        confirmMid: spreadResult.confirmMid,
        dexMid: spreadResult.dexMid,
        spreadBps: spreadResult.spreadBps,
        passed: false,
        reasons,
      });
      return;
    }

    const depthResult = depthFilter({
      liquidity: dexQuote.quote.liquidity,
      minLiquidityUsd: pairConfig.thresholds.minLiquidityUsd,
      dexMid: spreadResult.dexMid,
    });
    filters.push(depthResult);
    reasons.push(depthResult.reason);

    if (!depthResult.passed) {
      this.logDetectionCycle({
        pair,
        chain,
        pairId,
        anchorMid: spreadResult.anchorMid,
        confirmMid: spreadResult.confirmMid,
        dexMid: spreadResult.dexMid,
        spreadBps: spreadResult.spreadBps,
        passed: false,
        reasons,
      });
      return;
    }

    const volatilityResult = volatilityFilter({
      spreadBps: spreadResult.spreadBps,
      minSpreadBps: adjustedMinSpreadBps,
      volatilityAdjustment: this.appConfig.detection.volatilityAdjustment,
    });
    filters.push(volatilityResult);
    reasons.push(volatilityResult.reason);

    if (!volatilityResult.passed) {
      this.logDetectionCycle({
        pair,
        chain,
        pairId,
        anchorMid: spreadResult.anchorMid,
        confirmMid: spreadResult.confirmMid,
        dexMid: spreadResult.dexMid,
        spreadBps: spreadResult.spreadBps,
        passed: false,
        reasons,
      });
      return;
    }

    const confidenceResult = anchorConfidenceFilter({
      confidence: spreadResult.confidence,
      anchorDivergenceBps: spreadResult.anchorDivergenceBps,
    });
    filters.push(confidenceResult);
    reasons.push(confidenceResult.reason);

    if (!confidenceResult.passed) {
      this.logDetectionCycle({
        pair,
        chain,
        pairId,
        anchorMid: spreadResult.anchorMid,
        confirmMid: spreadResult.confirmMid,
        dexMid: spreadResult.dexMid,
        spreadBps: spreadResult.spreadBps,
        passed: false,
        reasons,
      });
      return;
    }

    this.logDetectionCycle({
      pair,
      chain,
      pairId,
      anchorMid: spreadResult.anchorMid,
      confirmMid: spreadResult.confirmMid,
      dexMid: spreadResult.dexMid,
      spreadBps: spreadResult.spreadBps,
      passed: true,
      reasons,
    });

    const anchorVenueId = this.venueIdMap.get(anchorVenue);
    const confirmVenueId = confirmQuote && confirmVenue ? this.venueIdMap.get(confirmVenue) : undefined;
    const dexVenueId = this.venueIdMap.get('uniswap_v3');

    if (!anchorVenueId || !dexVenueId) {
      this.logger.error({ pair, chain }, 'Venue ID not found for opportunity');
      return;
    }

    const primaryPool = this.getPrimaryPool(pairConfig, chain);
    if (!primaryPool) {
      this.logger.error({ pair, chain }, 'Primary pool not found');
      return;
    }

    const oppKey = this.buildOpportunityKey(
      chain,
      pairId,
      anchorVenueId,
      dexVenueId,
      spreadResult.direction,
      primaryPool
    );

    const opportunity: Opportunity = {
      detectedAt: new Date(),
      pairId,
      chain,
      anchorVenueId,
      anchorMid: spreadResult.anchorMid,
      confirmVenueId,
      confirmMid: spreadResult.confirmMid,
      dexVenueId,
      dexPoolAddress: primaryPool,
      dexMid: spreadResult.dexMid,
      dexBlockNumber: dexQuote.quote.blockNumber,
      spreadBps: spreadResult.spreadBps,
      direction: spreadResult.direction,
      status: 'detected',
      strategy: 'dislocation',
      reasonCodes: reasons,
    };

    try {
      await this.handleOpportunityLifecycle({
        oppKey,
        spreadBps: spreadResult.spreadBps,
        minSpreadBps: adjustedMinSpreadBps,
        pairId,
        chain,
        anchorVenueId,
        dexVenueId,
        direction: spreadResult.direction,
        poolAddress: primaryPool,
        opportunity,
      });
    } catch (err) {
      this.logger.error({ err, pair, chain, oppKey }, 'Failed to handle opportunity lifecycle');
    }
  }

  private getPrimaryPool(pairConfig: PairConfig, chain: Chain): string | null {
    const uniswapV3Venues = pairConfig.venues.uniswap_v3 as Record<string, PoolConfig[]> | undefined;

    if (!uniswapV3Venues) {
      return null;
    }

    const chainPools = uniswapV3Venues[chain];
    if (!Array.isArray(chainPools)) {
      return null;
    }

    const primaryPool = chainPools.find((p: PoolConfig) => p.primary === true);
    return primaryPool?.pool ?? chainPools[0]?.pool ?? null;
  }

  private logDetectionCycle(cycle: DetectionCycle): void {
    this.logger.debug(
      {
        pair: cycle.pair,
        chain: cycle.chain,
        anchorMid: cycle.anchorMid,
        dexMid: cycle.dexMid,
        spreadBps: cycle.spreadBps,
        passed: cycle.passed,
        reasons: cycle.reasons,
      },
      'Detection cycle'
    );
  }

  private buildOpportunityKey(
    chain: Chain,
    pairId: number,
    anchorVenueId: number,
    dexVenueId: number,
    direction: TradeDirection,
    poolAddress: string
  ): string {
    return `${chain}:${pairId}:${anchorVenueId}:${dexVenueId}:${direction}:${poolAddress}`;
  }

  private closeStaleOpportunities(
    pair: string,
    chain: Chain,
    pairId: number
  ): void {
    const now = new Date();
    const keysToClose: string[] = [];

    for (const [oppKey, openOpp] of this.openOpportunities.entries()) {
      if (openOpp.pairId === pairId && openOpp.chain === chain && openOpp.id) {
        keysToClose.push(oppKey);
      }
    }

    for (const oppKey of keysToClose) {
      const openOpp = this.openOpportunities.get(oppKey);
      if (openOpp && openOpp.id) {
        this.detectionQueue.enqueueClose(openOpp.id, now, 'quote_stale');
        this.logger.info(
          {
            opportunityId: openOpp.id.toString(),
            oppKey,
            pair,
            chain,
          },
          'Opportunity close enqueued due to stale quotes'
        );
        this.openOpportunities.delete(oppKey);
      }
    }
  }

  private async handleOpportunityLifecycle(params: {
    oppKey: string;
    spreadBps: number;
    minSpreadBps: number;
    pairId: number;
    chain: Chain;
    anchorVenueId: number;
    dexVenueId: number;
    direction: TradeDirection;
    poolAddress: string;
    opportunity: Opportunity;
  }): Promise<void> {
    const { oppKey, spreadBps, minSpreadBps } = params;
    const now = new Date();
    const nowMs = Date.now();
    const absSpreadBps = Math.abs(spreadBps);

    const existingOpp = this.openOpportunities.get(oppKey);
    const closeThreshold = minSpreadBps - HYSTERESIS_BPS;

    if (absSpreadBps >= minSpreadBps) {
      if (existingOpp) {
        existingOpp.consecutiveAbove += 1;
        existingOpp.consecutiveBelow = 0;
        existingOpp.lastSeenAt = now;
        existingOpp.maxSpreadBps = Math.max(existingOpp.maxSpreadBps, absSpreadBps);

        if (existingOpp.id && existingOpp.id > BigInt(0)) {
          if (nowMs - existingOpp.lastUpdateAt >= UPDATE_THROTTLE_MS) {
            this.detectionQueue.enqueueLastSeen(existingOpp.id, now, existingOpp.maxSpreadBps);
            existingOpp.lastUpdateAt = nowMs;
          }
        } else if (existingOpp.consecutiveAbove >= CONSECUTIVE_TICKS_REQUIRED) {
          const newOpportunity: Opportunity = {
            ...params.opportunity,
            strategy: 'dislocation',
            openedAt: now,
            lastSeenAt: now,
            maxSpreadBps: existingOpp.maxSpreadBps,
            oppKey,
          };

          try {
            const id = await insertOpportunity(newOpportunity);
            existingOpp.id = id;
            existingOpp.openedAt = now;
            newOpportunity.id = id;

            this.logger.info(
              {
                opportunityId: id.toString(),
                oppKey,
                spreadBps,
                maxSpreadBps: existingOpp.maxSpreadBps,
              },
              'Opportunity opened'
            );

            this.emitter.emitOpportunityDetected(newOpportunity);
          } catch (err) {
            this.logger.error({ err, oppKey }, 'Failed to persist opportunity on open');
            this.openOpportunities.delete(oppKey);
          }
        }
      } else {
        const pendingOpp: OpenOpportunity = {
          id: BigInt(0),
          oppKey,
          openedAt: now,
          lastSeenAt: now,
          lastUpdateAt: nowMs,
          consecutiveAbove: 1,
          consecutiveBelow: 0,
          maxSpreadBps: absSpreadBps,
          pairId: params.pairId,
          chain: params.chain,
          anchorVenueId: params.anchorVenueId,
          dexVenueId: params.dexVenueId,
          direction: params.direction,
          poolAddress: params.poolAddress,
        };

        this.openOpportunities.set(oppKey, pendingOpp);
      }
    } else if (absSpreadBps < closeThreshold) {
      if (existingOpp && existingOpp.id) {
        existingOpp.consecutiveBelow += 1;
        existingOpp.consecutiveAbove = 0;

        if (existingOpp.consecutiveBelow >= CONSECUTIVE_TICKS_REQUIRED) {
          this.detectionQueue.enqueueClose(existingOpp.id, now, 'spread_below_threshold');

          this.logger.info(
            {
              opportunityId: existingOpp.id.toString(),
              oppKey,
              durationMs: nowMs - existingOpp.openedAt.getTime(),
              maxSpreadBps: existingOpp.maxSpreadBps,
            },
            'Opportunity close enqueued'
          );

          this.openOpportunities.delete(oppKey);
        }
      }
    } else {
      if (existingOpp) {
        existingOpp.consecutiveAbove = 0;
        existingOpp.consecutiveBelow = 0;
      }
    }
  }
}
