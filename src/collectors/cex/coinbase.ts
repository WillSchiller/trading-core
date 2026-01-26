import { z } from 'zod';
import WebSocket from 'ws';
import { Decimal } from 'decimal.js';
import { CexConnector, type CexConnectorConfig } from './base.js';
import type { NormalizedQuote } from '../../types/index.js';

const CoinbaseTickerSchema = z.object({
  type: z.literal('ticker'),
  product_id: z.string(),
  price: z.string().optional(),
  best_bid: z.string(),
  best_ask: z.string(),
  time: z.string(),
});

const CoinbaseSubscriptionsSchema = z.object({
  type: z.literal('subscriptions'),
  channels: z.array(z.unknown()),
});

const CoinbaseErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  reason: z.string().optional(),
});

const CoinbaseHeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  sequence: z.number(),
  last_trade_id: z.number(),
  product_id: z.string(),
  time: z.string(),
});

export class CoinbaseConnector extends CexConnector {
  private symbolMap: Map<string, string>;

  constructor(pairs: Array<{ symbol: string; canonical: string }>) {
    const config: CexConnectorConfig = {
      venue: 'coinbase',
      wsUrl: 'wss://ws-feed.exchange.coinbase.com',
      pairs: pairs.map((p) => p.symbol),
      heartbeatIntervalMs: 30000,
      heartbeatTimeoutMs: 15000,
    };

    super(config);

    this.symbolMap = new Map(pairs.map((p) => [p.symbol, p.canonical]));
  }

  protected buildWsUrl(): string {
    return this.config.wsUrl;
  }

  protected subscribe(): void {
    const subscribeMsg = {
      type: 'subscribe',
      product_ids: this.config.pairs,
      channels: ['ticker', 'heartbeat'],
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(subscribeMsg));
      this.logger.info({ pairs: this.config.pairs }, 'Subscribed to Coinbase ticker and heartbeat channels');
    }
  }

  protected parseMessage(data: WebSocket.Data): NormalizedQuote | null {
    const receivedAt = new Date();

    try {
      const raw = JSON.parse(data.toString());

      if (raw.type === 'subscriptions') {
        const validated = CoinbaseSubscriptionsSchema.parse(raw);
        this.logger.debug({ channels: validated.channels }, 'Received subscription confirmation');
        return null;
      }

      if (raw.type === 'error') {
        const validated = CoinbaseErrorSchema.parse(raw);
        this.logger.error(
          { message: validated.message, reason: validated.reason },
          'Received error from Coinbase'
        );
        return null;
      }

      if (raw.type === 'heartbeat') {
        const validated = CoinbaseHeartbeatSchema.parse(raw);
        this.lastHeartbeatReceived = new Date();
        this.logger.debug({ product_id: validated.product_id }, 'Received heartbeat');
        return null;
      }

      if (raw.type === 'ticker') {
        this.lastHeartbeatReceived = receivedAt;
        return this.parseTicker(raw, receivedAt);
      }

      return null;
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Failed to parse Coinbase message');
      return null;
    }
  }

  private parseTicker(raw: unknown, receivedAt: Date): NormalizedQuote | null {
    try {
      const validated = CoinbaseTickerSchema.parse(raw);

      const bid = new Decimal(validated.best_bid).toNumber();
      const ask = new Decimal(validated.best_ask).toNumber();
      const mid = new Decimal(validated.best_bid).plus(validated.best_ask).dividedBy(2).toNumber();
      const ts = new Date(validated.time);
      const exchangeTsMs = ts.getTime();
      const receivedTsMs = receivedAt.getTime();
      const latencyMs = Math.max(0, receivedTsMs - exchangeTsMs);

      const canonical = this.symbolMap.get(validated.product_id) || this.normalizeSymbol(validated.product_id);

      return {
        ts,
        venue: 'coinbase',
        pair: canonical,
        bid,
        ask,
        mid,
        latencyMs,
        exchangeTsMs,
        receivedTsMs,
      };
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Invalid ticker format');
      return null;
    }
  }

  protected sendHeartbeat(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.ping();
      this.logger.debug('Sent ping');
    }
  }
}
