import type { Pool } from 'pg';
import { createChildLogger } from '../../utils/logger.js';
import { loadPMMConfig } from './config.js';
import { MarketSelector } from './market-selector.js';
import { PMMPaperMM } from './paper-mm.js';
import type { PMMConfig } from './types.js';

const log = createChildLogger({ component: 'pmm-manager' });

const MARKET_ROTATION_MS = 3600_000; // re-evaluate markets every hour

export class PMMManager {
  private config: PMMConfig;
  private selector: MarketSelector;
  private paperMM: PMMPaperMM;
  private rotationTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(pool: Pool, config?: PMMConfig) {
    this.config = config || loadPMMConfig();
    this.selector = new MarketSelector(this.config);
    this.paperMM = new PMMPaperMM(this.config, pool);
  }

  async start(): Promise<void> {
    this.stopping = false;

    // Initial market scan
    await this.selector.scan();
    await this.addTopMarkets();

    // Start paper MM engine
    await this.paperMM.start();

    // Start periodic scanning + rotation
    this.selector.startScanning(MARKET_ROTATION_MS);
    this.rotationTimer = setInterval(
      () => this.rotateMarkets().catch(e => log.error({ err: e }, 'Market rotation error')),
      MARKET_ROTATION_MS,
    );

    log.info({
      maxMarkets: this.config.maxMarkets,
      posSize: this.config.positionSizeUsd,
      gamma: this.config.gamma,
    }, 'PMM manager started');
  }

  stop(): void {
    this.stopping = true;
    this.selector.stop();
    this.paperMM.stop();
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
    log.info('PMM manager stopped');
  }

  private async addTopMarkets(): Promise<void> {
    const markets = this.selector.getTopMarkets(this.config.maxMarkets);
    for (const m of markets) {
      await this.paperMM.addMarket(m);
    }
    log.info({ count: markets.length }, 'Initial markets added');
  }

  private async rotateMarkets(): Promise<void> {
    if (this.stopping) return;

    const desired = this.selector.getTopMarkets(this.config.maxMarkets);
    const currentCount = this.paperMM.getActiveMarketCount();

    // Add new top-scoring markets if we have capacity
    for (const m of desired) {
      if (this.paperMM.getActiveMarketCount() >= this.config.maxMarkets) break;
      await this.paperMM.addMarket(m);
    }

    log.debug({
      desired: desired.length,
      current: currentCount,
      active: this.paperMM.getActiveMarketCount(),
    }, 'Market rotation complete');
  }
}

export { loadPMMConfig } from './config.js';
export { PMMPaperMM } from './paper-mm.js';
export { PMMBookFeed } from './book-feed.js';
export { MarketSelector } from './market-selector.js';
export { PMMPersistence } from './persistence.js';
export type {
  PMMConfig, PMMFill, PMMPosition, PMMBookSnapshot, PMMStats, PMMMarket, PMMQuote, PMMActiveMarket,
} from './types.js';
