import pg from 'pg';
import { createChildLogger } from '../utils/logger.js';
import { PolymarketPersistence } from './persistence.js';
import { TraderBackfill } from './backfill.js';
import type { PolymarketConfig, TrackedTrader, LeaderboardEntry, TraderStats } from './types.js';

const log = createChildLogger({ component: 'pm-discovery' });

const MIN_TRADES = Number(process.env.PM_MIN_TRADES || 50);
const MIN_ACTIVE_DAYS = Number(process.env.PM_MIN_ACTIVE_DAYS || 14);
const MIN_SHARPE = Number(process.env.PM_MIN_SHARPE || 0.05);
const MIN_PROFIT_FACTOR = Number(process.env.PM_MIN_PROFIT_FACTOR || 1.3);
const MAX_DD_RATIO = Number(process.env.PM_MAX_DD_RATIO || 0.5);
const MIN_COINFLIP_WR = Number(process.env.PM_MIN_COINFLIP_WR || 0.55);

export class TraderDiscovery {
  private traders: TrackedTrader[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private backfill: TraderBackfill;
  private knownAddresses = new Set<string>();
  private backfillQueue: Array<{ address: string; alias: string; bankroll: number }> = [];
  private backfillRunning = false;

  constructor(
    private readonly config: PolymarketConfig,
    private readonly persistence: PolymarketPersistence,
    pool?: pg.Pool,
  ) {
    this.backfill = new TraderBackfill(config, persistence, pool || persistence.getPool());
  }

  async start(): Promise<void> {
    await this.loadFromDb();
    await this.refresh();

    this.timer = setInterval(
      () => this.refresh().catch(e => log.error({ err: e }, 'Discovery refresh error')),
      this.config.discoveryIntervalMs,
    );
    log.info({
      traders: this.traders.length,
      interval: this.config.discoveryIntervalMs,
      discoveryCategories: this.config.discoveryCategories,
      copyCategories: this.config.copyCategories,
    }, 'Trader discovery started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getTrackedTraders(): TrackedTrader[] {
    return this.traders.filter(t => t.enabled);
  }

  async refresh(): Promise<void> {
    try {
      const allEntries: LeaderboardEntry[] = [];
      for (const category of this.config.discoveryCategories) {
        const entries = await this.fetchLeaderboard(category);
        allEntries.push(...entries);
      }

      const seen = new Set<string>();
      const dedupedEntries = allEntries.filter(e => {
        if (seen.has(e.address)) return false;
        seen.add(e.address);
        return true;
      });

      log.info({
        total: allEntries.length,
        unique: dedupedEntries.length,
        categories: this.config.discoveryCategories,
      }, 'Leaderboards fetched');

      const shadowStats = await this.persistence.getTraderShadowStats();
      await this.persistence.disableStaleTraders();

      for (const entry of dedupedEntries) {
        const bankroll = this.estimateBankroll(entry);
        const stats = shadowStats.get(entry.address);
        const canCopy = this.config.copyCategories.includes(entry.category);
        const copyEligible = canCopy && stats ? this.isEligible(stats) : false;

        const trader: TrackedTrader = {
          address: entry.address,
          alias: entry.displayName || `trader-${entry.rank}`,
          pnl: entry.pnl,
          volume: entry.volume,
          bankrollEstimate: bankroll,
          rank: entry.rank,
          enabled: true,
          copyEligible,
          category: entry.category,
        };
        await this.persistence.upsertTrader(trader);
        this.knownAddresses.add(entry.address);

        const alreadyBackfilled = await this.backfill.isTraderBackfilled(entry.address);
        if (!alreadyBackfilled) {
          this.enqueueBackfill(entry.address, trader.alias, bankroll);
        }
      }

      for (const [address, stats] of shadowStats) {
        const trader = dedupedEntries.find(e => e.address === address);
        const category = trader?.category;
        const canCopy = category ? this.config.copyCategories.includes(category) : false;
        const eligible = canCopy && this.isEligible(stats);

        if (stats.trades >= 3 && stats.pnl > 0) {
          await this.persistence.enableProvenTrader(address, eligible);
        } else {
          await this.persistence.updateCopyEligible(address, false);
        }
      }

      for (const [address, stats] of shadowStats) {
        if (stats.trades >= 10) {
          const trader = dedupedEntries.find(e => e.address === address);
          const canCopy = trader ? this.config.copyCategories.includes(trader.category) : false;
          log.info({
            address: address.slice(0, 10),
            category: trader?.category || 'unknown',
            trades: stats.trades,
            pnl: stats.pnl.toFixed(2),
            sharpe: stats.sharpe.toFixed(4),
            pf: stats.profitFactor.toFixed(2),
            days: stats.activeDays,
            maxDD: stats.maxDrawdown.toFixed(2),
            eligible: canCopy && this.isEligible(stats),
            copyEnabled: canCopy,
          }, 'Trader eligibility check');
        }
      }

      this.traders = await this.persistence.getActiveTraders();
      const eligible = this.traders.filter(t => t.copyEligible);
      log.info({
        active: this.traders.length,
        copyEligible: eligible.length,
        eligibleNames: eligible.map(t => `${t.alias} (${t.category})`),
      }, 'Trader roster updated');
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to refresh leaderboard');
    }
  }

  private async loadFromDb(): Promise<void> {
    this.traders = await this.persistence.getActiveTraders();
    for (const t of this.traders) this.knownAddresses.add(t.address);
    log.info({ loaded: this.traders.length }, 'Loaded traders from DB');
  }

  private async fetchLeaderboard(category: string): Promise<LeaderboardEntry[]> {
    const periods = ['DAY', 'WEEK', 'MONTH'];
    const perPeriod = 200;
    const entries: LeaderboardEntry[] = [];
    const seen = new Set<string>();

    for (const period of periods) {
      for (let offset = 0; offset < perPeriod; offset += 50) {
        const limit = Math.min(50, perPeriod - offset);
        const url = `${this.config.dataApiUrl}/v1/leaderboard?category=${category}&timePeriod=${period}&orderBy=PNL&limit=${limit}&offset=${offset}`;
        const resp = await fetch(url);
        if (!resp.ok) break;

        const data = await resp.json() as Array<{
          proxyWallet?: string;
          userName?: string;
          pnl?: number;
          vol?: number;
          rank?: number;
        }>;

        if (!data.length) break;

        for (const item of data) {
          const addr = (item.proxyWallet || '').toLowerCase();
          if (seen.has(addr)) continue;
          seen.add(addr);
          entries.push({
            address: addr,
            displayName: item.userName || '',
            pnl: item.pnl || 0,
            volume: item.vol || 0,
            rank: item.rank || entries.length + 1,
            category,
          });
        }
      }
    }

    return entries;
  }

  private isEligible(stats: TraderStats): boolean {
    if (stats.trades < MIN_TRADES) return false;
    if (stats.pnl <= 0) return false;
    if (stats.activeDays < MIN_ACTIVE_DAYS) return false;
    if (stats.sharpe < MIN_SHARPE) return false;
    if (stats.profitFactor < MIN_PROFIT_FACTOR) return false;
    if (stats.coinflipWR > 0 && stats.coinflipWR < MIN_COINFLIP_WR) return false;
    if (stats.maxDrawdown < 0 && Math.abs(stats.maxDrawdown) > stats.pnl * MAX_DD_RATIO) return false;
    return true;
  }

  private enqueueBackfill(address: string, alias: string, bankroll: number): void {
    this.backfillQueue.push({ address, alias, bankroll });
    if (!this.backfillRunning) this.processBackfillQueue().catch(e => log.error({ err: e }, 'Backfill queue error'));
  }

  private async processBackfillQueue(): Promise<void> {
    this.backfillRunning = true;
    try {
      while (this.backfillQueue.length > 0) {
        const { address, alias, bankroll } = this.backfillQueue.shift()!;
        try {
          const n = await this.backfill.backfillTrader(address, alias, bankroll);
          log.info({ trader: alias, trades: n, remaining: this.backfillQueue.length }, 'Backfill complete');
        } catch (err) {
          log.error({ trader: alias, error: (err as Error).message }, 'Backfill failed');
        }
      }
    } finally {
      this.backfillRunning = false;
    }
  }

  private estimateBankroll(entry: LeaderboardEntry): number {
    if (entry.volume > 0 && entry.pnl !== 0) {
      return Math.max(Math.abs(entry.pnl) * 5, entry.volume * 0.05);
    }
    return 10000;
  }
}
