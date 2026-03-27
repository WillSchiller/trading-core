import WebSocket from 'ws';
import { createChildLogger } from '../utils/logger.js';
import type { PolymarketConfig, TrackedTrader, TraderActivity } from './types.js';

const log = createChildLogger({ component: 'pm-monitor' });

const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com';

type TradeCallback = (trader: TrackedTrader, activity: TraderActivity) => Promise<void>;
type ShadowCallback = (trader: TrackedTrader, activity: TraderActivity) => Promise<void>;

export class ActivityMonitor {
  private lastSeenTimestamp = new Map<string, number>();
  private seenTradeIds = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onNewTrade: TradeCallback | null = null;
  private onShadowTrade: ShadowCallback | null = null;
  private traders: TrackedTrader[] = [];
  private traderMap = new Map<string, TrackedTrader>();
  private pollIndex = 0;
  private errorCount = 0;
  private successCount = 0;
  private wsTradeCount = 0;
  private readonly bootTime = Date.now();
  private ws: WebSocket | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsPingTimer: ReturnType<typeof setInterval> | null = null;

  private healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly config: PolymarketConfig) {}

  setTradeCallback(cb: TradeCallback): void {
    this.onNewTrade = cb;
  }

  setShadowCallback(cb: ShadowCallback): void {
    this.onShadowTrade = cb;
  }

  setTraders(traders: TrackedTrader[]): void {
    this.traders = traders;
    this.traderMap.clear();
    for (const t of traders) {
      this.traderMap.set(t.address.toLowerCase(), t);
    }
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
    log.info({ traders: this.traders.length, perTraderMs: perTraderInterval, bootTime: this.bootTime }, 'Activity monitor started (polling)');

    this.connectWebSocket();

    this.healthCheckTimer = setTimeout(() => {
      log.info({ pollIndex: this.pollIndex, errors: this.errorCount, successes: this.successCount, wsTrades: this.wsTradeCount }, 'Monitor health check (30s)');
    }, 30_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.healthCheckTimer) { clearTimeout(this.healthCheckTimer); this.healthCheckTimer = null; }
    if (this.wsPingTimer) { clearInterval(this.wsPingTimer); this.wsPingTimer = null; }
    if (this.wsReconnectTimer) { clearTimeout(this.wsReconnectTimer); this.wsReconnectTimer = null; }
    if (this.ws) { this.ws.close(); this.ws = null; }
  }

  private connectWebSocket(): void {
    try {
      this.ws = new WebSocket(RTDS_WS_URL);

      this.ws.on('open', () => {
        log.info({ trackedAddresses: this.traderMap.size }, 'RTDS WebSocket connected');
        this.ws?.send(JSON.stringify({
          action: 'subscribe',
          subscriptions: [{ topic: 'activity', type: 'trades' }],
        }));
        this.wsPingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
        }, 5000);
      });

      let msgCount = 0;
      this.ws.on('message', (data: Buffer) => {
        try {
          const raw = data.toString();
          const msg = JSON.parse(raw);
          msgCount++;
          if (msgCount <= 3) {
            log.info({ keys: Object.keys(msg), type: msg.type, topic: msg.topic, msgCount }, 'RTDS WS message sample');
          }
          const trades = msg.data || msg.trades || (Array.isArray(msg) ? msg : null);
          if (trades && Array.isArray(trades)) {
            for (const t of trades) this.handleWsTrade(t);
          } else if (msg.proxyWallet || msg.asset) {
            this.handleWsTrade(msg);
          }
        } catch { /* ignore parse errors */ }
      });

      this.ws.on('close', () => {
        log.warn('RTDS WebSocket closed, reconnecting in 5s');
        if (this.wsPingTimer) { clearInterval(this.wsPingTimer); this.wsPingTimer = null; }
        this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(), 5000);
      });

      this.ws.on('error', (err) => {
        log.warn({ error: err.message }, 'RTDS WebSocket error');
      });
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to connect RTDS WebSocket');
      this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(), 10000);
    }
  }

  private handleWsTrade(data: Record<string, unknown>): void {
    const wallet = ((data.proxyWallet as string) || '').toLowerCase();
    const trader = this.traderMap.get(wallet);
    if (!trader) return;

    const id = (data.transactionHash as string) || `ws_${data.timestamp}_${data.conditionId}_${data.side}`;
    if (this.seenTradeIds.has(id)) return;
    this.seenTradeIds.add(id);

    const timestamp = Number(data.timestamp || 0) * 1000;
    const maxAge = Date.now() - 6 * 60 * 60_000;
    if (timestamp < maxAge || timestamp <= (this.lastSeenTimestamp.get(trader.address) || maxAge)) return;

    const activity: TraderActivity = {
      id,
      traderAddress: trader.address,
      timestamp,
      conditionId: (data.conditionId as string) || '',
      tokenId: (data.asset as string) || '',
      side: (data.side === 'BUY' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
      size: Number(data.size || 0),
      price: Number(data.price || 0),
      outcome: (data.outcome as string) || '',
      marketSlug: (data.slug as string) || '',
      marketQuestion: (data.title as string) || '',
      negRisk: false,
    };

    if (activity.price <= 0) return;

    this.wsTradeCount++;
    this.lastSeenTimestamp.set(trader.address, timestamp);

    log.info({
      trader: trader.alias,
      market: activity.marketSlug,
      side: activity.side,
      size: activity.size,
      price: activity.price,
      source: 'ws',
    }, 'New trader activity detected');

    if (this.onShadowTrade) {
      this.onShadowTrade(trader, activity).catch(e => log.error({ err: e }, 'WS shadow callback error'));
    }
    if (activity.side === 'BUY' && this.onNewTrade) {
      this.onNewTrade(trader, activity).catch(e => log.error({ err: e }, 'WS trade callback error'));
    }
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

      const maxAge = Date.now() - 6 * 60 * 60_000;
      const lastSeen = this.lastSeenTimestamp.get(trader.address) || maxAge;
      const newTrades = activities
        .filter(a => a.timestamp > lastSeen && a.timestamp > maxAge && a.price > 0 && !this.seenTradeIds.has(a.id))
        .sort((a, b) => a.timestamp - b.timestamp);

      if (newTrades.length > 0) {
        log.info({ trader: trader.alias, newTrades: newTrades.length, total: activities.length, lastSeen: new Date(lastSeen).toISOString() }, 'New trades found');
      }

      for (const activity of newTrades) {
        this.seenTradeIds.add(activity.id);

        log.info({
          trader: trader.alias,
          market: activity.marketSlug,
          side: activity.side,
          size: activity.size,
          price: activity.price,
          outcome: activity.outcome,
        }, 'New trader activity detected');

        if (this.onShadowTrade) {
          await this.onShadowTrade(trader, activity);
        }

        if (activity.side === 'BUY' && this.onNewTrade) {
          await this.onNewTrade(trader, activity);
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

    const data = await resp.json() as unknown[];

    if (!Array.isArray(data)) return [];

    return data
      .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
      .map(item => ({
        id: (item.transactionHash as string) || `${item.timestamp}_${item.conditionId}_${item.side}`,
        traderAddress: address,
        timestamp: Number(item.timestamp || 0) * 1000,
        conditionId: (item.conditionId as string) || '',
        tokenId: (item.asset as string) || '',
        side: (item.side === 'BUY' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
        size: Number(item.size || 0),
        price: Number(item.price || 0),
        outcome: (item.outcome as string) || '',
        marketSlug: (item.slug as string) || '',
        marketQuestion: (item.title as string) || '',
        negRisk: item.negRisk === true,
      }));
  }

}
