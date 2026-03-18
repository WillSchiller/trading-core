import WebSocket from 'ws';
import { createChildLogger } from '../../utils/logger.js';
import type { PMMBookSnapshot, PMMBookLevel } from './types.js';

const log = createChildLogger({ component: 'pmm-book-feed' });

interface ClobBookMessage {
  event_type: string;
  market?: string;
  asset_id: string;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  timestamp?: string;
  hash?: string;
  price?: string;
  side?: string;
  size?: string;
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
    } else if (!this.ws && !this.stopping) {
      this.connect();
    }
  }

  unsubscribe(tokenId: string): void {
    this.subscribedTokens.delete(tokenId);
    this.books.delete(tokenId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        assets_ids: [tokenId],
        type: 'market',
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
      assets_ids: [tokenId],
      type: 'market',
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

    let msgCount = 0;
    let bookCount = 0;
    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msgs = JSON.parse(data.toString());
        const list = Array.isArray(msgs) ? msgs : [msgs];
        for (const msg of list) {
          msgCount++;
          if (msgCount <= 3 || msgCount % 1000 === 0) {
            log.info({ msgCount, keys: Object.keys(msg).slice(0, 8), eventType: msg.event_type }, 'WS message sample');
          }
          if (!msg.event_type) continue;
          if (msg.event_type === 'book' && msg.asset_id) {
            bookCount++;
            this.handleBook(msg as ClobBookMessage);
            if (bookCount <= 3) log.info({ tokenId: msg.asset_id?.slice(0, 12), bids: msg.bids?.length, asks: msg.asks?.length }, 'Book snapshot received');
          } else if (msg.event_type === 'price_change' && msg.asset_id) {
            this.handlePriceChange(msg as ClobBookMessage);
          } else if (msg.event_type === 'last_trade_price' && msg.asset_id) {
            this.handleLastTrade(msg as ClobBookMessage);
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

  private handlePriceChange(msg: ClobBookMessage): void {
    const tokenId = msg.asset_id;
    const book = this.books.get(tokenId);
    if (!book) return;

    if (msg.price && msg.side && msg.size !== undefined) {
      const price = parseFloat(msg.price);
      const size = parseFloat(msg.size!);
      const levels = msg.side === 'BUY' ? book.bids : book.asks;

      const idx = levels.findIndex(l => l.price === price);
      if (size === 0) {
        if (idx >= 0) levels.splice(idx, 1);
      } else if (idx >= 0) {
        levels[idx].size = size;
      } else {
        levels.push({ price, size });
        if (msg.side === 'BUY') levels.sort((a, b) => b.price - a.price);
        else levels.sort((a, b) => a.price - b.price);
      }

      if (book.bids.length > 0 && book.asks.length > 0) {
        book.bestBid = book.bids[0].price;
        book.bestAsk = book.asks[0].price;
        book.midPrice = (book.bestBid + book.bestAsk) / 2;
        book.spreadCents = (book.bestAsk - book.bestBid) * 100;
        book.timestamp = Date.now();
        if (this.onUpdate) this.onUpdate(book);
      }
    }
  }

  private handleLastTrade(_msg: ClobBookMessage): void {
    // Trade data for flow analysis — onUpdate already fires from book/price_change
  }
}
