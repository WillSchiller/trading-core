import pg from 'pg';
import { createChildLogger } from '../utils/logger.js';
import { loadPolymarketConfig } from './config.js';
import { PolymarketPersistence } from './persistence.js';
import { TraderDiscovery } from './discovery.js';
import { ActivityMonitor } from './monitor.js';
import { CopyExecutor } from './executor.js';
import { PolymarketRiskManager } from './risk-manager.js';
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
  private executor: CopyExecutor;
  private riskManager: PolymarketRiskManager;
  private priceUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private traderRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private shadowUpdateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pool: pg.Pool) {
    this.config = loadPolymarketConfig();
    this.persistence = new PolymarketPersistence(pool);
    this.discovery = new TraderDiscovery(this.config, this.persistence, pool);
    this.monitor = new ActivityMonitor(this.config);
    this.executor = new CopyExecutor(this.config, this.persistence);
    this.riskManager = new PolymarketRiskManager(this.config, this.persistence);
  }

  async start(): Promise<void> {
    await this.executor.start();
    await this.discovery.start();

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
          await this.persistence.saveLiveTrade(shadow);
        }
        log.debug({ trader: trader.alias, market: activity.marketSlug, side: activity.side }, 'Shadow trade recorded');
      } catch (err) {
        log.error({ error: (err as Error).message }, 'Shadow trade save error');
      }
    });

    this.monitor.setTradeCallback(async (trader, activity) => {
      try {
        if (!trader.copyEligible) {
          log.debug({ trader: trader.alias, market: activity.marketSlug }, 'Trade skipped — trader not copy-eligible');
          return;
        }

        const sizeUsd = (activity.size / Math.max(trader.bankrollEstimate, 1)) * this.config.bankrollUsd;

        const { allowed, reason } = await this.riskManager.canTrade(sizeUsd, activity.conditionId);
        if (!allowed) {
          log.info({ trader: trader.alias, market: activity.marketSlug, reason }, 'Trade blocked by risk manager');
          return;
        }

        await this.executor.executeCopy(trader, activity);
        await this.persistence.updateTraderActivity(trader.address);
      } catch (err) {
        log.error({ trader: trader.alias, error: (err as Error).message }, 'Copy trade error');
      }
    });

    this.monitor.start();
    this.riskManager.startPeriodicCheck();

    this.priceUpdateTimer = setInterval(
      () => this.executor.updatePositionPrices().catch(e => log.error({ err: e }, 'Price update error')),
      this.config.positionUpdateIntervalMs,
    );

    this.shadowUpdateTimer = setInterval(
      () => this.updateShadowPrices().catch(e => log.error({ err: e }, 'Shadow update error')),
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
    if (this.priceUpdateTimer) { clearInterval(this.priceUpdateTimer); this.priceUpdateTimer = null; }
    if (this.traderRefreshTimer) { clearInterval(this.traderRefreshTimer); this.traderRefreshTimer = null; }
    if (this.shadowUpdateTimer) { clearInterval(this.shadowUpdateTimer); this.shadowUpdateTimer = null; }
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

    // Also update live trades
    const liveTrades = await this.persistence.getUnresolvedLiveTrades();
    let liveUpdated = 0;
    let liveResolved = 0;
    const liveByMarket = new Map<string, typeof liveTrades>();
    for (const trade of liveTrades) {
      const key = trade.marketSlug || trade.conditionId;
      const list = liveByMarket.get(key) || [];
      list.push(trade);
      liveByMarket.set(key, list);
    }
    for (const [, trades] of liveByMarket) {
      try {
        const first = trades[0];
        const market = await this.fetchMarket(first.conditionId, first.marketSlug);
        if (!market) continue;
        for (const trade of trades) {
          if (market.closed) {
            const resPrice = getResolutionPrice(market, trade.tokenId);
            const pnl = trade.ourSize ? (resPrice - (trade.ourEntryPrice || 0)) * trade.ourSize : 0;
            await this.persistence.resolveLiveTrade(trade.id, resPrice, pnl);
            liveResolved++;
          } else {
            const currentPrice = getTokenPrice(market, trade.tokenId);
            if (currentPrice !== null && trade.ourSize) {
              const pnl = (currentPrice - (trade.ourEntryPrice || 0)) * trade.ourSize;
              await this.persistence.updateLiveTradePrice(trade.id, currentPrice, pnl);
              liveUpdated++;
            }
          }
        }
      } catch { /* skip */ }
    }
    if (liveUpdated > 0 || liveResolved > 0) {
      log.info({ updated: liveUpdated, resolved: liveResolved }, 'Live trade prices updated');
    }
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
