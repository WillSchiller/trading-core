import pg from 'pg';
import { createChildLogger } from '../utils/logger.js';
import { loadPolymarketConfig } from './config.js';
import { PolymarketPersistence } from './persistence.js';
import { TraderDiscovery } from './discovery.js';
import { ActivityMonitor } from './monitor.js';
import { PolymarketRiskManager } from './risk-manager.js';
import { CopyExecutor } from './executor.js';
import { TradeScorer } from './scorer.js';
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
  private scorer: TradeScorer;
  private traderRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private shadowUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private liveUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private recencyWindow = 0;
  private recencyMinPF = 0.8;
  private recencyMinWR = 0.40;
  private recentOrders = new Map<string, number>();
  private lastKnownCash = 0;

  constructor(pool: pg.Pool) {
    this.config = loadPolymarketConfig();
    this.persistence = new PolymarketPersistence(pool);
    this.discovery = new TraderDiscovery(this.config, this.persistence, pool);
    this.monitor = new ActivityMonitor(this.config);
    this.riskManager = new PolymarketRiskManager(this.config, this.persistence);
    this.executor = new CopyExecutor(this.config, this.persistence);
    this.scorer = new TradeScorer(this.persistence);
  }

  async start(): Promise<void> {
    await this.discovery.start();
    await this.executor.start();
    await this.scorer.start();

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
        if (activity.side === 'SELL' && this.executor.isLive()) {
          const position = await this.persistence.getFilledPositionForSell(trader.address, activity.conditionId, activity.tokenId);
          if (position) {
            log.info({ trader: trader.alias, market: activity.marketSlug, outcome: activity.outcome, entryPrice: position.fillPrice, size: position.fillSize }, 'Trader selling — copying exit');
            await this.executor.executeSellOrder(position.id, trader, activity, position);
          }
        }
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
            } else if (await this.failsRecencyCheck(trader.address, trader.alias)) {
              // v2 recency gate
            } else {
              let tradeSize = ourSize;
              let scorerPassed = true;
              if (this.scorer.isEnabled()) {
                const scoreResult = await this.scorer.score(trader, activity);
                scorerPassed = scoreResult.pass;
                if (scorerPassed && scoreResult.kellySize > 0) {
                  tradeSize = scoreResult.kellySize;
                }
              }
              if (!scorerPassed) {
                // ML scorer gate
              } else {
              const minBet = Number(process.env.PM_MIN_BET_USD || 1);
              if (tradeSize > 0 && tradeSize < minBet) {
                tradeSize = minBet;
              }
              if (tradeSize < minBet) {
                log.debug({ trader: trader.alias, market: activity.marketSlug, kellySize: tradeSize.toFixed(2) }, 'Below minimum bet');
              } else {
              const dedupKey = `${activity.conditionId}_${activity.tokenId}`;
              const lastOrder = this.recentOrders.get(dedupKey) || 0;
              if (Date.now() - lastOrder < 600_000) {
                log.debug({ trader: trader.alias, market: activity.marketSlug }, 'Skipped — duplicate market within 60s');
                return;
              }
              log.info({ trader: trader.alias, market: activity.marketSlug, tradeSize: tradeSize.toFixed(2), notional: (tradeSize * activity.price).toFixed(2) }, 'Passed all gates, checking risk');
              shadow.ourSize = tradeSize;
              const { allowed, release } = await this.riskManager.canTrade(tradeSize * activity.price, activity.conditionId);
              if (allowed) {
                this.recentOrders.set(dedupKey, Date.now());
                try {
                  const liveTradeId = await this.persistence.saveLiveTrade(shadow);
                  if (liveTradeId > 0 && this.executor.isLive()) {
                    await this.executor.executeLiveOrder(liveTradeId, trader, activity, tradeSize);
                  }
                } finally {
                  release?.();
                }
              }
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

    this.recencyWindow = Number(process.env.PM_RECENCY_WINDOW || 0);
    this.recencyMinPF = Number(process.env.PM_RECENCY_MIN_PF || 0.8);
    this.recencyMinWR = Number(process.env.PM_RECENCY_MIN_WR || 0.40);
    if (this.recencyWindow > 0) {
      log.info({ window: this.recencyWindow, minPF: this.recencyMinPF, minWR: this.recencyMinWR }, 'Recency gate enabled (v2 filters)');
    }

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

    let cashBalance = this.lastKnownCash;
    if (this.executor.isLive()) {
      try {
        const bal = await this.executor.getBalance();
        if (bal >= 0) {
          cashBalance = bal;
          this.lastKnownCash = bal;
        }
      } catch { /* use last known balance */ }
    }
    const maxKellyBet = this.config.bankrollUsd * 0.125 * 0.5;
    let needCash = cashBalance < maxKellyBet;

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
          // Check pending GTC orders for fills
          if (trade.executionStatus === 'pending' && this.executor.isLive()) {
            try {
              const filled = await this.executor.checkPendingOrder(trade.id);
              if (filled) { log.info({ market: trade.marketSlug, id: trade.id }, 'Pending GTC filled'); updated++; continue; }
              // If market closed while pending, cancel the order
              if (market.closed) {
                await this.executor.cancelPendingOrder(trade.id);
                continue;
              }
            } catch { /* continue */ }
          }
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

              if (needCash && trade.executionStatus === 'filled' && currentPrice >= 0.995 && trade.fillSize) {
                log.info({ market: trade.marketSlug, price: currentPrice, size: trade.fillSize, cashBalance: cashBalance.toFixed(2) }, 'Auto-selling decided winner');
                const activity: import('./types.js').TraderActivity = {
                  id: '', traderAddress: '', timestamp: Date.now(),
                  conditionId: trade.conditionId, tokenId: trade.tokenId,
                  side: 'SELL', size: trade.fillSize, price: currentPrice,
                  outcome: '', marketSlug: trade.marketSlug || '',
                  marketQuestion: '', negRisk: false,
                };
                const dummyTrader: import('./types.js').TrackedTrader = {
                  address: '', alias: 'auto-sell', pnl: 0, volume: 0,
                  bankrollEstimate: 0, rank: 0, enabled: true,
                };
                await this.executor.executeSellOrder(trade.id, dummyTrader, activity, {
                  fillSize: trade.fillSize, fillPrice: trade.fillPrice || trade.ourEntryPrice || 0,
                });
                needCash = false;
              }
            }
          }
        }
      } catch { /* skip */ }
    }
    log.info({ updated, resolved, open: liveTrades.length, markets: byMarket.size }, 'Live prices updated');
  }

  private async failsRecencyCheck(traderAddress: string, alias: string): Promise<boolean> {
    if (this.recencyWindow <= 0) return false;
    const stats = await this.persistence.getTraderRecencyStats(traderAddress, this.recencyWindow);
    if (stats.trades < this.recencyWindow) return false;
    if (stats.profitFactor < this.recencyMinPF || stats.winRate < this.recencyMinWR) {
      log.debug({ trader: alias, recentPF: stats.profitFactor.toFixed(2), recentWR: (stats.winRate * 100).toFixed(0) + '%', window: this.recencyWindow }, 'Recency gate: trader cold');
      return true;
    }
    return false;
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
