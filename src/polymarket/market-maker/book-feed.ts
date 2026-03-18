import WebSocket from 'ws';
import { createChildLogger } from '../../utils/logger.js';
import type { PMMBookSnapshot, PMMBookLevel } from './types.js';

const log = createChildLogger({ component: 'pmm-book-feed' });

interface ClobBookMessage {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
  hash?: string;
}

export class PMMBookFeed {
  private ws: WebSocket | null = null;
  private books: Map<string, PMMBookSnapshot> = new Map();
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private subscribedTokens: Map<string, string> = new Map(); // tokenId -> conditionId
  private onUpdate?: (book: PMMBookSnapshot) => void;
  private wsUrl: string;

  constructor(wsUrl: string, onUpdate?: (book: PMMBookSnapshot) => void) {
    this.wsUrl = wsUrl;
    this.onUpdate = onUpdate;
  }

  start(): void {
    this.stopping = false;
    if (this.subscribedTokens.size > 0) {
      this.connect();
    }
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

  subscribe(tokenId: string, conditionId: string): void {
    this.subscribedTokens.set(tokenId, conditionId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(tokenId);
    }
  }

  unsubscribe(tokenId: string): void {
    this.subscribedTokens.delete(tokenId);
    this.books.delete(tokenId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'unsubscribe',
        channel: 'book',
        assets_ids: [tokenId],
      }));
    }
  }

  getBook(tokenId: string): PMMBookSnapshot | undefined {
    return this.books.get(tokenId);
  }

  getSubscribedCount(): number {
    return this.subscribedTokens.size;
  }

  private sendSubscribe(tokenId: string): void {
    this.ws!.send(JSON.stringify({
      type: 'subscribe',
      channel: 'book',
      assets_ids: [tokenId],
    }));
  }

  private connect(): void {
    if (this.stopping) return;
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      log.info('CLOB book feed WS connected');
      this.reconnectAttempts = 0;
      for (const tokenId of this.subscribedTokens.keys()) {
        this.sendSubscribe(tokenId);
      }
      log.info({ count: this.subscribedTokens.size }, 'Subscribed to CLOB books');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msgs = JSON.parse(data.toString());
        const list = Array.isArray(msgs) ? msgs : [msgs];
        for (const msg of list) {
          if (msg.asset_id && (msg.bids || msg.asks)) {
            this.handleBook(msg as ClobBookMessage);
          }
        }
      } catch { /* ignore malformed */ }
    });

    this.ws.on('close', () => {
      if (!this.stopping) this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      log.warn({ error: err.message }, 'CLOB book feed WS error');
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private handleBook(msg: ClobBookMessage): void {
    const tokenId = msg.asset_id;
    const conditionId = this.subscribedTokens.get(tokenId);
    if (!conditionId) return;

    const bids: PMMBookLevel[] = (msg.bids || [])
      .map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .filter(l => l.size > 0)
      .sort((a, b) => b.price - a.price);
    const asks: PMMBookLevel[] = (msg.asks || [])
      .map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .filter(l => l.size > 0)
      .sort((a, b) => a.price - b.price);

    if (bids.length === 0 || asks.length === 0) return;

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadCents = (bestAsk - bestBid) * 100;

    const snap: PMMBookSnapshot = {
      tokenId,
      conditionId,
      timestamp: msg.timestamp ? parseInt(msg.timestamp, 10) : Date.now(),
      bids,
      asks,
      bestBid,
      bestAsk,
      midPrice,
      spreadCents,
    };

    this.books.set(tokenId, snap);
    if (this.onUpdate) this.onUpdate(snap);
  }
}
