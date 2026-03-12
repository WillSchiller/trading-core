import { createChildLogger } from '../../utils/logger.js';
import type { FundingArbConfig, FundingOpportunity } from './types.js';

const log = createChildLogger({ component: 'funding-scanner' });

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const BINANCE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';
const HOURS_PER_YEAR = 8760;

interface PerpMeta { name: string; szDecimals: number; maxLeverage: number }
interface AssetCtx { funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; premium: string; oraclePx: string; markPx: string; midPx?: string }

interface RateHistory {
  rates: number[];       // rolling window of hourly rates
  timestamps: number[];
}

export class FundingScanner {
  private config: FundingArbConfig;
  private binanceSpotSymbols = new Map<string, string>();
  private rateHistory = new Map<string, RateHistory>(); // asset → rolling rate history
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScan: FundingOpportunity[] = [];

  private static readonly HISTORY_WINDOW = 60; // keep last 60 samples (1hr at 1min scan)

  constructor(config: FundingArbConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    await this.refreshBinanceSpot();
    await this.scan();
    this.timer = setInterval(() => this.scan().catch(e => log.error({ err: e }, 'Scan error')), this.config.scanIntervalMs);
    log.info({ intervalMs: this.config.scanIntervalMs, binanceSpotPairs: this.binanceSpotSymbols.size }, 'Funding scanner started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getOpportunities(): FundingOpportunity[] {
    return this.lastScan;
  }

  getOpportunityForAsset(asset: string): FundingOpportunity | null {
    return this.lastScan.find(o => o.asset === asset) ?? null;
  }

  private hlToBinanceBase(hlAsset: string): string {
    return hlAsset.startsWith('k') ? hlAsset.slice(1) : hlAsset;
  }

  private async refreshBinanceSpot(): Promise<void> {
    const resp = await fetch(BINANCE_INFO_URL);
    if (!resp.ok) throw new Error(`Binance API error: ${resp.status}`);
    const data = await resp.json() as { symbols: Array<{ baseAsset: string; quoteAsset: string; symbol: string; status: string }> };

    this.binanceSpotSymbols.clear();
    const usdcSymbols = new Map<string, string>();
    const usdtSymbols = new Map<string, string>();
    for (const s of data.symbols) {
      if (s.status !== 'TRADING') continue;
      if (s.quoteAsset === 'USDC') usdcSymbols.set(s.baseAsset, s.symbol);
      if (s.quoteAsset === 'USDT') usdtSymbols.set(s.baseAsset, s.symbol);
    }

    const hlResp = await this.hlPost({ type: 'metaAndAssetCtxs' });
    for (const asset of hlResp[0].universe) {
      const base = this.hlToBinanceBase(asset.name);
      if (usdcSymbols.has(base)) {
        this.binanceSpotSymbols.set(asset.name, usdcSymbols.get(base)!);
      } else if (usdtSymbols.has(base)) {
        this.binanceSpotSymbols.set(asset.name, usdtSymbols.get(base)!);
      }
    }
    log.info({ binanceSpotPairs: this.binanceSpotSymbols.size }, 'Binance spot metadata refreshed');
  }

  private recordRate(asset: string, rate: number): void {
    let h = this.rateHistory.get(asset);
    if (!h) {
      h = { rates: [], timestamps: [] };
      this.rateHistory.set(asset, h);
    }
    h.rates.push(rate);
    h.timestamps.push(Date.now());
    if (h.rates.length > FundingScanner.HISTORY_WINDOW) {
      h.rates.shift();
      h.timestamps.shift();
    }
  }

  getMedianRate(asset: string, lookbackMinutes: number): number {
    const h = this.rateHistory.get(asset);
    if (!h || h.rates.length === 0) return 0;
    const cutoff = Date.now() - lookbackMinutes * 60_000;
    const recent = h.rates.filter((_, i) => h.timestamps[i] >= cutoff);
    if (recent.length === 0) return 0;
    const sorted = [...recent].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  getMinRate(asset: string, lookbackMinutes: number): number {
    const h = this.rateHistory.get(asset);
    if (!h || h.rates.length === 0) return 0;
    const cutoff = Date.now() - lookbackMinutes * 60_000;
    const recent = h.rates.filter((_, i) => h.timestamps[i] >= cutoff);
    if (recent.length === 0) return 0;
    return Math.min(...recent);
  }

  getSampleCount(asset: string, lookbackMinutes: number): number {
    const h = this.rateHistory.get(asset);
    if (!h) return 0;
    const cutoff = Date.now() - lookbackMinutes * 60_000;
    return h.timestamps.filter(t => t >= cutoff).length;
  }

  async scan(): Promise<FundingOpportunity[]> {
    const [metaAndCtx, predicted] = await Promise.all([
      this.hlPost({ type: 'metaAndAssetCtxs' }),
      this.hlPost({ type: 'predictedFundings' }),
    ]);

    const perpCtxs: AssetCtx[] = metaAndCtx[1];
    const universe: PerpMeta[] = metaAndCtx[0].universe;

    const predictedMap = new Map<string, number>();
    if (Array.isArray(predicted)) {
      for (const entry of predicted) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const coin = entry[0] as string;
        const venues = entry[1] as Array<[string, { fundingRate: string; fundingIntervalHours: number }]>;
        for (const [venue, data] of venues) {
          if (venue === 'HlPerp' && data?.fundingRate) {
            predictedMap.set(coin, parseFloat(data.fundingRate));
            break;
          }
        }
      }
    }

    const perpFeeBps = this.config.useMakerOrders ? this.config.makerFeeBps : this.config.takerFeeBps;
    const totalRoundTripBps = (perpFeeBps * 2) + (this.config.spotFeeBps * 2);

    const opportunities: FundingOpportunity[] = [];

    for (let i = 0; i < universe.length; i++) {
      const asset = universe[i].name;
      const ctx = perpCtxs[i];
      if (!ctx) continue;
      if (this.config.spotAssetWhitelist?.length && !this.config.spotAssetWhitelist.includes(asset)) continue;

      const binanceSymbol = this.binanceSpotSymbols.get(asset);
      if (!binanceSymbol) continue;

      const currentRate = parseFloat(ctx.funding);
      const predictedRate = predictedMap.get(asset) ?? currentRate;
      const perpMid = parseFloat(ctx.midPx ?? ctx.markPx ?? '0');
      if (perpMid <= 0) continue;

      this.recordRate(asset, currentRate);

      if (currentRate <= 0 && predictedRate <= 0) continue;

      const avgRate = (currentRate + predictedRate) / 2;
      const annualizedPct = avgRate * HOURS_PER_YEAR * 100;

      const breakEvenHours = totalRoundTripBps > 0 && avgRate > 0
        ? (totalRoundTripBps / 10000) / avgRate
        : 99999;

      // Use median rate over lookback as conservative estimate
      const medianRate = this.getMedianRate(asset, 30);
      const minRate = this.getMinRate(asset, 30);
      const samples = this.getSampleCount(asset, 30);
      const conservativeRate = samples >= 10 ? medianRate : currentRate;
      const conservativeApy = conservativeRate * HOURS_PER_YEAR * 100;

      opportunities.push({
        asset,
        perpAssetIndex: i,
        binanceSymbol,
        currentFundingRate: currentRate,
        predictedFundingRate: predictedRate,
        annualizedPct,
        conservativeApy,
        minRateLookback: minRate,
        rateSamples: samples,
        breakEvenHours,
        perpMidPrice: perpMid,
        timestamp: Date.now(),
      });
    }

    opportunities.sort((a, b) => b.conservativeApy - a.conservativeApy);
    this.lastScan = opportunities;

    const above20 = opportunities.filter(o => o.conservativeApy >= 20);
    log.info({
      total: opportunities.length,
      above20pct: above20.length,
      top: opportunities.slice(0, 5).map(o => ({
        asset: o.asset,
        apy: `${o.annualizedPct.toFixed(1)}%`,
        conserv: `${o.conservativeApy.toFixed(1)}%`,
        samples: o.rateSamples,
        breakEven: `${o.breakEvenHours.toFixed(1)}h`,
      })),
    }, 'Funding scan complete');

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
