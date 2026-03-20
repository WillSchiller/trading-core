import pg from 'pg';
import { createChildLogger } from '../utils/logger.js';
import { loadPolymarketConfig } from './config.js';
import { PolymarketPersistence } from './persistence.js';
import { TraderDiscovery } from './discovery.js';
import { ActivityMonitor } from './monitor.js';
import { PolymarketRiskManager } from './risk-manager.js';
import { CopyExecutor } from './executor.js';
import { getTokenPrice, getResolutionPrice } from './market-utils.js';
import type { PolymarketConfig, ShadowTrade } from './types.js';

const log = createChildLogger({ component: 'pm-copy-trader' });

interface MarketData {
  conditionId?: string;
  closed?: boolean;
  outcomePrices?: string;
  clobTokenIds?: string;
}

export class PolymarketCopyTrader {
  private config: PolymarketConfig;
  private persistence: PolymarketPersistence;
  private discovery: TraderDiscovery;
  private monitor: ActivityMonitor;
  private riskManager: PolymarketRiskManager;
  private executor: CopyExecutor;
  private traderRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private shadowUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private liveUpdateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pool: pg.Pool) {
    this.config = loadPolymarketConfig();
    this.persistence = new PolymarketPersistence(pool);
    this.discovery = new TraderDiscovery(this.config, this.persistence, pool);
    this.monitor = new ActivityMonitor(this.config);
    this.riskManager = new PolymarketRiskManager(this.config, this.persistence);
    this.executor = new CopyExecutor(this.config, this.persistence);
  }

  async start(): Promise<void> {
    await this.discovery.start();
    await this.executor.start();

    const traders = this.discovery.getTrackedTraders();
    this.monitor.setTraders(traders);

    this.monitor.setShadowCallback(async (trader, activity) => {
      try {
        const proportionalSize = (activity.size / Math.max(trader.bankrollEstimate, 1)) * this.config.bankrollUsd;
        const clampedSize = Math.min(proportionalSize, this.config.riskLimits.maxPositionUsd);
        const ourSize = Math.max(1, Math.round(clampedSize * 100) / 100);

        const shadow: ShadowTrade = {
          traderAddress: trader.address,
          traderAlias: trader.alias,
          conditionId: activity.conditionId,
          tokenId: activity.tokenId,
          side: activity.side,
          size: activity.size,
          price: activity.price,
          outcome: activity.outcome,
          marketSlug: activity.marketSlug,
          marketQuestion: activity.marketQuestion,
          negRisk: activity.negRisk,
          ourSize: activity.side === 'BUY' ? ourSize : null,
          ourEntryPrice: activity.side === 'BUY' ? activity.price : null,
          currentPrice: activity.price,
          traderTimestamp: activity.timestamp,
        };
        await this.persistence.saveShadowTrade(shadow);
        if (trader.copyEligible && activity.side === 'BUY') {
          const minEntry = Number(process.env.PM_MIN_ENTRY_PRICE || 0.15);
          const maxEntry = Number(process.env.PM_MAX_ENTRY_PRICE || 0.85);
          if (activity.price < minEntry || activity.price > maxEntry) {
            log.debug({ trader: trader.alias, price: activity.price, market: activity.marketSlug }, 'Skipped — entry price outside range');
          } else {
            const traderStats = await this.persistence.getTraderLiveStats(trader.address);
            const maxConsecLoss = Number(process.env.PM_TRADER_MAX_CONSEC_LOSS || 5);
            const maxTraderLoss = Number(process.env.PM_TRADER_MAX_LOSS || 200);
            if (traderStats.consecutiveLosses >= maxConsecLoss) {
              log.info({ trader: trader.alias, streak: traderStats.consecutiveLosses }, 'Trader circuit breaker: consecutive losses');
            } else if (traderStats.pnl < -maxTraderLoss) {
              log.info({ trader: trader.alias, pnl: traderStats.pnl.toFixed(2) }, 'Trader circuit breaker: max loss');
            } else {
              const { allowed, release } = await this.riskManager.canTrade(ourSize * activity.price, activity.conditionId);
              if (allowed) {
                try {
                  const liveTradeId = await this.persistence.saveLiveTrade(shadow);
                  if (liveTradeId > 0 && this.executor.isLive()) {
                    await this.executor.executeLiveOrder(liveTradeId, trader, activity, ourSize);
                  }
                } finally {
                  release?.();
                }
              }
            }
          }
        }
        log.debug({ trader: trader.alias, market: activity.marketSlug, side: activity.side }, 'Shadow trade recorded');
      } catch (err) {
        log.error({ error: (err as Error).message }, 'Shadow trade save error');
      }
    });

    this.monitor.start();
    this.riskManager.startPeriodicCheck();

    this.shadowUpdateTimer = setInterval(
      () => this.updateShadowPrices().catch(e => log.error({ err: e }, 'Shadow update error')),
      60_000,
    );

    this.liveUpdateTimer = setInterval(
      () => this.updateLivePrices().catch(e => log.error({ err: e }, 'Live update error')),
      60_000,
    );

    this.traderRefreshTimer = setInterval(() => {
      const updatedTraders = this.discovery.getTrackedTraders();
      this.monitor.setTraders(updatedTraders);
    }, this.config.discoveryIntervalMs);

    log.info({
      paperMode: this.config.paperMode,
      bankroll: this.config.bankrollUsd,
      traders: traders.length,
      maxPosition: this.config.riskLimits.maxPositionUsd,
      maxExposure: this.config.riskLimits.maxTotalExposureUsd,
    }, 'Polymarket copy trader started');
  }

  stop(): void {
    this.monitor.stop();
    this.discovery.stop();
    this.riskManager.stop();
    if (this.traderRefreshTimer) { clearInterval(this.traderRefreshTimer); this.traderRefreshTimer = null; }
    if (this.shadowUpdateTimer) { clearInterval(this.shadowUpdateTimer); this.shadowUpdateTimer = null; }
    if (this.liveUpdateTimer) { clearInterval(this.liveUpdateTimer); this.liveUpdateTimer = null; }
    log.info('Polymarket copy trader stopped');
  }

  private async updateShadowPrices(): Promise<void> {
    const unresolved = await this.persistence.getUnresolvedShadowTrades();
    let updated = 0;
    let resolved = 0;

    const byMarket = new Map<string, typeof unresolved>();
    for (const trade of unresolved) {
      const key = trade.marketSlug || trade.conditionId;
      const list = byMarket.get(key) || [];
      list.push(trade);
      byMarket.set(key, list);
    }

    for (const [, trades] of byMarket) {
      try {
        const first = trades[0];
        const market = await this.fetchMarket(first.conditionId, first.marketSlug);
        if (!market) continue;

        for (const trade of trades) {
          if (market.closed) {
            const resPrice = getResolutionPrice(market, trade.tokenId);
            const pnl = trade.ourSize ? (resPrice - (trade.ourEntryPrice || 0)) * trade.ourSize : 0;
            await this.persistence.resolveShadowTrade(trade.id, resPrice, pnl);
            resolved++;
          } else {
            const currentPrice = getTokenPrice(market, trade.tokenId);
            if (currentPrice !== null && trade.ourSize) {
              const pnl = (currentPrice - (trade.ourEntryPrice || 0)) * trade.ourSize;
              await this.persistence.updateShadowPrice(trade.id, currentPrice, pnl);
              updated++;
            }
          }
        }
      } catch { /* skip */ }
    }

    if (updated > 0 || resolved > 0) {
      log.info({ updated, resolved, markets: byMarket.size }, 'Shadow prices updated');
    }

  }

  private async updateLivePrices(): Promise<void> {
    const liveTrades = await this.persistence.getUnresolvedLiveTrades();
    if (liveTrades.length === 0) return;

    let updated = 0;
    let resolved = 0;
    const byMarket = new Map<string, typeof liveTrades>();
    for (const trade of liveTrades) {
      const key = trade.marketSlug || trade.conditionId;
      const list = byMarket.get(key) || [];
      list.push(trade);
      byMarket.set(key, list);
    }
    for (const [, trades] of byMarket) {
      try {
        const first = trades[0];
        const market = await this.fetchMarket(first.conditionId, first.marketSlug);
        if (!market) continue;
        for (const trade of trades) {
          if (market.closed) {
            const resPrice = getResolutionPrice(market, trade.tokenId);
            const pnl = trade.ourSize ? (resPrice - (trade.ourEntryPrice || 0)) * trade.ourSize : 0;
            await this.persistence.resolveLiveTradeWithRealPnl(trade.id, resPrice, pnl);
            resolved++;
          } else {
            const currentPrice = getTokenPrice(market, trade.tokenId);
            if (currentPrice !== null && trade.ourSize) {
              const pnl = (currentPrice - (trade.ourEntryPrice || 0)) * trade.ourSize;
              await this.persistence.updateLiveTradePrice(trade.id, currentPrice, pnl);
              updated++;
            }
          }
        }
      } catch { /* skip */ }
    }
    log.info({ updated, resolved, open: liveTrades.length, markets: byMarket.size }, 'Live prices updated');
  }

  private async fetchMarket(conditionId: string, slug?: string): Promise<MarketData | null> {
    try {
      const url = `${this.config.gammaApiUrl}/markets?condition_id=${conditionId}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json() as MarketData[];
        const market = data[0] ?? null;
        if (market && market.conditionId === conditionId) return market;
      }
    } catch { /* fall through to slug */ }

    if (!slug) return null;
    try {
      const url = `${this.config.gammaApiUrl}/markets?slug=${slug}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const data = await resp.json() as MarketData[];
      return data[0] ?? null;
    } catch { return null; }
  }

}
