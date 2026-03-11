import WebSocket from 'ws';
import type { Pool } from 'pg';
import { createChildLogger, type Logger } from '../utils/logger.js';

interface VolumeBucket {
  buyVolUsd: number;
  sellVolUsd: number;
  buyCount: number;
  sellCount: number;
}

interface AssetVolumeState {
  currentBucket: VolumeBucket;
  currentPeriodStart: number;
  recentBuckets: Array<{ periodStart: number } & VolumeBucket>;
  ewmaVolUsd: number;
}

const BUCKET_MS = 60_000; // 1-minute buckets
const EWMA_SPAN = 30; // 30-period EWMA (~30 minutes)
const MAX_RECENT = 60; // keep 60 minutes of history
const PERSIST_INTERVAL_MS = 300_000; // flush to DB every 5 minutes

export class VolumeTracker {
  private ws: WebSocket | null = null;
  private logger: Logger;
  private pool: Pool;
  private assets: string[];
  private state: Map<string, AssetVolumeState> = new Map();
  private persistTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingBuckets: Array<{ asset: string; periodStart: number } & VolumeBucket> = [];
  private stopping = false;
  private reconnectAttempts = 0;
  private readonly alpha: number;

  constructor(pool: Pool, assets: string[]) {
    this.pool = pool;
    this.assets = assets;
    this.logger = createChildLogger({ component: 'volume-tracker' });
    this.alpha = 2 / (EWMA_SPAN + 1);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.connect();
    this.persistTimer = setInterval(() => this.flush(), PERSIST_INTERVAL_MS);
    this.logger.info({ assets: this.assets.length }, 'Volume tracker started');
  }

  stop(): void {
    this.stopping = true;
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.flush().catch(() => {});
  }

  getRelativeVolume(asset: string): number | undefined {
    const s = this.state.get(asset);
    if (!s || s.ewmaVolUsd <= 0 || s.recentBuckets.length < 5) return undefined;
    const currentTotal = s.currentBucket.buyVolUsd + s.currentBucket.sellVolUsd;
    return currentTotal / s.ewmaVolUsd;
  }

  getBuySellRatio(asset: string): number | undefined {
    const s = this.state.get(asset);
    if (!s) return undefined;
    const recent = s.recentBuckets.slice(-5);
    let buyVol = s.currentBucket.buyVolUsd;
    let sellVol = s.currentBucket.sellVolUsd;
    for (const b of recent) {
      buyVol += b.buyVolUsd;
      sellVol += b.sellVolUsd;
    }
    const total = buyVol + sellVol;
    if (total === 0) return undefined;
    return (buyVol - sellVol) / total;
  }

  getTradeCount(asset: string): number {
    const s = this.state.get(asset);
    if (!s) return 0;
    return s.currentBucket.buyCount + s.currentBucket.sellCount;
  }

  private connect(): void {
    if (this.stopping) return;

    this.ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

    this.ws.on('open', () => {
      this.logger.info('Volume tracker WS connected');
      this.reconnectAttempts = 0;
      this.subscribeAll();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.channel === 'trades') {
          this.handleTrades(msg.data);
        }
      } catch {
        // ignore parse errors
      }
    });

    this.ws.on('close', () => {
      if (!this.stopping) this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.logger.warn({ error: err.message }, 'Volume tracker WS error');
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.logger.info({ delay, attempt: this.reconnectAttempts }, 'Reconnecting volume tracker');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private subscribeAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const asset of this.assets) {
      this.ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'trades', coin: asset },
      }));
    }
    this.logger.info({ count: this.assets.length }, 'Subscribed to trades channels');
  }

  private handleTrades(trades: Array<{ coin: string; side: string; px: string; sz: string; time: number }>): void {
    if (!Array.isArray(trades)) return;

    const now = Date.now();
    const currentPeriod = Math.floor(now / BUCKET_MS) * BUCKET_MS;

    for (const t of trades) {
      const asset = t.coin;
      if (!this.assets.includes(asset)) continue;

      const px = parseFloat(t.px);
      const sz = parseFloat(t.sz);
      const volUsd = px * sz;
      const isBuy = t.side === 'B';

      let s = this.state.get(asset);
      if (!s) {
        s = {
          currentBucket: { buyVolUsd: 0, sellVolUsd: 0, buyCount: 0, sellCount: 0 },
          currentPeriodStart: currentPeriod,
          recentBuckets: [],
          ewmaVolUsd: 0,
        };
        this.state.set(asset, s);
      }

      if (currentPeriod > s.currentPeriodStart) {
        this.rotateBucket(asset, s, currentPeriod);
      }

      if (isBuy) {
        s.currentBucket.buyVolUsd += volUsd;
        s.currentBucket.buyCount++;
      } else {
        s.currentBucket.sellVolUsd += volUsd;
        s.currentBucket.sellCount++;
      }
    }
  }

  private rotateBucket(asset: string, s: AssetVolumeState, newPeriod: number): void {
    const totalVol = s.currentBucket.buyVolUsd + s.currentBucket.sellVolUsd;

    if (s.ewmaVolUsd === 0) {
      s.ewmaVolUsd = totalVol;
    } else {
      s.ewmaVolUsd = this.alpha * totalVol + (1 - this.alpha) * s.ewmaVolUsd;
    }

    this.pendingBuckets.push({
      asset,
      periodStart: s.currentPeriodStart,
      ...s.currentBucket,
    });

    s.recentBuckets.push({
      periodStart: s.currentPeriodStart,
      ...s.currentBucket,
    });
    if (s.recentBuckets.length > MAX_RECENT) {
      s.recentBuckets.shift();
    }

    s.currentBucket = { buyVolUsd: 0, sellVolUsd: 0, buyCount: 0, sellCount: 0 };
    s.currentPeriodStart = newPeriod;
  }

  private async flush(): Promise<void> {
    if (this.pendingBuckets.length === 0) return;
    const batch = this.pendingBuckets.splice(0);

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const b of batch) {
      placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`);
      values.push(b.asset, b.periodStart, b.buyVolUsd, b.sellVolUsd, b.buyCount, b.sellCount);
      idx += 6;
    }

    try {
      await this.pool.query(
        `INSERT INTO hl_trade_volume (asset, period_start, buy_vol_usd, sell_vol_usd, buy_count, sell_count)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (asset, period_start) DO UPDATE SET
           buy_vol_usd = hl_trade_volume.buy_vol_usd + EXCLUDED.buy_vol_usd,
           sell_vol_usd = hl_trade_volume.sell_vol_usd + EXCLUDED.sell_vol_usd,
           buy_count = hl_trade_volume.buy_count + EXCLUDED.buy_count,
           sell_count = hl_trade_volume.sell_count + EXCLUDED.sell_count`,
        values
      );
      this.logger.debug({ count: batch.length }, 'Flushed trade volume buckets');
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Failed to flush trade volume');
      this.pendingBuckets.unshift(...batch);
    }
  }
}
