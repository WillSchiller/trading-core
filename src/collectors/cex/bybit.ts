import { z } from 'zod';
import WebSocket from 'ws';
import { CexConnector, type CexConnectorConfig } from './base.js';
import type { NormalizedQuote } from '../../types/index.js';

const BybitOrderbookDataSchema = z.object({
  s: z.string(),
  b: z.array(z.tuple([z.string(), z.string()])),
  a: z.array(z.tuple([z.string(), z.string()])),
  u: z.number(),
  seq: z.number(),
});

const BybitOrderbookSchema = z.object({
  topic: z.string(),
  type: z.literal('snapshot'),
  data: BybitOrderbookDataSchema,
  ts: z.number(),
  cts: z.number().optional(),
});

const BybitSuccessSchema = z.object({
  success: z.boolean(),
  ret_msg: z.string().optional(),
  conn_id: z.string().optional(),
  op: z.string().optional(),
});

const BybitPongSchema = z.object({
  success: z.literal(true),
  ret_msg: z.literal('pong'),
  op: z.literal('ping'),
  conn_id: z.string(),
});

export class BybitConnector extends CexConnector {
  private symbolMap: Map<string, string>;

  constructor(pairs: Array<{ symbol: string; canonical: string }>) {
    const config: CexConnectorConfig = {
      venue: 'bybit',
      wsUrl: 'wss://stream.bybit.com/v5/public/spot',
      pairs: pairs.map((p) => p.symbol),
      heartbeatIntervalMs: 20000,
      heartbeatTimeoutMs: 10000,
    };

    super(config);

    this.symbolMap = new Map(pairs.map((p) => [p.symbol.toUpperCase(), p.canonical]));
  }

  protected buildWsUrl(): string {
    return this.config.wsUrl;
  }

  protected subscribe(): void {
    const subscribeMsg = {
      op: 'subscribe',
      args: this.config.pairs.map((symbol) => `orderbook.1.${symbol.toUpperCase()}`),
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(subscribeMsg));
      this.logger.info({ pairs: this.config.pairs }, 'Subscribed to Bybit orderbook.1 channel');
    }
  }

  protected parseMessage(data: WebSocket.Data): NormalizedQuote | null {
    const receivedAt = new Date();

    try {
      const raw = JSON.parse(data.toString());

      this.lastHeartbeatReceived = receivedAt;

      if (raw.success !== undefined && raw.ret_msg === 'pong') {
        BybitPongSchema.parse(raw);
        this.logger.debug('Received pong');
        return null;
      }

      if (raw.success !== undefined) {
        const validated = BybitSuccessSchema.parse(raw);
        if (validated.success) {
          this.logger.debug('Received subscription confirmation');
        } else {
          this.logger.warn({ ret_msg: validated.ret_msg }, 'Subscription failed');
        }
        return null;
      }

      if (raw.topic && raw.topic.startsWith('orderbook.1.')) {
        return this.parseOrderbook(raw, receivedAt);
      }

      return null;
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Failed to parse Bybit message');
      return null;
    }
  }

  private parseOrderbook(raw: unknown, receivedAt: Date): NormalizedQuote | null {
    try {
      const validated = BybitOrderbookSchema.parse(raw);

      if (validated.data.b.length === 0 || validated.data.a.length === 0) {
        return null;
      }

      const bid = parseFloat(validated.data.b[0][0]);
      const ask = parseFloat(validated.data.a[0][0]);

      if (bid === 0 || ask === 0) {
        return null;
      }

      const mid = (bid + ask) / 2;
      const ts = new Date(validated.ts);
      const exchangeTsMs = validated.ts;
      const receivedTsMs = receivedAt.getTime();
      const latencyMs = Math.max(0, receivedTsMs - exchangeTsMs);

      const canonical = this.symbolMap.get(validated.data.s) || this.normalizeSymbol(validated.data.s);

      return {
        ts,
        venue: 'bybit',
        pair: canonical,
        bid,
        ask,
        mid,
        latencyMs,
        exchangeTsMs,
        receivedTsMs,
      };
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Invalid orderbook format');
      return null;
    }
  }

  protected sendHeartbeat(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const pingMsg = { op: 'ping' };
      this.ws.send(JSON.stringify(pingMsg));
      this.logger.debug('Sent ping');
    }
  }
}
