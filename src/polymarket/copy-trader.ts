import pg from 'pg';
import { createChildLogger } from '../utils/logger.js';
import { loadPolymarketConfig } from './config.js';
import { PolymarketPersistence } from './persistence.js';
import { TraderDiscovery } from './discovery.js';
import { ActivityMonitor } from './monitor.js';
import { CopyExecutor } from './executor.js';
import { PolymarketRiskManager } from './risk-manager.js';
import type { PolymarketConfig } from './types.js';

const log = createChildLogger({ component: 'pm-copy-trader' });

export class PolymarketCopyTrader {
  private config: PolymarketConfig;
  private persistence: PolymarketPersistence;
  private discovery: TraderDiscovery;
  private monitor: ActivityMonitor;
  private executor: CopyExecutor;
  private riskManager: PolymarketRiskManager;
  private priceUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private traderRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pool: pg.Pool) {
    this.config = loadPolymarketConfig();
    this.persistence = new PolymarketPersistence(pool);
    this.discovery = new TraderDiscovery(this.config, this.persistence);
    this.monitor = new ActivityMonitor(this.config);
    this.executor = new CopyExecutor(this.config, this.persistence);
    this.riskManager = new PolymarketRiskManager(this.config, this.persistence);
  }

  async start(): Promise<void> {
    await this.executor.start();
    await this.discovery.start();

    const traders = this.discovery.getTrackedTraders();
    this.monitor.setTraders(traders);

    this.monitor.setTradeCallback(async (trader, activity) => {
      try {
        const sizeUsd = (activity.size / Math.max(trader.bankrollEstimate, 1)) * this.config.bankrollUsd;

        const { allowed, reason } = await this.riskManager.canTrade(sizeUsd, activity.conditionId);
        if (!allowed) {
          log.info({ trader: trader.alias, market: activity.marketSlug, reason }, 'Trade blocked by risk manager');
          return;
        }

        await this.executor.executeCopy(trader, activity);
        await this.persistence.updateTraderActivity(trader.address);
      } catch (err) {
        log.error({ trader: trader.alias, error: (err as Error).message }, 'Copy trade error');
      }
    });

    this.monitor.start();
    this.riskManager.startPeriodicCheck();

    this.priceUpdateTimer = setInterval(
      () => this.executor.updatePositionPrices().catch(e => log.error({ err: e }, 'Price update error')),
      this.config.positionUpdateIntervalMs,
    );

    this.traderRefreshTimer = setInterval(() => {
      const updatedTraders = this.discovery.getTrackedTraders();
      this.monitor.setTraders(updatedTraders);
    }, this.config.discoveryIntervalMs);

    log.info({
      paperMode: this.config.paperMode,
      bankroll: this.config.bankrollUsd,
      traders: traders.length,
      maxPosition: this.config.riskLimits.maxPositionUsd,
      maxExposure: this.config.riskLimits.maxTotalExposureUsd,
    }, 'Polymarket copy trader started');
  }

  stop(): void {
    this.monitor.stop();
    this.discovery.stop();
    this.riskManager.stop();
    if (this.priceUpdateTimer) { clearInterval(this.priceUpdateTimer); this.priceUpdateTimer = null; }
    if (this.traderRefreshTimer) { clearInterval(this.traderRefreshTimer); this.traderRefreshTimer = null; }
    log.info('Polymarket copy trader stopped');
  }
}
