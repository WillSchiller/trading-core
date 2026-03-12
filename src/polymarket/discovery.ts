import { createChildLogger } from '../utils/logger.js';
import { PolymarketPersistence } from './persistence.js';
import type { PolymarketConfig, TrackedTrader, LeaderboardEntry } from './types.js';

const log = createChildLogger({ component: 'pm-discovery' });

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

      for (const entry of entries.slice(0, this.config.maxTraders)) {
        const bankroll = this.estimateBankroll(entry);
        const trader: TrackedTrader = {
          address: entry.address,
          alias: entry.displayName || `trader-${entry.rank}`,
          pnl: entry.pnl,
          volume: entry.volume,
          bankrollEstimate: bankroll,
          rank: entry.rank,
          enabled: true,
        };
        await this.persistence.upsertTrader(trader);
      }

      this.traders = await this.persistence.getActiveTraders();
      log.info({ active: this.traders.length }, 'Trader roster updated');
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to refresh leaderboard');
    }
  }

  private async loadFromDb(): Promise<void> {
    this.traders = await this.persistence.getActiveTraders();
    log.info({ loaded: this.traders.length }, 'Loaded traders from DB');
  }

  private async fetchLeaderboard(): Promise<LeaderboardEntry[]> {
    const url = `${this.config.dataApiUrl}/leaderboard?window=1w&limit=${this.config.maxTraders}&offset=0`;
    const resp = await fetch(url);

    if (!resp.ok) {
      throw new Error(`Leaderboard API ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json() as Array<{
      address?: string;
      maker_address?: string;
      display_name?: string;
      pnl?: number;
      volume?: number;
      rank?: number;
    }>;

    return data.map((item, i) => ({
      address: (item.address || item.maker_address || '').toLowerCase(),
      displayName: item.display_name || '',
      pnl: item.pnl || 0,
      volume: item.volume || 0,
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
