import { z } from 'zod';
import WebSocket from 'ws';
import { Decimal } from 'decimal.js';
import { CexConnector, type CexConnectorConfig } from './base.js';
import type { NormalizedQuote } from '../../types/index.js';

const HyperliquidAllMidsSchema = z.object({
  channel: z.literal('allMids'),
  data: z.object({
    mids: z.record(z.string(), z.string()),
  }),
});

export class HyperliquidCexConnector extends CexConnector {
  private assetMap: Map<string, string>;
  private assets: string[];

  constructor(pairs: Array<{ symbol: string; canonical: string }>) {
    const config: CexConnectorConfig = {
      venue: 'hyperliquid',
      wsUrl: 'wss://api.hyperliquid.xyz/ws',
      pairs: pairs.map((p) => p.symbol),
      heartbeatIntervalMs: 30000,
      heartbeatTimeoutMs: 15000,
    };

    super(config);

    this.assetMap = new Map(pairs.map((p) => [p.symbol.toUpperCase(), p.canonical]));
    this.assets = pairs.map((p) => p.symbol.toUpperCase());
  }

  protected buildWsUrl(): string {
    return this.config.wsUrl;
  }

  protected subscribe(): void {
    const subscribeMsg = {
      method: 'subscribe',
      subscription: { type: 'allMids' },
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(subscribeMsg));
      this.logger.info({ assets: this.assets }, 'Subscribed to Hyperliquid allMids');
    }
  }

  protected parseMessage(data: WebSocket.Data): NormalizedQuote | null {
    const receivedAt = new Date();

    try {
      const raw = JSON.parse(data.toString());

      this.lastHeartbeatReceived = receivedAt;

      if (raw.channel === 'subscriptionResponse') {
        this.logger.debug('Received subscription confirmation');
        return null;
      }

      if (raw.channel === 'pong') {
        return null;
      }

      if (raw.channel === 'allMids') {
        this.parseAllMids(raw, receivedAt);
        return null;
      }

      return null;
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Failed to parse Hyperliquid message');
      return null;
    }
  }

  private parseAllMids(raw: unknown, receivedAt: Date): void {
    try {
      const validated = HyperliquidAllMidsSchema.parse(raw);
      const mids = validated.data.mids;
      const receivedTsMs = receivedAt.getTime();

      for (const asset of this.assets) {
        const midStr = mids[asset];
        if (!midStr) continue;

        const mid = new Decimal(midStr).toNumber();
        if (mid <= 0) continue;

        const canonical = this.assetMap.get(asset);
        if (!canonical) continue;

        const quote: NormalizedQuote = {
          ts: receivedAt,
          venue: 'hyperliquid',
          pair: canonical,
          mid,
          latencyMs: 0,
          exchangeTsMs: receivedTsMs,
          receivedTsMs,
        };

        this.emit('quote', quote);
      }
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Invalid allMids format');
    }
  }

  protected sendHeartbeat(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'ping' }));
      this.logger.debug('Sent ping');
    }
  }
}
