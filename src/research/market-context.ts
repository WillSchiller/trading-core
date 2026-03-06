import type { Pool } from 'pg';
import { createChildLogger, type Logger } from '../utils/logger.js';

export interface AssetContext {
  funding: number;
  openInterest: number;
  dayNtlVlm: number;
  premium: number;
  oraclePx: number;
  markPx: number;
}

export class MarketContextService {
  private pool: Pool;
  private logger: Logger;
  private context: Map<string, AssetContext> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private assets: Set<string>;
  private lastSnapshot: number = 0;
  private snapshotIntervalMs: number;

  constructor(pool: Pool, assets: string[], snapshotIntervalMs = 300000) {
    this.pool = pool;
    this.logger = createChildLogger({ component: 'market-context' });
    this.assets = new Set(assets);
    this.snapshotIntervalMs = snapshotIntervalMs;
  }

  async start(pollIntervalMs = 60000): Promise<void> {
    await this.poll();
    this.pollInterval = setInterval(() => this.poll(), pollIntervalMs);
    this.logger.info({ assets: this.assets.size, pollIntervalMs }, 'Market context service started');
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  getContext(asset: string): AssetContext | undefined {
    return this.context.get(asset);
  }

  getContextSnapshot(asset: string): Record<string, number> | null {
    const ctx = this.context.get(asset);
    if (!ctx) return null;
    return {
      funding: ctx.funding,
      openInterest: ctx.openInterest,
      dayNtlVlm: ctx.dayNtlVlm,
      premium: ctx.premium,
      oraclePx: ctx.oraclePx,
      markPx: ctx.markPx,
    };
  }

  private async poll(): Promise<void> {
    try {
      const resp = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });

      if (!resp.ok) {
        this.logger.warn({ status: resp.status }, 'Failed to fetch metaAndAssetCtxs');
        return;
      }

      const data = await resp.json() as [{ universe: Array<{ name: string }> }, Array<Record<string, string>>];
      const universe = data[0].universe;
      const ctxs = data[1];

      let updated = 0;
      for (let i = 0; i < universe.length && i < ctxs.length; i++) {
        const name = universe[i].name;
        if (!this.assets.has(name)) continue;

        const raw = ctxs[i];
        this.context.set(name, {
          funding: parseFloat(raw.funding) || 0,
          openInterest: parseFloat(raw.openInterest) || 0,
          dayNtlVlm: parseFloat(raw.dayNtlVlm) || 0,
          premium: parseFloat(raw.premium) || 0,
          oraclePx: parseFloat(raw.oraclePx) || 0,
          markPx: parseFloat(raw.markPx) || 0,
        });
        updated++;
      }

      this.logger.debug({ updated }, 'Market context updated');

      const now = Date.now();
      if (now - this.lastSnapshot >= this.snapshotIntervalMs) {
        this.lastSnapshot = now;
        await this.saveSnapshot(now);
      }
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Market context poll failed');
    }
  }

  private async saveSnapshot(ts: number): Promise<void> {
    const entries = Array.from(this.context.entries()).filter(([asset]) => this.assets.has(asset));
    if (entries.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const [asset, ctx] of entries) {
      placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`);
      values.push(ts, asset, ctx.funding, ctx.openInterest, ctx.dayNtlVlm, ctx.premium, ctx.oraclePx, ctx.markPx);
      idx += 8;
    }

    try {
      await this.pool.query(
        `INSERT INTO market_context_snapshots (timestamp, asset, funding_rate, open_interest, day_ntl_vlm, premium, oracle_px, mark_px)
         VALUES ${placeholders.join(', ')}`,
        values
      );
      this.logger.debug({ count: entries.length }, 'Market context snapshot saved');
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Failed to save market context snapshot');
    }
  }
}
