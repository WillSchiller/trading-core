import WebSocket from 'ws';
import { createChildLogger } from '../../utils/logger.js';
import type { BookSnapshot, BookLevel } from './types.js';

const log = createChildLogger({ component: 'mm-book-feed' });

export class BookFeed {
  private ws: WebSocket | null = null;
  private assets: string[];
  private books: Map<string, BookSnapshot> = new Map();
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private onUpdate?: (book: BookSnapshot) => void;

  constructor(assets: string[], onUpdate?: (book: BookSnapshot) => void) {
    this.assets = assets;
    this.onUpdate = onUpdate;
  }

  start(): void {
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getBook(asset: string): BookSnapshot | undefined {
    return this.books.get(asset);
  }

  private connect(): void {
    if (this.stopping) return;
    this.ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

    this.ws.on('open', () => {
      log.info('Book feed WS connected');
      this.reconnectAttempts = 0;
      for (const asset of this.assets) {
        this.ws!.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'l2Book', coin: asset, nSigFigs: 5 },
        }));
      }
      log.info({ count: this.assets.length }, 'Subscribed to L2 books');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.channel === 'l2Book') {
          this.handleBook(msg.data);
        }
      } catch { /* ignore malformed WS messages */ }
    });

    this.ws.on('close', () => {
      if (!this.stopping) this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      log.warn({ error: err.message }, 'Book feed WS error');
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private handleBook(data: { coin: string; time: number; levels: Array<Array<{ px: string; sz: string; n: number }>> }): void {
    const asset = data.coin;
    if (!this.assets.includes(asset)) return;

    const bids: BookLevel[] = (data.levels[0] || []).map(l => ({
      px: parseFloat(l.px), sz: parseFloat(l.sz), n: l.n,
    }));
    const asks: BookLevel[] = (data.levels[1] || []).map(l => ({
      px: parseFloat(l.px), sz: parseFloat(l.sz), n: l.n,
    }));

    if (bids.length === 0 || asks.length === 0) return;

    const bestBid = bids[0].px;
    const bestAsk = asks[0].px;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadBps = (bestAsk - bestBid) / midPrice * 10000;

    const snap: BookSnapshot = {
      asset, time: data.time, bids, asks,
      bestBid, bestAsk, midPrice, spreadBps,
    };

    this.books.set(asset, snap);
    if (this.onUpdate) this.onUpdate(snap);
  }
}
