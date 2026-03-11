import { createChildLogger } from '../../utils/logger.js';
import type { FundingArbConfig, FundingOpportunity } from './types.js';

const log = createChildLogger({ component: 'funding-scanner' });

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const HOURS_PER_YEAR = 8760;

interface PerpMeta { name: string; szDecimals: number; maxLeverage: number }
interface AssetCtx { funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; premium: string; oraclePx: string; markPx: string; midPx?: string }
interface SpotToken { name: string; szDecimals: number; index: number }
interface SpotPair { tokens: number[]; name: string; index: number; isCanonical: boolean }

export class FundingScanner {
  private config: FundingArbConfig;
  private tokenIndex = new Map<number, string>();
  private spotBaseToId = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScan: FundingOpportunity[] = [];

  constructor(config: FundingArbConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    await this.refreshMetadata();
    await this.scan();
    this.timer = setInterval(() => this.scan().catch(e => log.error({ err: e }, 'Scan error')), this.config.scanIntervalMs);
    log.info({ intervalMs: this.config.scanIntervalMs, spotPairs: this.spotBaseToId.size }, 'Funding scanner started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getOpportunities(): FundingOpportunity[] {
    return this.lastScan;
  }

  getBestOpportunity(): FundingOpportunity | null {
    return this.lastScan[0] ?? null;
  }

  getOpportunityForAsset(asset: string): FundingOpportunity | null {
    return this.lastScan.find(o => o.asset === asset) ?? null;
  }

  private async refreshMetadata(): Promise<void> {
    const spotMeta = await this.hlPost({ type: 'spotMeta' });
    this.tokenIndex.clear();
    for (const t of (spotMeta.tokens as SpotToken[])) {
      this.tokenIndex.set(t.index, t.name);
    }
    this.spotBaseToId.clear();
    for (const pair of (spotMeta.universe as SpotPair[])) {
      if (pair.tokens.length < 2) continue;
      const baseName = this.tokenIndex.get(pair.tokens[0]);
      const quoteName = this.tokenIndex.get(pair.tokens[1]);
      if (baseName && quoteName === 'USDC') {
        this.spotBaseToId.set(baseName, 10000 + pair.index);
      }
    }
    log.info({ spotUsdcPairs: this.spotBaseToId.size }, 'Metadata refreshed');
  }

  async scan(): Promise<FundingOpportunity[]> {
    const [metaAndCtx, predicted] = await Promise.all([
      this.hlPost({ type: 'metaAndAssetCtxs' }),
      this.hlPost({ type: 'predictedFundings' }),
    ]);

    const perpCtxs: AssetCtx[] = metaAndCtx[1];
    const universe: PerpMeta[] = metaAndCtx[0].universe;

    // predictedFundings: [[coin, [[exchange, {fundingRate, ...}], ...]], ...]
    const predictedMap = new Map<string, number>();
    if (Array.isArray(predicted)) {
      for (const entry of predicted) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const coin = entry[0] as string;
        const venues = entry[1] as Array<[string, { fundingRate: string; fundingIntervalHours: number }]>;
        // Find HlPerp rate
        for (const [venue, data] of venues) {
          if (venue === 'HlPerp' && data?.fundingRate) {
            predictedMap.set(coin, parseFloat(data.fundingRate));
            break;
          }
        }
      }
    }

    const opportunities: FundingOpportunity[] = [];

    for (let i = 0; i < universe.length; i++) {
      const asset = universe[i].name;
      const ctx = perpCtxs[i];
      if (!ctx) continue;

      if (this.config.spotAssetWhitelist?.length && !this.config.spotAssetWhitelist.includes(asset)) continue;

      const currentRate = parseFloat(ctx.funding);
      const predictedRate = predictedMap.get(asset) ?? currentRate;
      const perpMid = parseFloat(ctx.midPx ?? ctx.markPx ?? '0');
      if (perpMid <= 0) continue;

      // For funding arb (short perp): positive funding = we receive
      if (currentRate <= 0 && predictedRate <= 0) continue;

      const avgRate = (currentRate + predictedRate) / 2;
      const annualizedPct = avgRate * HOURS_PER_YEAR * 100;
      const annualizedAfterFeesPct = annualizedPct;

      // Break-even: perp entry+exit fees only (spot fees only if hedged)
      const perpFeeBps = this.config.useMakerOrders ? this.config.makerFeeBps : this.config.takerFeeBps;
      const entryExitFeeBps = perpFeeBps * 2;
      const breakEvenHours = entryExitFeeBps > 0 && avgRate > 0
        ? (entryExitFeeBps / 10000) / avgRate
        : Infinity;

      const hasSpot = this.spotBaseToId.has(asset);
      const spotAssetId = this.spotBaseToId.get(asset) ?? 0;

      opportunities.push({
        asset,
        perpAssetIndex: i,
        spotAssetId,
        currentFundingRate: currentRate,
        predictedFundingRate: predictedRate,
        annualizedPct,
        annualizedAfterFeesPct,
        breakEvenHours,
        spotMidPrice: 0, // populated separately if needed
        perpMidPrice: perpMid,
        basisBps: 0,
        spotVolume24h: 0,
        hasSpot,
        timestamp: Date.now(),
      });
    }

    opportunities.sort((a, b) => b.annualizedPct - a.annualizedPct);
    this.lastScan = opportunities;

    if (opportunities.length > 0) {
      log.info({
        total: opportunities.length,
        top: opportunities.slice(0, 10).map(o => ({
          asset: o.asset,
          apy: `${o.annualizedPct.toFixed(1)}%`,
          rate: o.currentFundingRate.toFixed(6),
          predicted: o.predictedFundingRate.toFixed(6),
          breakEven: `${o.breakEvenHours.toFixed(1)}h`,
          hasSpot: o.hasSpot,
        })),
      }, 'Funding scan complete');
    }

    return opportunities;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async hlPost(body: Record<string, unknown>): Promise<any> {
    const resp = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HL API error: ${resp.status} ${await resp.text()}`);
    return resp.json();
  }
}
