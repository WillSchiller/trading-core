import { createChildLogger } from '../../utils/logger.js';
import type { PMMConfig, PMMMarket } from './types.js';

const log = createChildLogger({ component: 'pmm-market-selector' });

// Tags/categories that tend to have maker fees or poor dynamics for A-S
const AVOID_TAGS = ['crypto', 'ncaab', 'seriea'];

interface GammaMarketResponse {
  condition_id: string;
  question_id: string;
  question: string;
  slug: string;
  outcomes: string;
  outcome_prices: string;
  tokens: Array<{ token_id: string; outcome: string }>;
  volume_num_24hr?: number;
  liquidity_num?: number;
  spread_num?: number;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  neg_risk: boolean;
  tags?: Array<{ slug: string }>;
  fee_schedule?: string;
}

export class MarketSelector {
  private config: PMMConfig;
  private scanTimer: NodeJS.Timeout | null = null;
  private markets: PMMMarket[] = [];

  constructor(config: PMMConfig) {
    this.config = config;
  }

  startScanning(intervalMs = 3600_000): void {
    this.scan().catch(e => log.error({ err: e }, 'Initial market scan failed'));
    this.scanTimer = setInterval(
      () => this.scan().catch(e => log.error({ err: e }, 'Market scan failed')),
      intervalMs,
    );
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  getTopMarkets(n: number): PMMMarket[] {
    return this.markets.slice(0, n);
  }

  async scan(): Promise<PMMMarket[]> {
    try {
      const url = `${this.config.gammaApiUrl}/markets?active=true&closed=false&limit=200&order=volume24hr&ascending=false`;
      const resp = await fetch(url);
      if (!resp.ok) {
        log.warn({ status: resp.status }, 'Gamma API fetch failed');
        return this.markets;
      }
      const raw = await resp.json() as GammaMarketResponse[];

      const candidates: PMMMarket[] = [];
      const now = Date.now();

      for (const m of raw) {
        if (!m.active || m.closed) continue;
        if (!m.tokens || m.tokens.length < 2) continue;

        const volume24h = m.volume_num_24hr || 0;
        const liquidity = m.liquidity_num || 0;
        const spreadCents = (m.spread_num || 0) * 100;
        const prices = JSON.parse(m.outcome_prices || '[]').map(Number);
        const midPrice = prices[0] || 0;
        const endDate = m.end_date_iso;
        const endMs = endDate ? new Date(endDate).getTime() : 0;
        const hoursToResolution = endMs > 0 ? (endMs - now) / 3600_000 : Infinity;

        // Filter: volume
        if (volume24h < this.config.minVolume24h) continue;
        // Filter: liquidity
        if (liquidity < 10_000) continue;
        // Filter: spread range (2-10 cents)
        if (spreadCents < 2 || spreadCents > 10) continue;
        // Filter: time to resolution
        if (hoursToResolution < 24) continue;
        // Filter: price range
        if (midPrice < 0.10 || midPrice > 0.90) continue;
        // Filter: avoid fee-heavy categories
        const tags = (m.tags || []).map(t => t.slug.toLowerCase());
        if (tags.some(t => AVOID_TAGS.some(avoid => t.includes(avoid)))) continue;
        // Prefer zero-fee markets
        if (m.fee_schedule && m.fee_schedule !== 'default') continue;

        // Scoring: prefer high volume, tight spread, moderate liquidity, sports with action
        const volumeScore = Math.min(volume24h / 500_000, 1) * 40;
        const spreadScore = (1 - (spreadCents - 2) / 8) * 30;
        const liquidityScore = Math.min(liquidity / 100_000, 1) * 20;
        const timeScore = Math.min(hoursToResolution / 168, 1) * 10; // prefer 1w+ horizon
        const score = volumeScore + spreadScore + liquidityScore + timeScore;

        const yesToken = m.tokens.find(t => t.outcome === 'Yes') || m.tokens[0];
        const noToken = m.tokens.find(t => t.outcome === 'No') || m.tokens[1];

        candidates.push({
          conditionId: m.condition_id,
          questionId: m.question_id,
          question: m.question,
          slug: m.slug,
          outcomes: m.outcomes ? JSON.parse(m.outcomes) : ['Yes', 'No'],
          tokens: m.tokens.map(t => ({ tokenId: t.token_id, outcome: t.outcome })),
          yesTokenId: yesToken.token_id,
          noTokenId: noToken.token_id,
          midPrice,
          volume24h,
          liquidity,
          spreadCents,
          endDate,
          active: m.active,
          negRisk: m.neg_risk,
          score,
          feeSchedule: m.fee_schedule,
        });
      }

      candidates.sort((a, b) => b.score - a.score);
      this.markets = candidates;

      log.info({
        total: raw.length,
        filtered: candidates.length,
        top5: candidates.slice(0, 5).map(m => ({
          slug: m.slug.slice(0, 40),
          score: m.score.toFixed(1),
          vol: m.volume24h.toFixed(0),
          spread: m.spreadCents.toFixed(1),
          mid: m.midPrice.toFixed(2),
        })),
      }, 'Market scan complete');

      return candidates;
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Market scan error');
      return this.markets;
    }
  }
}
