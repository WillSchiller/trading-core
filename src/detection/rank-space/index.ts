import { createChildLogger, type Logger } from '../../utils/logger.js';
import type { QuoteCache } from '../../state/quote-cache.js';
import type { AppConfig, PairConfig } from '../../config/types.js';
import type { Chain, Opportunity, TradeDirection, NormalizedQuote } from '../../types/index.js';
import { OpportunityEmitter } from '../emitter.js';
import { insertOpportunity } from '../../persistence/opportunities.js';
import { timeAlignmentFilter, getMaxTimeSkewMs } from '../filters.js';

export interface RankSpaceDetectorConfig {
  quoteCache: QuoteCache;
  appConfig: AppConfig;
  pairsConfig: PairConfig[];
  venueIdMap: Map<string, number>;
  pairIdMap: Map<string, number>;
  emitter: OpportunityEmitter;
}

interface VenueRank {
  venue: string;
  mid: number;
  rank: number;
  isDex: boolean;
  chain?: Chain;
  poolAddress?: string;
  blockNumber?: bigint;
  quote: NormalizedQuote;
}

interface GapTracking {
  firstSeenMs: number;
  direction: TradeDirection;
  anchorQuote: NormalizedQuote;
}

export class RankSpaceDetector {
  private logger: Logger;
  private quoteCache: QuoteCache;
  private appConfig: AppConfig;
  private pairsConfig: PairConfig[];
  private venueIdMap: Map<string, number>;
  private pairIdMap: Map<string, number>;
  private emitter: OpportunityEmitter;
  private gapFirstSeen: Map<string, GapTracking>;
  private intervalHandle: NodeJS.Timeout | null;
  private isRunning: boolean;
  private cycleInProgress: boolean;

  constructor(config: RankSpaceDetectorConfig) {
    this.logger = createChildLogger({ component: 'rank-space-detector' });
    this.quoteCache = config.quoteCache;
    this.appConfig = config.appConfig;
    this.pairsConfig = config.pairsConfig;
    this.venueIdMap = config.venueIdMap;
    this.pairIdMap = config.pairIdMap;
    this.emitter = config.emitter;
    this.gapFirstSeen = new Map();
    this.intervalHandle = null;
    this.isRunning = false;
    this.cycleInProgress = false;
  }

  public start(): void {
    if (this.isRunning) {
      this.logger.warn('RankSpace detector already running');
      return;
    }

    this.isRunning = true;
    const tickInterval = this.appConfig.system.tickIntervalMs;

    this.logger.info({ tickInterval }, 'Starting RankSpace detector');

    this.intervalHandle = setInterval(() => {
      this.runDetectionCycle().catch((err) => {
        this.logger.error({ err }, 'Error in RankSpace detection cycle');
      });
    }, tickInterval);
  }

  public stop(): void {
    if (!this.isRunning) {
      this.logger.warn('RankSpace detector not running');
      return;
    }

    this.isRunning = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    this.logger.info('RankSpace detector stopped');
  }

  private async runDetectionCycle(): Promise<void> {
    if (this.cycleInProgress) {
      this.logger.warn('RankSpace detection cycle still in progress, skipping this tick');
      return;
    }

    this.cycleInProgress = true;
    const startTime = Date.now();

    try {
      const enabledPairs = this.pairsConfig.filter((p) => p.enabled !== false);

      for (const pairConfig of enabledPairs) {
        await this.detectForPair(pairConfig);
      }

      const duration = Date.now() - startTime;

      if (duration > 50) {
        this.logger.warn({ duration }, 'RankSpace detection cycle took longer than 50ms');
      } else {
        this.logger.debug({ duration }, 'RankSpace detection cycle completed');
      }
    } finally {
      this.cycleInProgress = false;
    }
  }

  private async detectForPair(pairConfig: PairConfig): Promise<void> {
    const pair = `${pairConfig.base}/${pairConfig.quote}`;
    const chain = pairConfig.chain;

    const pairId = this.pairIdMap.get(pair);
    if (!pairId) {
      return;
    }

    const cexVenues = ['binance', 'coinbase', 'bybit'];
    const venueRanks: VenueRank[] = [];

    for (const venueName of cexVenues) {
      const quote = this.quoteCache.getQuoteWithStaleness({
        venue: venueName,
        pair,
      });

      if (quote && !quote.isStale) {
        venueRanks.push({
          venue: venueName,
          mid: quote.quote.mid,
          rank: 0,
          isDex: false,
          quote: quote.quote,
        });
      }
    }

    const dexQuote = this.quoteCache.getQuoteWithStaleness({
      venue: 'uniswap_v3',
      pair,
      chain,
    });

    if (dexQuote && !dexQuote.isStale) {
      const primaryPool = this.getPrimaryPool(pairConfig, chain);
      if (primaryPool) {
        venueRanks.push({
          venue: 'uniswap_v3',
          mid: dexQuote.quote.mid,
          rank: 0,
          isDex: true,
          chain,
          poolAddress: primaryPool,
          blockNumber: dexQuote.quote.blockNumber,
          quote: dexQuote.quote,
        });
      }
    }

    if (venueRanks.length < this.appConfig.rankSpace.minVenues) {
      this.clearGapTracking(pair, chain);
      return;
    }

    const dexRankEntry = venueRanks.find((r) => r.isDex);
    if (!dexRankEntry) {
      this.clearGapTracking(pair, chain);
      return;
    }

    const anchorRankEntry = venueRanks.find((r) => r.venue === 'binance');
    if (!anchorRankEntry) {
      this.clearGapTracking(pair, chain);
      return;
    }

    const timeAlignmentResult = timeAlignmentFilter({
      anchorQuote: anchorRankEntry.quote,
      dexQuote: dexRankEntry.quote,
      maxTimeSkewMs: getMaxTimeSkewMs(chain),
    });

    if (!timeAlignmentResult.passed) {
      this.logger.debug(
        { pair, chain, reason: timeAlignmentResult.reason },
        'RankSpace time alignment check failed'
      );
      this.clearGapTracking(pair, chain);
      return;
    }

    venueRanks.sort((a, b) => a.mid - b.mid);

    for (let i = 0; i < venueRanks.length; i++) {
      venueRanks[i].rank = i + 1;
    }

    const totalVenues = venueRanks.length;
    const topThresholdRank = Math.ceil(totalVenues * this.appConfig.rankSpace.triggerPercentile);
    const bottomThresholdRank = totalVenues - topThresholdRank + 1;

    const isTopPercentile = dexRankEntry.rank <= topThresholdRank;
    const isBottomPercentile = dexRankEntry.rank >= bottomThresholdRank;

    if (!isTopPercentile && !isBottomPercentile) {
      this.clearGapTracking(pair, chain);
      return;
    }

    const direction: TradeDirection = isTopPercentile ? 'buy_dex' : 'sell_dex';

    const spreadBps = ((dexRankEntry.mid - anchorRankEntry.mid) / anchorRankEntry.mid) * 10000;

    if (Math.abs(spreadBps) < this.appConfig.rankSpace.minSpreadBps) {
      this.clearGapTracking(pair, chain);
      return;
    }

    const gapKey = `${pair}:${chain}:${direction}`;
    const anchorExchangeTsMs = anchorRankEntry.quote.exchangeTsMs ?? anchorRankEntry.quote.receivedTsMs;
    let gapTracking = this.gapFirstSeen.get(gapKey);

    if (!gapTracking) {
      gapTracking = {
        firstSeenMs: anchorExchangeTsMs,
        direction,
        anchorQuote: anchorRankEntry.quote,
      };
      this.gapFirstSeen.set(gapKey, gapTracking);

      this.logger.debug(
        {
          pair,
          chain,
          direction,
          dexRank: dexRankEntry.rank,
          totalVenues,
          spreadBps,
        },
        'RankSpace gap first seen'
      );
      return;
    }

    const durationMs = anchorExchangeTsMs - gapTracking.firstSeenMs;

    if (durationMs < this.appConfig.rankSpace.minDurationMs) {
      this.logger.debug(
        {
          pair,
          chain,
          direction,
          durationMs,
          required: this.appConfig.rankSpace.minDurationMs,
        },
        'RankSpace gap duration not met'
      );
      return;
    }

    const anchorVenueId = this.venueIdMap.get('binance');
    const dexVenueId = this.venueIdMap.get('uniswap_v3');

    if (!anchorVenueId || !dexVenueId || !dexRankEntry.poolAddress) {
      return;
    }

    const dexPct = (dexRankEntry.rank - 1) / (totalVenues - 1);

    const opportunity: Opportunity = {
      detectedAt: new Date(),
      pairId,
      chain,
      anchorVenueId,
      anchorMid: anchorRankEntry.mid,
      dexVenueId,
      dexPoolAddress: dexRankEntry.poolAddress,
      dexMid: dexRankEntry.mid,
      dexBlockNumber: dexRankEntry.blockNumber,
      spreadBps,
      direction,
      status: 'detected',
      strategy: 'rank_space',
      reasonCodes: [
        `rank_space_triggered`,
        `dex_rank_${dexRankEntry.rank}_of_${totalVenues}`,
        `spread_${spreadBps.toFixed(1)}bps`,
        `duration_${durationMs}ms`,
      ],
      metadata: {
        dex_rank: dexRankEntry.rank,
        dex_pct: dexPct,
        venue_count: totalVenues,
        ranked_venues: venueRanks.map((v) => ({
          venue: v.venue,
          mid: v.mid,
          rank: v.rank,
        })),
        anchors_used: ['binance'],
        triggered_at: anchorExchangeTsMs,
      },
    };

    try {
      const id = await insertOpportunity(opportunity);

      this.logger.info(
        {
          opportunityId: id.toString(),
          pair,
          chain,
          dexRank: dexRankEntry.rank,
          totalVenues,
          spreadBps,
          direction,
          durationMs,
        },
        'RankSpace opportunity detected'
      );

      this.emitter.emitOpportunityDetected({ ...opportunity, id });

      this.gapFirstSeen.delete(gapKey);
    } catch (err) {
      this.logger.error({ err, pair, chain }, 'Failed to persist RankSpace opportunity');
    }
  }

  private getPrimaryPool(pairConfig: PairConfig, chain: Chain): string | null {
    const venues = pairConfig.venues as Record<string, any>;
    const uniswapV3Venues = venues.uniswap_v3;

    if (!uniswapV3Venues) {
      return null;
    }

    const chainPools = uniswapV3Venues[chain];
    if (!Array.isArray(chainPools)) {
      return null;
    }

    const primaryPool = chainPools.find((p: any) => p.primary === true);
    return primaryPool?.pool ?? chainPools[0]?.pool ?? null;
  }

  private clearGapTracking(pair: string, chain: Chain): void {
    const buyKey = `${pair}:${chain}:buy_dex`;
    const sellKey = `${pair}:${chain}:sell_dex`;

    this.gapFirstSeen.delete(buyKey);
    this.gapFirstSeen.delete(sellKey);
  }
}
