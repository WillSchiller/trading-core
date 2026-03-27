import { createChildLogger } from '../utils/logger.js';
import { PolymarketPersistence } from './persistence.js';
import type { TrackedTrader, TraderActivity } from './types.js';
import path from 'path';
import { fileURLToPath } from 'url';

const log = createChildLogger({ component: 'pm-scorer' });

const FEATURES = [
  'entry_price', 'price_dist_from_half', 'implied_edge',
  'cat_sports', 'cat_crypto', 'cat_politics',
  'hour', 'dow',
  'size_vs_median',
  'roll_wr_20', 'roll_pf_20', 'roll_streak',
  'lifetime_wr', 'lifetime_pf', 'trade_num',
  'market_trader_count',
];

interface TraderRollingStats {
  pnls: number[];
  totalTrades: number;
  medianSize: number;
}

export class TradeScorer {
  private session: any = null;
  private capitalSession: any = null;
  private kellySession: any = null;
  private kellyProperSession: any = null;
  private kellyCalibration: { x: number[]; y: number[] } | null = null;
  private traderStats = new Map<string, TraderRollingStats>();
  private marketCounts = new Map<string, number>();
  private minScore: number;
  private enabled = false;
  private activeModel: 'win' | 'capital' | 'kelly';

  constructor(
    private readonly persistence: PolymarketPersistence,
  ) {
    this.minScore = Number(process.env.PM_MIN_SCORE || 0.5);
    this.activeModel = (process.env.PM_SCORER_MODEL || 'win') as 'win' | 'capital' | 'kelly';
  }

  async start(): Promise<void> {
    try {
      const ort = await import('onnxruntime-node');
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const winPath = path.resolve(__dirname, '../../models/pm_scorer.onnx');
      const capPath = path.resolve(__dirname, '../../models/pm_scorer_capital.onnx');
      this.session = await ort.InferenceSession.create(winPath);
      try { this.capitalSession = await ort.InferenceSession.create(capPath); } catch { /* optional */ }
      const kellyPath = path.resolve(__dirname, '../../models/pm_scorer_kelly.onnx');
      try { this.kellySession = await ort.InferenceSession.create(kellyPath); } catch { /* optional */ }
      const kellyProperPath = path.resolve(__dirname, '../../models/pm_scorer_kelly_proper.onnx');
      try { this.kellyProperSession = await ort.InferenceSession.create(kellyProperPath); } catch { /* optional */ }
      const calPath = path.resolve(__dirname, '../../models/pm_kelly_calibration.json');
      try {
        const fs = await import('fs');
        this.kellyCalibration = JSON.parse(fs.readFileSync(calPath, 'utf-8'));
      } catch { /* optional */ }
      this.enabled = true;
      log.info({ minScore: this.minScore, activeModel: this.activeModel, hasCapitalModel: !!this.capitalSession, hasKellyModel: !!this.kellySession }, 'ML scorer loaded');
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'ML scorer not available — running without scoring');
      this.enabled = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async score(
    trader: TrackedTrader,
    activity: TraderActivity,
  ): Promise<{ score: number; pass: boolean; kellySize: number }> {
    if (!this.enabled || !this.session) {
      return { score: 1.0, pass: true, kellySize: 0 };
    }

    try {
      const features = await this.buildFeatures(trader, activity);
      const ort = await import('onnxruntime-node');
      const tensor = new ort.Tensor('float32', Float32Array.from(features), [1, FEATURES.length]);

      const winResult = await this.session.run({ features: tensor });
      const winProbs = winResult.probabilities?.data || winResult.output_probability?.data;
      const winScore = (winProbs && winProbs.length >= 2) ? winProbs[1] : 0.5;

      let capScore = 0.5;
      if (this.capitalSession) {
        const capResult = await this.capitalSession.run({ features: tensor });
        const capProbs = capResult.probabilities?.data || capResult.output_probability?.data;
        capScore = (capProbs && capProbs.length >= 2) ? capProbs[1] : 0.5;
      }

      let kellyScore = 0;
      if (this.kellySession) {
        const kellyResult = await this.kellySession.run({ features: tensor });
        const kellyOut = kellyResult.variable?.data || kellyResult.predictions?.data;
        kellyScore = kellyOut ? kellyOut[0] : 0;
      }

      // Proper Kelly: calibrated probability → Kelly fraction
      let properKellySize = 0;
      let calibratedProb = 0;
      if (this.kellyProperSession && this.kellyCalibration) {
        const properResult = await this.kellyProperSession.run({ features: tensor });
        const properProbs = properResult.probabilities?.data || properResult.output_probability?.data;
        const rawProb = (properProbs && properProbs.length >= 2) ? properProbs[1] as number : 0.5;
        calibratedProb = this.calibrate(rawProb);
        const entryPrice = activity.price;
        const payoff = (1 / Math.max(entryPrice, 0.01)) - 1;
        const kellyF = Math.max(0, Math.min(0.125, calibratedProb - (1 - calibratedProb) / payoff)) * 0.5;
        const bankroll = Number(process.env.POLYMARKET_BANKROLL_USD || 500);
        properKellySize = Math.round(bankroll * kellyF * 100) / 100;
      }

      // Old Kelly (regression-based)
      const bankroll = Number(process.env.POLYMARKET_BANKROLL_USD || 500);
      const edge = Math.max(0, kellyScore as number);
      const kellyMult = Number(process.env.PM_KELLY_MULTIPLIER || 0.1);
      const oldKellyFrac = Math.min(0.10, edge * kellyMult);
      const oldKellySize = Math.round(bankroll * oldKellyFrac * 100) / 100;

      const activeScore = this.activeModel === 'kelly' ? calibratedProb : (this.activeModel === 'capital' ? capScore : winScore);
      const pass = this.activeModel === 'kelly' ? properKellySize >= 1 : activeScore >= this.minScore;
      const kellySize = this.activeModel === 'kelly' ? properKellySize : oldKellySize;

      log.info({
        trader: trader.alias,
        market: activity.marketSlug,
        winScore: (winScore as number).toFixed(3),
        capScore: (capScore as number).toFixed(3),
        calProb: calibratedProb.toFixed(3),
        oldKelly: oldKellySize.toFixed(2),
        properKelly: properKellySize.toFixed(2),
        active: this.activeModel,
        pass,
      }, 'Trade scored');

      return { score: activeScore as number, pass, kellySize };
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Scoring error — allowing trade');
      return { score: 1.0, pass: true, kellySize: 0 };
    }
  }

  private calibrate(rawProb: number): number {
    if (!this.kellyCalibration) return rawProb;
    const { x, y } = this.kellyCalibration;
    if (rawProb <= x[0]) return y[0];
    if (rawProb >= x[x.length - 1]) return y[y.length - 1];
    for (let i = 0; i < x.length - 1; i++) {
      if (rawProb >= x[i] && rawProb <= x[i + 1]) {
        const t = (rawProb - x[i]) / (x[i + 1] - x[i]);
        return y[i] + t * (y[i + 1] - y[i]);
      }
    }
    return rawProb;
  }

  private async buildFeatures(trader: TrackedTrader, activity: TraderActivity): Promise<number[]> {
    const stats = await this.getTraderRollingStats(trader.address);
    const marketCount = this.marketCounts.get(activity.marketSlug) || 1;
    this.marketCounts.set(activity.marketSlug, marketCount + 1);

    const entryPrice = activity.price;
    const hour = new Date().getUTCHours();
    const dow = new Date().getUTCDay();

    const pnls = stats.pnls;
    const n = pnls.length;

    let rollWr20 = 0.5;
    let rollPf20 = 1.0;
    let rollStreak = 0;
    let lifetimeWr = 0.5;
    let lifetimePf = 1.0;

    if (n >= 20) {
      const recent = pnls.slice(-20);
      const wins = recent.filter(p => p > 0).length;
      rollWr20 = wins / 20;
      const gw = recent.filter(p => p > 0).reduce((a, b) => a + b, 0);
      const gl = Math.abs(recent.filter(p => p < 0).reduce((a, b) => a + b, 0));
      rollPf20 = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
    }

    if (n > 0) {
      const wins = pnls.filter(p => p > 0).length;
      lifetimeWr = wins / n;
      const gw = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
      const gl = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
      lifetimePf = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;

      // Streak
      let streak = 0;
      const lastWin = pnls[n - 1] > 0;
      for (let i = n - 1; i >= 0; i--) {
        if ((pnls[i] > 0) === lastWin) streak++;
        else break;
      }
      rollStreak = lastWin ? streak : -streak;
    }

    const sizeVsMedian = stats.medianSize > 0 ? activity.size / stats.medianSize : 1;

    return [
      entryPrice,
      Math.abs(entryPrice - 0.5),
      entryPrice < 0.5 ? 1 - entryPrice : entryPrice,
      trader.category === 'SPORTS' ? 1 : 0,
      trader.category === 'CRYPTO' ? 1 : 0,
      trader.category === 'POLITICS' ? 1 : 0,
      hour,
      dow,
      sizeVsMedian,
      rollWr20,
      rollPf20,
      rollStreak,
      lifetimeWr,
      lifetimePf,
      stats.totalTrades,
      marketCount,
    ];
  }

  private async getTraderRollingStats(address: string): Promise<TraderRollingStats> {
    let stats = this.traderStats.get(address);
    if (stats) return stats;

    const result = await this.persistence.getPool().query(
      `SELECT pnl_if_copied::float as pnl, size::float as trade_size
       FROM pm_shadow_trades
       WHERE trader_address = $1 AND resolved = true AND side = 'BUY' AND our_entry_price > 0
       ORDER BY trader_timestamp`,
      [address],
    );

    const pnls = result.rows.map((r: { pnl: number }) => r.pnl);
    const sizes = result.rows.map((r: { trade_size: number }) => r.trade_size).sort((a: number, b: number) => a - b);
    const medianSize = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 1;

    stats = { pnls, totalTrades: pnls.length, medianSize };
    this.traderStats.set(address, stats);
    return stats;
  }

  updateTraderPnl(address: string, pnl: number): void {
    const stats = this.traderStats.get(address);
    if (stats) {
      stats.pnls.push(pnl);
      stats.totalTrades++;
    }
  }
}
