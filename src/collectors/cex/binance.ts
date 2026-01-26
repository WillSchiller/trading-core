import { z } from 'zod';
import WebSocket from 'ws';
import { Decimal } from 'decimal.js';
import { CexConnector, type CexConnectorConfig } from './base.js';
import type { NormalizedQuote } from '../../types/index.js';

const BinanceBookTickerSchema = z.object({
  u: z.number(),
  s: z.string(),
  b: z.string(),
  B: z.string(),
  a: z.string(),
  A: z.string(),
  E: z.number().optional(),
});

export class BinanceConnector extends CexConnector {
  private symbolMap: Map<string, string>;

  constructor(pairs: Array<{ symbol: string; canonical: string }>) {
    const config: CexConnectorConfig = {
      venue: 'binance',
      wsUrl: 'wss://stream.binance.com:9443/ws',
      pairs: pairs.map((p) => p.symbol.toLowerCase()),
    };

    super(config);

    this.symbolMap = new Map(pairs.map((p) => [p.symbol.toUpperCase(), p.canonical]));
  }

  protected buildWsUrl(): string {
    const streams = this.config.pairs.map((symbol) => `${symbol}@bookTicker`).join('/');
    return `wss://stream.binance.com:9443/stream?streams=${streams}`;
  }

  protected subscribe(): void {
    this.logger.info({ pairs: this.config.pairs }, 'Subscribed to Binance bookTicker streams');
  }

  protected parseMessage(data: WebSocket.Data): NormalizedQuote | null {
    const receivedAt = new Date();

    this.lastHeartbeatReceived = receivedAt;

    try {
      const raw = JSON.parse(data.toString());

      if (raw.stream && raw.data) {
        return this.parseBookTicker(raw.data, receivedAt);
      }

      return this.parseBookTicker(raw, receivedAt);
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Failed to parse Binance message');
      return null;
    }
  }

  private parseBookTicker(raw: unknown, receivedAt: Date): NormalizedQuote | null {
    try {
      const validated = BinanceBookTickerSchema.parse(raw);

      const bid = new Decimal(validated.b).toNumber();
      const ask = new Decimal(validated.a).toNumber();
      const mid = new Decimal(validated.b).plus(validated.a).dividedBy(2).toNumber();

      const canonical = this.symbolMap.get(validated.s) || this.normalizeSymbol(validated.s);

      const receivedTsMs = receivedAt.getTime();
      const exchangeTsMs = validated.E;
      const latencyMs = exchangeTsMs ? Math.max(0, receivedTsMs - exchangeTsMs) : 0;

      return {
        ts: receivedAt,
        venue: 'binance',
        pair: canonical,
        bid,
        ask,
        mid,
        latencyMs,
        exchangeTsMs,
        receivedTsMs,
      };
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Invalid bookTicker format');
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
