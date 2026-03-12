import { createChildLogger } from '../utils/logger.js';
import type { PolymarketConfig, TrackedTrader, TraderActivity, MarketInfo } from './types.js';

const log = createChildLogger({ component: 'pm-monitor' });

type TradeCallback = (trader: TrackedTrader, activity: TraderActivity) => void;

export class ActivityMonitor {
  private lastSeenTimestamp = new Map<string, number>();
  private seenTradeIds = new Set<string>();
  private marketCache = new Map<string, { info: MarketInfo; cachedAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onNewTrade: TradeCallback | null = null;
  private traders: TrackedTrader[] = [];
  private pollIndex = 0;

  private static readonly MARKET_CACHE_TTL = 5 * 60 * 1000;
  private static readonly MAX_SEEN_IDS = 10000;

  constructor(private readonly config: PolymarketConfig) {}

  setTradeCallback(cb: TradeCallback): void {
    this.onNewTrade = cb;
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
    log.info({ traders: this.traders.length, perTraderMs: perTraderInterval }, 'Activity monitor started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async pollNext(): Promise<void> {
    if (this.traders.length === 0) return;

    const trader = this.traders[this.pollIndex % this.traders.length];
    this.pollIndex++;

    try {
      const activities = await this.fetchActivity(trader.address);

      const lastSeen = this.lastSeenTimestamp.get(trader.address) || 0;
      const newTrades = activities
        .filter(a => a.timestamp > lastSeen && a.side === 'BUY' && !this.seenTradeIds.has(a.id))
        .sort((a, b) => a.timestamp - b.timestamp);

      for (const activity of newTrades) {
        this.seenTradeIds.add(activity.id);
        if (this.seenTradeIds.size > ActivityMonitor.MAX_SEEN_IDS) {
          const iter = this.seenTradeIds.values();
          for (let i = 0; i < 1000; i++) iter.next();
        }

        const market = await this.getMarketInfo(activity.conditionId);
        if (market) {
          activity.marketQuestion = market.question;
          activity.marketSlug = market.slug;
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

        if (this.onNewTrade) {
          this.onNewTrade(trader, activity);
        }
      }

      if (newTrades.length > 0) {
        this.lastSeenTimestamp.set(trader.address, Math.max(...newTrades.map(t => t.timestamp)));
      }
    } catch (err) {
      log.debug({ trader: trader.alias, error: (err as Error).message }, 'Failed to poll trader');
    }
  }

  private async fetchActivity(address: string): Promise<TraderActivity[]> {
    const url = `${this.config.dataApiUrl}/activity?user=${address}&limit=20&sortBy=TIMESTAMP&sortDirection=DESC`;
    const resp = await fetch(url);

    if (!resp.ok) {
      throw new Error(`Activity API ${resp.status}`);
    }

    const data = await resp.json() as Array<{
      id?: string;
      proxyWallet?: string;
      timestamp?: string;
      conditionId?: string;
      asset?: string;
      side?: string;
      size?: string | number;
      price?: string | number;
      type?: string;
    }>;

    return data
      .filter(item => item.type === 'TRADE' || !item.type)
      .map(item => ({
        id: item.id || `${item.timestamp}_${item.conditionId}_${item.side}`,
        traderAddress: address,
        timestamp: new Date(item.timestamp || 0).getTime(),
        conditionId: item.conditionId || '',
        tokenId: item.asset || '',
        side: (item.side === 'BUY' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
        size: Number(item.size || 0),
        price: Number(item.price || 0),
        outcome: '',
        marketSlug: '',
        marketQuestion: '',
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
