import { createChildLogger } from '../utils/logger.js';
import type { PolymarketConfig, TrackedTrader, TraderActivity, MarketInfo } from './types.js';

const log = createChildLogger({ component: 'pm-monitor' });

type TradeCallback = (trader: TrackedTrader, activity: TraderActivity) => void;
type ShadowCallback = (trader: TrackedTrader, activity: TraderActivity) => void;

export class ActivityMonitor {
  private lastSeenTimestamp = new Map<string, number>();
  private seenTradeIds = new Set<string>();
  private marketCache = new Map<string, { info: MarketInfo; cachedAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onNewTrade: TradeCallback | null = null;
  private onShadowTrade: ShadowCallback | null = null;
  private traders: TrackedTrader[] = [];
  private pollIndex = 0;
  private errorCount = 0;
  private successCount = 0;
  private readonly bootTime = Date.now();

  private static readonly MARKET_CACHE_TTL = 5 * 60 * 1000;
  private static readonly MAX_SEEN_IDS = 10000;

  constructor(private readonly config: PolymarketConfig) {}

  setTradeCallback(cb: TradeCallback): void {
    this.onNewTrade = cb;
  }

  setShadowCallback(cb: ShadowCallback): void {
    this.onShadowTrade = cb;
  }

  setTraders(traders: TrackedTrader[]): void {
    this.traders = traders;
  }

  start(): void {
    if (this.traders.length === 0) {
      log.warn('No traders to monitor');
      return;
    }

    const perTraderInterval = Math.max(200, Math.floor(this.config.pollIntervalMs / this.traders.length));

    this.timer = setInterval(
      () => this.pollNext().catch(e => log.error({ err: e }, 'Poll error')),
      perTraderInterval,
    );
    log.info({ traders: this.traders.length, perTraderMs: perTraderInterval, bootTime: this.bootTime }, 'Activity monitor started');

    setTimeout(() => {
      log.info({ pollIndex: this.pollIndex, errors: this.errorCount, successes: this.successCount }, 'Monitor health check (30s)');
    }, 30_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async pollNext(): Promise<void> {
    if (this.traders.length === 0) return;

    const idx = this.pollIndex % this.traders.length;
    const trader = this.traders[idx];
    this.pollIndex++;

    if (this.pollIndex % (this.traders.length * 30) === 0) {
      log.info({
        polls: this.pollIndex,
        successes: this.successCount,
        errors: this.errorCount,
        seenIds: this.seenTradeIds.size,
        traders: this.traders.length,
      }, 'Monitor poll stats');
    }

    try {
      const activities = await this.fetchActivity(trader.address);
      this.successCount++;

      const lastSeen = this.lastSeenTimestamp.get(trader.address) || (this.bootTime - 60_000);
      const newTrades = activities
        .filter(a => a.timestamp > lastSeen && a.price > 0 && !this.seenTradeIds.has(a.id))
        .sort((a, b) => a.timestamp - b.timestamp);

      if (newTrades.length > 0) {
        log.info({ trader: trader.alias, newTrades: newTrades.length, total: activities.length, lastSeen: new Date(lastSeen).toISOString() }, 'New trades found');
      }

      for (const activity of newTrades) {
        this.seenTradeIds.add(activity.id);
        if (this.seenTradeIds.size > ActivityMonitor.MAX_SEEN_IDS) {
          const toDelete = [...this.seenTradeIds].slice(0, 1000);
          for (const id of toDelete) this.seenTradeIds.delete(id);
        }

        const market = await this.getMarketInfo(activity.conditionId);
        if (market) {
          if (market.closed) {
            log.info({ market: market.slug, trader: trader.alias }, 'Skipping closed market');
            continue;
          }
          activity.marketQuestion = market.question;
          activity.marketSlug = market.slug || activity.marketSlug;
          activity.negRisk = market.negRisk;
          activity.outcome = this.resolveOutcome(market, activity.tokenId);
        }

        log.info({
          trader: trader.alias,
          market: activity.marketSlug,
          side: activity.side,
          size: activity.size,
          price: activity.price,
          outcome: activity.outcome,
        }, 'New trader activity detected');

        if (this.onShadowTrade) {
          this.onShadowTrade(trader, activity);
        }

        if (activity.side === 'BUY' && this.onNewTrade) {
          this.onNewTrade(trader, activity);
        }
      }

      if (newTrades.length > 0) {
        this.lastSeenTimestamp.set(trader.address, Math.max(...newTrades.map(t => t.timestamp)));
      }
    } catch (err) {
      this.errorCount++;
      log.warn({ trader: trader.alias, error: (err as Error).message }, 'Failed to poll trader');
    }
  }

  private async fetchActivity(address: string): Promise<TraderActivity[]> {
    const url = `${this.config.dataApiUrl}/trades?user=${address}&limit=20`;
    const resp = await fetch(url);

    if (!resp.ok) {
      throw new Error(`Trades API ${resp.status}`);
    }

    const data = await resp.json() as Array<{
      transactionHash?: string;
      proxyWallet?: string;
      timestamp?: string;
      conditionId?: string;
      asset?: string;
      side?: string;
      size?: string | number;
      price?: string | number;
      outcome?: string;
      slug?: string;
      title?: string;
    }>;

    return data
      .map(item => ({
        id: item.transactionHash || `${item.timestamp}_${item.conditionId}_${item.side}`,
        traderAddress: address,
        timestamp: Number(item.timestamp || 0) * 1000,
        conditionId: item.conditionId || '',
        tokenId: item.asset || '',
        side: (item.side === 'BUY' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
        size: Number(item.size || 0),
        price: Number(item.price || 0),
        outcome: item.outcome || '',
        marketSlug: item.slug || '',
        marketQuestion: item.title || '',
        negRisk: false,
      }));
  }

  private async getMarketInfo(conditionId: string): Promise<MarketInfo | null> {
    const cached = this.marketCache.get(conditionId);
    if (cached && Date.now() - cached.cachedAt < ActivityMonitor.MARKET_CACHE_TTL) {
      return cached.info;
    }

    try {
      const url = `${this.config.gammaApiUrl}/markets?condition_id=${conditionId}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;

      const data = await resp.json() as Array<{
        conditionId?: string;
        questionID?: string;
        question?: string;
        slug?: string;
        outcomes?: string;
        outcomePrices?: string;
        volume?: number;
        liquidity?: number;
        negRisk?: boolean;
        active?: boolean;
        closed?: boolean;
        clobTokenIds?: string;
      }>;

      if (!data.length) return null;

      const m = data[0];
      const outcomes = JSON.parse(m.outcomes || '[]') as string[];
      const outcomePrices = JSON.parse(m.outcomePrices || '[]') as number[];
      const tokenIds = JSON.parse(m.clobTokenIds || '[]') as string[];

      const info: MarketInfo = {
        conditionId: m.conditionId || conditionId,
        questionId: m.questionID || '',
        question: m.question || '',
        slug: m.slug || '',
        outcomes,
        outcomePrices,
        volume: m.volume || 0,
        liquidity: m.liquidity || 0,
        negRisk: m.negRisk || false,
        active: m.active !== false,
        closed: m.closed || false,
        tokens: outcomes.map((o, i) => ({ tokenId: tokenIds[i] || '', outcome: o })),
      };

      this.marketCache.set(conditionId, { info, cachedAt: Date.now() });
      return info;
    } catch (err) {
      log.debug({ conditionId, error: (err as Error).message }, 'Failed to fetch market info');
      return null;
    }
  }

  private resolveOutcome(market: MarketInfo, tokenId: string): string {
    const token = market.tokens.find(t => t.tokenId === tokenId);
    return token?.outcome || 'Unknown';
  }
}
