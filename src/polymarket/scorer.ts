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
  private traderStats = new Map<string, TraderRollingStats>();
  private marketCounts = new Map<string, number>();
  private minScore: number;
  private enabled = false;

  constructor(
    private readonly persistence: PolymarketPersistence,
  ) {
    this.minScore = Number(process.env.PM_MIN_SCORE || 0.5);
  }

  async start(): Promise<void> {
    try {
      const ort = await import('onnxruntime-node');
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const modelPath = path.resolve(__dirname, '../../models/pm_scorer.onnx');
      this.session = await ort.InferenceSession.create(modelPath);
      this.enabled = true;
      log.info({ minScore: this.minScore, features: FEATURES.length }, 'ML scorer loaded');
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
  ): Promise<{ score: number; pass: boolean }> {
    if (!this.enabled || !this.session) {
      return { score: 1.0, pass: true };
    }

    try {
      const features = await this.buildFeatures(trader, activity);
      const ort = await import('onnxruntime-node');
      const tensor = new ort.Tensor('float32', Float32Array.from(features), [1, FEATURES.length]);
      const results = await this.session.run({ features: tensor });
      const probs = results.probabilities?.data || results.output_probability?.data;

      let winProb = 0.5;
      if (probs && probs.length >= 2) {
        winProb = probs[1];
      }

      const pass = winProb >= this.minScore;
      if (!pass) {
        log.debug({
          trader: trader.alias,
          market: activity.marketSlug,
          score: winProb.toFixed(3),
          threshold: this.minScore,
        }, 'Trade below score threshold');
      }

      return { score: winProb, pass };
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Scoring error — allowing trade');
      return { score: 1.0, pass: true };
    }
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
