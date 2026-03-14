import { createChildLogger } from '../utils/logger.js';
import { PolymarketPersistence } from './persistence.js';
import type { PolymarketConfig, TrackedTrader, LeaderboardEntry } from './types.js';

const log = createChildLogger({ component: 'pm-discovery' });

const MIN_SHADOW_TRADES = 5;
const MIN_WIN_RATE = 0.45;

export class TraderDiscovery {
  private traders: TrackedTrader[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: PolymarketConfig,
    private readonly persistence: PolymarketPersistence,
  ) {}

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

      // Upsert leaderboard traders (new discovery + update existing)
      for (const entry of entries.slice(0, this.config.maxTraders)) {
        const bankroll = this.estimateBankroll(entry);
        const stats = shadowStats.get(entry.address);
        const copyEligible = stats
          ? stats.trades >= MIN_SHADOW_TRADES && stats.pnl > 0 && (stats.wins / stats.trades) >= MIN_WIN_RATE
          : false;

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
      }

      // Re-enable any proven trader not on today's leaderboard
      for (const [address, stats] of shadowStats) {
        if (stats.trades >= 3 && stats.pnl > 0) {
          const copyEligible = stats.trades >= MIN_SHADOW_TRADES && (stats.wins / stats.trades) >= MIN_WIN_RATE;
          await this.persistence.enableProvenTrader(address, copyEligible);
        }
      }

      this.traders = await this.persistence.getActiveTraders();
      const eligible = this.traders.filter(t => t.copyEligible);
      const fromShadow = this.traders.filter(t => t.enabled && !entries.some(e => e.address === t.address));
      log.info({
        active: this.traders.length,
        fromLeaderboard: this.traders.length - fromShadow.length,
        fromShadowHistory: fromShadow.length,
        copyEligible: eligible.length,
        eligibleNames: eligible.map(t => t.alias),
      }, 'Trader roster updated');
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to refresh leaderboard');
    }
  }

  private async loadFromDb(): Promise<void> {
    this.traders = await this.persistence.getActiveTraders();
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

  private estimateBankroll(entry: LeaderboardEntry): number {
    if (entry.volume > 0 && entry.pnl !== 0) {
      return Math.max(Math.abs(entry.pnl) * 5, entry.volume * 0.05);
    }
    return 10000;
  }
}
