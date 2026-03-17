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
    log.info({ traders: this.traders.length, interval: this.config.discoveryIntervalMs }, 'Trader discovery started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getTrackedTraders(): TrackedTrader[] {
    return this.traders.filter(t => t.enabled);
  }

  async refresh(): Promise<void> {
    try {
      const entries = await this.fetchLeaderboard();
      log.info({ found: entries.length }, 'Leaderboard fetched');

      const shadowStats = await this.persistence.getTraderShadowStats();

      // Disable traders with no proven edge — keeps profitable ones active
      await this.persistence.disableStaleTraders();

      for (const entry of entries.slice(0, this.config.maxTraders)) {
        const bankroll = this.estimateBankroll(entry);
        const stats = shadowStats.get(entry.address);
        const copyEligible = stats ? this.isEligible(stats) : false;
        const isNew = !this.knownAddresses.has(entry.address);

        const trader: TrackedTrader = {
          address: entry.address,
          alias: entry.displayName || `trader-${entry.rank}`,
          pnl: entry.pnl,
          volume: entry.volume,
          bankrollEstimate: bankroll,
          rank: entry.rank,
          enabled: true,
          copyEligible,
        };
        await this.persistence.upsertTrader(trader);
        this.knownAddresses.add(entry.address);

        if (isNew) {
          const alreadyBackfilled = await this.backfill.isTraderBackfilled(entry.address);
          if (!alreadyBackfilled) {
            this.enqueueBackfill(entry.address, trader.alias, bankroll);
          }
        }
      }

      // Re-enable proven traders and update eligibility for all with shadow data
      for (const [address, stats] of shadowStats) {
        const eligible = this.isEligible(stats);
        if (stats.trades >= 3 && stats.pnl > 0) {
          await this.persistence.enableProvenTrader(address, eligible);
        } else {
          await this.persistence.updateCopyEligible(address, false);
        }
      }

      for (const [address, stats] of shadowStats) {
        const eligible = this.isEligible(stats);
        if (stats.trades >= 10) {
          log.info({
            address: address.slice(0, 10),
            trades: stats.trades,
            pnl: stats.pnl.toFixed(2),
            sharpe: stats.sharpe.toFixed(4),
            pf: stats.profitFactor.toFixed(2),
            days: stats.activeDays,
            maxDD: stats.maxDrawdown.toFixed(2),
            eligible,
          }, 'Trader eligibility check');
        }
      }

      this.traders = await this.persistence.getActiveTraders();
      const eligible = this.traders.filter(t => t.copyEligible);
      log.info({
        active: this.traders.length,
        copyEligible: eligible.length,
        eligibleNames: eligible.map(t => t.alias),
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

  private async fetchLeaderboard(): Promise<LeaderboardEntry[]> {
    const url = `${this.config.dataApiUrl}/v1/leaderboard?category=SPORTS&timePeriod=DAY&orderBy=PNL&limit=${this.config.maxTraders}&offset=0`;
    const resp = await fetch(url);

    if (!resp.ok) {
      throw new Error(`Leaderboard API ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json() as Array<{
      proxyWallet?: string;
      userName?: string;
      pnl?: number;
      vol?: number;
      rank?: number;
    }>;

    return data.map((item, i) => ({
      address: (item.proxyWallet || '').toLowerCase(),
      displayName: item.userName || '',
      pnl: item.pnl || 0,
      volume: item.vol || 0,
      rank: item.rank || i + 1,
    }));
  }

  private isEligible(stats: TraderStats): boolean {
    if (stats.trades < MIN_TRADES) return false;
    if (stats.pnl <= 0) return false;
    if (stats.activeDays < MIN_ACTIVE_DAYS) return false;
    if (stats.sharpe < MIN_SHARPE) return false;
    if (stats.profitFactor < MIN_PROFIT_FACTOR) return false;
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
