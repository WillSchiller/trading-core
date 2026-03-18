import { createChildLogger } from '../../utils/logger.js';
import type { PMMConfig, PMMMarket } from './types.js';

const log = createChildLogger({ component: 'pmm-market-selector' });


interface GammaMarketResponse {
  conditionId: string;
  questionID: string;
  question: string;
  slug: string;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  volume24hr?: number;
  liquidityNum?: number;
  spread?: number;
  endDateIso: string;
  active: boolean;
  closed: boolean;
  negRisk: boolean;
  feesEnabled?: boolean;
  feeType?: string | null;
  events?: Array<{ slug: string }>;
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

        const tokenIds: string[] = JSON.parse(m.clobTokenIds || '[]');
        const outcomes: string[] = JSON.parse(m.outcomes || '[]');
        if (tokenIds.length < 2 || outcomes.length < 2) continue;

        const volume24h = m.volume24hr || 0;
        const liquidity = m.liquidityNum || 0;
        const spreadCents = (m.spread || 0) * 100;
        const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
        const midPrice = prices[0] || 0;
        const endDate = m.endDateIso || '';
        const endMs = endDate ? new Date(endDate).getTime() : 0;
        const hoursToResolution = endMs > 0 ? (endMs - now) / 3600_000 : Infinity;

        if (volume24h < this.config.minVolume24h) continue;
        if (liquidity < 10_000) continue;
        if (spreadCents > 10) continue;
        if (hoursToResolution < 24) continue;
        if (midPrice < 0.10 || midPrice > 0.90) continue;
        if (m.feesEnabled) continue;

        const volumeScore = Math.min(volume24h / 500_000, 1) * 40;
        const spreadScore = (1 - (spreadCents - 2) / 8) * 30;
        const liquidityScore = Math.min(liquidity / 100_000, 1) * 20;
        const timeScore = Math.min(hoursToResolution / 168, 1) * 10;
        const score = volumeScore + spreadScore + liquidityScore + timeScore;

        const yesIdx = outcomes.indexOf('Yes');
        const noIdx = outcomes.indexOf('No');
        const yesTokenId = tokenIds[yesIdx >= 0 ? yesIdx : 0];
        const noTokenId = tokenIds[noIdx >= 0 ? noIdx : 1];

        candidates.push({
          conditionId: m.conditionId,
          questionId: m.questionID,
          question: m.question,
          slug: m.slug,
          outcomes,
          tokens: tokenIds.map((id, i) => ({ tokenId: id, outcome: outcomes[i] || `outcome_${i}` })),
          yesTokenId,
          noTokenId,
          midPrice,
          volume24h,
          liquidity,
          spreadCents,
          endDate,
          active: m.active,
          negRisk: m.negRisk,
          score,
          feeSchedule: m.feeType || undefined,
        });
      }

      candidates.sort((a, b) => b.score - a.score);
      this.markets = candidates;

      if (candidates.length === 0 && raw.length > 0) {
        const sample = raw.slice(0, 3).map(m => ({
          slug: m.slug?.slice(0, 30),
          vol: m.volume24hr || 0,
          liq: m.liquidityNum || 0,
          spread: ((m.spread || 0) * 100).toFixed(1),
          mid: (JSON.parse(m.outcomePrices || '[]')[0] || 0),
          end: m.endDateIso?.slice(0, 10),
          fees: m.feesEnabled,
        }));
        log.warn({ total: raw.length, sample }, 'No markets passed filters — sample of rejected');
      }

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
