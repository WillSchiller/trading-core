import { EventEmitter } from 'events';
import WebSocket from 'ws';
import pg from 'pg';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger({ component: 'spread-monitor' });

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/stream';
const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';
const STALE_THRESHOLD_MS = 2000;
const PERSIST_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 5000;

interface VenuePrice {
  mid: number;
  receivedMs: number;
  exchangeMs: number;
}

interface SpreadTick {
  asset: string;
  binanceSymbol: string;
  hlMid: number;
  binanceMid: number;
  spreadBps: number;
  absSpreadBps: number;
  hlAgeMs: number;
  binanceAgeMs: number;
  maxAgeMs: number;
  timestamp: number;
}

interface SpreadEpisode {
  asset: string;
  binanceSymbol: string;
  startMs: number;
  lastMs: number;
  ticks: number;
  peakAbsBps: number;
  sumSpreadBps: number;
  direction: 'hl_premium' | 'binance_premium';
}

export class SpreadMonitor extends EventEmitter {
  private pool: pg.Pool;
  private binanceWs: WebSocket | null = null;
  private hlWs: WebSocket | null = null;
  private isShuttingDown = false;

  private hlPrices = new Map<string, VenuePrice>();
  private binancePrices = new Map<string, VenuePrice>();

  // binanceSymbol → hlAsset mapping
  private binanceToHl = new Map<string, string>();
  private hlToBinance = new Map<string, string>();

  private activeEpisodes = new Map<string, SpreadEpisode>();
  private closedEpisodes: SpreadEpisode[] = [];

  private pendingSpreads: SpreadTick[] = [];
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private thresholdBps: number;
  private symbolList: Array<{ hlAsset: string; binanceSymbol: string }>;

  constructor(
    symbolList: Array<{ hlAsset: string; binanceSymbol: string }>,
    pool: pg.Pool,
    thresholdBps = 12,
  ) {
    super();
    this.pool = pool;
    this.thresholdBps = thresholdBps;
    this.symbolList = symbolList.filter(s => !s.hlAsset.startsWith('k'));

    for (const s of this.symbolList) {
      this.binanceToHl.set(s.binanceSymbol, s.hlAsset);
      this.hlToBinance.set(s.hlAsset, s.binanceSymbol);
    }
  }

  async start(): Promise<void> {
    this.connectBinance();
    this.connectHl();
    this.persistTimer = setInterval(() => this.flush().catch(e => log.error({ err: e }, 'Flush error')), PERSIST_INTERVAL_MS);
    log.info({ symbols: this.symbolList.length, thresholdBps: this.thresholdBps }, 'Spread monitor started (own WS feeds)');
  }

  stop(): void {
    this.isShuttingDown = true;
    if (this.persistTimer) { clearInterval(this.persistTimer); this.persistTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.binanceWs) { this.binanceWs.removeAllListeners(); this.binanceWs.close(); this.binanceWs = null; }
    if (this.hlWs) { this.hlWs.removeAllListeners(); this.hlWs.close(); this.hlWs = null; }
    this.flush().catch(() => {});
  }

  private connectHl(): void {
    if (this.isShuttingDown) return;
    this.hlWs = new WebSocket(HL_WS_URL);

    this.hlWs.on('open', () => {
      log.info('HL WS connected for spread monitor');
      this.hlWs?.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
    });

    this.hlWs.on('message', (data: WebSocket.Data) => {
      const now = Date.now();
      try {
        const raw = JSON.parse(data.toString());
        if (raw.channel !== 'allMids') return;
        const mids = raw.data?.mids as Record<string, string> | undefined;
        if (!mids) return;

        for (const [asset, midStr] of Object.entries(mids)) {
          if (!this.hlToBinance.has(asset)) continue;
          const mid = parseFloat(midStr);
          if (mid <= 0) continue;
          this.hlPrices.set(asset, { mid, receivedMs: now, exchangeMs: now });
          this.checkSpread(asset);
        }
      } catch {
        // ignore
      }
    });

    this.hlWs.on('close', () => {
      log.warn('HL WS closed (spread monitor)');
      if (!this.isShuttingDown) {
        setTimeout(() => this.connectHl(), RECONNECT_DELAY_MS);
      }
    });

    this.hlWs.on('error', (err: Error) => {
      log.error({ err: err.message }, 'HL WS error (spread monitor)');
    });

    // Keepalive
    const pingInterval = setInterval(() => {
      if (this.hlWs?.readyState === WebSocket.OPEN) {
        this.hlWs.send(JSON.stringify({ method: 'ping' }));
      } else {
        clearInterval(pingInterval);
      }
    }, 30_000);
  }

  private connectBinance(): void {
    if (this.isShuttingDown) return;
    const streams = this.symbolList.map(s => `${s.binanceSymbol.toLowerCase()}@bookTicker`).join('/');
    const url = `${BINANCE_WS_URL}?streams=${streams}`;

    this.binanceWs = new WebSocket(url);

    this.binanceWs.on('open', () => {
      log.info({ streams: this.symbolList.length }, 'Binance spot WS connected');
    });

    this.binanceWs.on('message', (data: WebSocket.Data) => {
      const now = Date.now();
      try {
        const raw = JSON.parse(data.toString());
        if (!raw.data) return;
        const d = raw.data;
        const bid = parseFloat(d.b);
        const ask = parseFloat(d.a);
        if (bid <= 0 || ask <= 0) return;

        const symbol = d.s as string;
        const exchangeMs = d.E ?? now;
        this.binancePrices.set(symbol, { mid: (bid + ask) / 2, receivedMs: now, exchangeMs });

        const hlAsset = this.binanceToHl.get(symbol);
        if (hlAsset) this.checkSpread(hlAsset);
      } catch {
        // ignore parse errors
      }
    });

    this.binanceWs.on('close', () => {
      log.warn('Binance spot WS closed');
      if (!this.isShuttingDown) {
        this.reconnectTimer = setTimeout(() => this.connectBinance(), RECONNECT_DELAY_MS);
      }
    });

    this.binanceWs.on('error', (err: Error) => {
      log.error({ err: err.message }, 'Binance spot WS error');
    });

    // Keepalive ping every 30s
    const pingInterval = setInterval(() => {
      if (this.binanceWs?.readyState === WebSocket.OPEN) {
        this.binanceWs.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30_000);
  }

  private checkSpread(hlAsset: string): void {
    const binSymbol = this.hlToBinance.get(hlAsset);
    if (!binSymbol) return;

    const hl = this.hlPrices.get(hlAsset);
    const bin = this.binancePrices.get(binSymbol);
    if (!hl || !bin) return;

    const now = Date.now();
    const hlAge = now - hl.receivedMs;
    const binAge = now - bin.receivedMs;
    const maxAge = Math.max(hlAge, binAge);

    // Reject if either price is stale
    if (maxAge > STALE_THRESHOLD_MS) return;

    const spreadBps = ((hl.mid - bin.mid) / bin.mid) * 10000;
    const absSpread = Math.abs(spreadBps);

    // Filter obvious data errors
    if (absSpread > 500) return;

    const tick: SpreadTick = {
      asset: hlAsset,
      binanceSymbol: binSymbol,
      hlMid: hl.mid,
      binanceMid: bin.mid,
      spreadBps,
      absSpreadBps: absSpread,
      hlAgeMs: hlAge,
      binanceAgeMs: binAge,
      maxAgeMs: maxAge,
      timestamp: now,
    };

    // Track episodes
    if (absSpread >= this.thresholdBps) {
      const direction = spreadBps > 0 ? 'hl_premium' : 'binance_premium' as const;
      let episode = this.activeEpisodes.get(hlAsset);

      if (!episode || episode.direction !== direction) {
        if (episode) this.closeEpisode(episode);
        episode = {
          asset: hlAsset,
          binanceSymbol: binSymbol,
          startMs: now,
          lastMs: now,
          ticks: 1,
          peakAbsBps: absSpread,
          sumSpreadBps: spreadBps,
          direction,
        };
        this.activeEpisodes.set(hlAsset, episode);
      } else {
        episode.lastMs = now;
        episode.ticks++;
        episode.peakAbsBps = Math.max(episode.peakAbsBps, absSpread);
        episode.sumSpreadBps += spreadBps;
      }
    } else {
      const episode = this.activeEpisodes.get(hlAsset);
      if (episode) {
        this.closeEpisode(episode);
        this.activeEpisodes.delete(hlAsset);
      }
    }

    this.pendingSpreads.push(tick);
    this.emit('spread', tick);
  }

  private closeEpisode(episode: SpreadEpisode): void {
    const durationMs = episode.lastMs - episode.startMs;
    if (durationMs < 500) return; // ignore sub-500ms blips

    this.closedEpisodes.push(episode);
    const avgSpread = episode.sumSpreadBps / episode.ticks;

    log.info({
      asset: episode.asset,
      direction: episode.direction,
      durationMs,
      durationSec: (durationMs / 1000).toFixed(1),
      ticks: episode.ticks,
      avgSpread: avgSpread.toFixed(1),
      peak: episode.peakAbsBps.toFixed(1),
    }, 'Spread episode closed');
  }

  private async flush(): Promise<void> {
    // Persist spread ticks (sample: keep 1 per asset per 10s to avoid DB bloat)
    const toFlush = this.sampleSpreads();
    this.pendingSpreads = [];

    if (toFlush.length > 0) {
      try {
        const values: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        for (const t of toFlush) {
          values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
          params.push(
            new Date(t.timestamp), t.asset, t.binanceSymbol,
            t.hlMid, t.binanceMid, t.spreadBps, t.absSpreadBps, t.maxAgeMs,
          );
        }
        await this.pool.query(`
          INSERT INTO cross_venue_spreads (timestamp, asset, binance_symbol, hl_mid, binance_mid, spread_bps, abs_spread_bps, fetch_latency_ms)
          VALUES ${values.join(',')}
        `, params);
      } catch (err) {
        log.error({ err }, 'Failed to persist spread ticks');
      }
    }

    // Persist closed episodes
    const episodes = this.closedEpisodes.splice(0);
    if (episodes.length > 0) {
      try {
        const values: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        for (const e of episodes) {
          values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
          params.push(
            new Date(e.startMs), new Date(e.lastMs), e.asset, e.binanceSymbol,
            e.lastMs - e.startMs, e.ticks, e.peakAbsBps,
            e.sumSpreadBps / e.ticks, e.direction,
          );
        }
        await this.pool.query(`
          INSERT INTO spread_episodes (start_time, end_time, asset, binance_symbol, duration_ms, ticks, peak_abs_bps, avg_spread_bps, direction)
          VALUES ${values.join(',')}
        `, params);
      } catch (err) {
        log.error({ err }, 'Failed to persist episodes');
      }
    }
  }

  // Keep latest tick per asset per flush interval to avoid DB bloat
  private sampleSpreads(): SpreadTick[] {
    const latest = new Map<string, SpreadTick>();
    for (const t of this.pendingSpreads) {
      latest.set(t.asset, t);
    }
    return Array.from(latest.values());
  }

  getActiveEpisodes(): SpreadEpisode[] {
    return Array.from(this.activeEpisodes.values());
  }

  getSymbolList(): Array<{ hlAsset: string; binanceSymbol: string }> {
    return this.symbolList;
  }
}
