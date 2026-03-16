import pg from 'pg';
import { createChildLogger } from '../utils/logger.js';
import { PolymarketPersistence } from './persistence.js';
import type { PolymarketConfig, ShadowTrade } from './types.js';

const log = createChildLogger({ component: 'pm-backfill' });

interface RawTrade {
  transactionHash?: string;
  proxyWallet?: string;
  side?: string;
  asset?: string;
  conditionId?: string;
  size?: string | number;
  price?: string | number;
  timestamp?: string | number;
  title?: string;
  slug?: string;
  outcome?: string;
  outcomeIndex?: number;
}

interface MarketData {
  conditionId?: string;
  closed?: boolean;
  outcomePrices?: string;
  clobTokenIds?: string;
  question?: string;
}

export class TraderBackfill {
  constructor(
    private readonly config: PolymarketConfig,
    private readonly persistence: PolymarketPersistence,
    private readonly pool: pg.Pool,
  ) {}

  async backfillTrader(address: string, alias: string, bankrollEstimate: number): Promise<number> {
    log.info({ address: address.slice(0, 10), alias }, 'Starting backfill');

    const trades = await this.fetchAllTrades(address);
    log.info({ address: address.slice(0, 10), totalTrades: trades.length }, 'Fetched trade history');

    const buys = trades.filter(t => t.side === 'BUY' && Number(t.price || 0) > 0);
    log.info({ buys: buys.length }, 'Filtered BUY trades');

    const bySlug = new Map<string, RawTrade[]>();
    for (const t of buys) {
      const slug = t.slug || '';
      if (!slug) continue;
      const list = bySlug.get(slug) || [];
      list.push(t);
      bySlug.set(slug, list);
    }

    let saved = 0;
    let skipped = 0;

    for (const [slug, slugTrades] of bySlug) {
      let market: MarketData | null = null;
      try {
        market = await this.fetchMarketBySlug(slug);
        await this.delay(200);
      } catch (err) {
        log.warn({ slug, error: (err as Error).message }, 'Failed to fetch market');
        continue;
      }

      for (const raw of slugTrades) {
        const timestamp = Number(raw.timestamp || 0) * 1000;
        const size = Number(raw.size || 0);
        const price = Number(raw.price || 0);
        const tokenId = raw.asset || '';
        const conditionId = raw.conditionId || '';

        const exists = await this.tradeExists(address, conditionId, tokenId, 'BUY', timestamp);
        if (exists) { skipped++; continue; }

        const proportionalSize = (size / Math.max(bankrollEstimate, 1)) * this.config.bankrollUsd;
        const ourSize = Math.min(proportionalSize, this.config.riskLimits.maxPositionUsd);

        let resolved = false;
        let resolutionPrice: number | undefined;
        let pnl: number | undefined;
        let currentPrice: number | null = price;

        if (market) {
          if (market.closed) {
            resolved = true;
            resolutionPrice = this.getResolutionPrice(market, tokenId);
            pnl = (resolutionPrice - price) * ourSize;
          } else {
            currentPrice = this.getTokenPrice(market, tokenId) ?? price;
            pnl = (currentPrice - price) * ourSize;
          }
        }

        const shadow: ShadowTrade = {
          traderAddress: address,
          traderAlias: alias,
          conditionId,
          tokenId,
          side: 'BUY',
          size,
          price,
          outcome: raw.outcome || '',
          marketSlug: slug,
          marketQuestion: raw.title || market?.question || '',
          negRisk: false,
          ourSize,
          ourEntryPrice: price,
          currentPrice,
          traderTimestamp: timestamp,
        };

        try {
          const id = await this.persistence.saveShadowTrade(shadow);
          if (resolved && resolutionPrice !== undefined && pnl !== undefined) {
            await this.persistence.resolveShadowTrade(id, resolutionPrice, pnl);
          } else if (pnl !== undefined) {
            await this.persistence.updateShadowPrice(id, currentPrice!, pnl);
          }
          saved++;
        } catch (err) {
          if ((err as Error).message?.includes('idx_pm_shadow_dedup')) {
            skipped++;
          } else {
            log.warn({ error: (err as Error).message, slug }, 'Failed to save shadow trade');
          }
        }
      }
    }

    await this.markBackfilled(address);
    log.info({ address: address.slice(0, 10), alias, saved, skipped, markets: bySlug.size }, 'Backfill complete');
    return saved;
  }

  async isTraderBackfilled(address: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT backfilled_at FROM pm_tracked_traders WHERE address = $1 AND backfilled_at IS NOT NULL`,
      [address],
    );
    return result.rows.length > 0;
  }

  private async markBackfilled(address: string): Promise<void> {
    await this.pool.query(
      `UPDATE pm_tracked_traders SET backfilled_at = NOW() WHERE address = $1`,
      [address],
    );
  }

  private async fetchAllTrades(address: string): Promise<RawTrade[]> {
    const all: RawTrade[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const url = `${this.config.dataApiUrl}/trades?user=${address}&limit=${limit}&offset=${offset}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Trades API ${resp.status}`);

      const page = await resp.json() as RawTrade[];
      if (page.length === 0) break;

      all.push(...page);
      offset += limit;
      await this.delay(100);

      if (page.length < limit) break;
    }

    return all;
  }

  private async tradeExists(address: string, conditionId: string, tokenId: string, side: string, timestamp: number): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM pm_shadow_trades WHERE trader_address = $1 AND condition_id = $2 AND token_id = $3 AND side = $4 AND trader_timestamp = $5 LIMIT 1`,
      [address, conditionId, tokenId, side, timestamp],
    );
    return result.rows.length > 0;
  }

  private async fetchMarketBySlug(slug: string): Promise<MarketData | null> {
    const url = `${this.config.gammaApiUrl}/markets?slug=${slug}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json() as MarketData[];
    return data[0] ?? null;
  }

  private getTokenPrice(market: MarketData, tokenId: string): number | null {
    const prices = (JSON.parse(market.outcomePrices || '[]') as (string | number)[]).map(Number);
    const tokenIds = JSON.parse(market.clobTokenIds || '[]') as string[];
    const idx = tokenIds.indexOf(tokenId);
    const price = idx >= 0 ? prices[idx] : null;
    return (price != null && price > 0 && !isNaN(price)) ? price : null;
  }

  private getResolutionPrice(market: MarketData, tokenId: string): number {
    const prices = (JSON.parse(market.outcomePrices || '[]') as (string | number)[]).map(Number);
    const tokenIds = JSON.parse(market.clobTokenIds || '[]') as string[];
    const idx = tokenIds.indexOf(tokenId);
    if (idx >= 0 && !isNaN(prices[idx])) return prices[idx];
    return 0;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
