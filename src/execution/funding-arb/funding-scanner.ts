import { createChildLogger } from '../../utils/logger.js';
import type { FundingArbConfig, FundingOpportunity } from './types.js';

const log = createChildLogger({ component: 'funding-scanner' });

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const BINANCE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';
const HOURS_PER_YEAR = 8760;

interface PerpMeta { name: string; szDecimals: number; maxLeverage: number }
interface AssetCtx { funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; premium: string; oraclePx: string; markPx: string; midPx?: string }

export class FundingScanner {
  private config: FundingArbConfig;
  private binanceSpotSymbols = new Map<string, string>(); // HL asset name → Binance symbol (e.g. ETHUSDC)
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScan: FundingOpportunity[] = [];

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

  getBestOpportunity(): FundingOpportunity | null {
    return this.lastScan[0] ?? null;
  }

  getOpportunityForAsset(asset: string): FundingOpportunity | null {
    return this.lastScan.find(o => o.asset === asset) ?? null;
  }

  private hlToBinanceBase(hlAsset: string): string {
    // HL kilo-tokens: kPEPE → PEPE, kSHIB → SHIB
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

    // Prefer USDC pairs, fall back to USDT
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

  async scan(): Promise<FundingOpportunity[]> {
    const [metaAndCtx, predicted] = await Promise.all([
      this.hlPost({ type: 'metaAndAssetCtxs' }),
      this.hlPost({ type: 'predictedFundings' }),
    ]);

    const perpCtxs: AssetCtx[] = metaAndCtx[1];
    const universe: PerpMeta[] = metaAndCtx[0].universe;

    // predictedFundings: [[coin, [[exchange, {fundingRate, fundingIntervalHours}], ...]], ...]
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
    // Round-trip: HL perp entry+exit + Binance spot entry+exit
    const totalRoundTripBps = (perpFeeBps * 2) + (this.config.spotFeeBps * 2);

    const opportunities: FundingOpportunity[] = [];

    for (let i = 0; i < universe.length; i++) {
      const asset = universe[i].name;
      const ctx = perpCtxs[i];
      if (!ctx) continue;

      if (this.config.spotAssetWhitelist?.length && !this.config.spotAssetWhitelist.includes(asset)) continue;

      // Must have Binance spot for delta-neutral hedge
      const binanceSymbol = this.binanceSpotSymbols.get(asset);
      if (!binanceSymbol) continue;

      const currentRate = parseFloat(ctx.funding);
      const predictedRate = predictedMap.get(asset) ?? currentRate;
      const perpMid = parseFloat(ctx.midPx ?? ctx.markPx ?? '0');
      if (perpMid <= 0) continue;

      // For funding arb (short perp): positive funding = we receive
      if (currentRate <= 0 && predictedRate <= 0) continue;

      const avgRate = (currentRate + predictedRate) / 2;
      const annualizedPct = avgRate * HOURS_PER_YEAR * 100;

      const breakEvenHours = totalRoundTripBps > 0 && avgRate > 0
        ? (totalRoundTripBps / 10000) / avgRate
        : 99999;

      opportunities.push({
        asset,
        perpAssetIndex: i,
        binanceSymbol,
        currentFundingRate: currentRate,
        predictedFundingRate: predictedRate,
        annualizedPct,
        breakEvenHours,
        perpMidPrice: perpMid,
        timestamp: Date.now(),
      });
    }

    opportunities.sort((a, b) => b.annualizedPct - a.annualizedPct);
    this.lastScan = opportunities;

    const above20 = opportunities.filter(o => o.annualizedPct >= 20);
    log.info({
      total: opportunities.length,
      above20pct: above20.length,
      top: opportunities.slice(0, 5).map(o => ({
        asset: o.asset,
        apy: `${o.annualizedPct.toFixed(1)}%`,
        rate: o.currentFundingRate.toFixed(6),
        breakEven: `${o.breakEvenHours.toFixed(1)}h`,
        binance: o.binanceSymbol,
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
