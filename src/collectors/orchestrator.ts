import { EventEmitter } from 'events';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Pool } from 'pg';
import type { NormalizedQuote, Chain } from '../types/index.js';
import { BinanceConnector, CoinbaseConnector, BybitConnector } from './cex/index.js';
import { UniswapV3Connector, type PoolConfig } from './dex/index.js';
import { LstRateOracle, BASE_LST_TOKENS, MAINNET_LST_TOKENS, type LstConfig } from './protocol/index.js';
import { QuoteCache, type QuoteCacheConfig } from '../state/index.js';
import { ChainProvider, BlockWatcher, type RpcEndpoint } from '../chain/index.js';
import { QuotePersistence, HealthPersistence, type QuotePersistenceConfig } from '../persistence/index.js';

export interface CollectorOrchestratorConfig {
  chains: {
    [key in Chain]?: {
      endpoints: RpcEndpoint[];
      enabled: boolean;
    };
  };
  cex: {
    binance?: {
      enabled: boolean;
      pairs: Array<{ symbol: string; canonical: string }>;
    };
    coinbase?: {
      enabled: boolean;
      pairs: Array<{ symbol: string; canonical: string }>;
    };
    bybit?: {
      enabled: boolean;
      pairs: Array<{ symbol: string; canonical: string }>;
    };
  };
  dex: {
    uniswap_v3?: {
      enabled: boolean;
      chains: {
        [key in Chain]?: PoolConfig[];
      };
    };
  };
  protocol?: {
    lstOracle?: {
      enabled: boolean;
      pollIntervalMs: number;
    };
  };
  quoteCache: QuoteCacheConfig;
  quotePersistence: QuotePersistenceConfig;
}

export class CollectorOrchestrator extends EventEmitter {
  private logger: Logger;
  private config: CollectorOrchestratorConfig;
  private pool: Pool;
  private quoteCache: QuoteCache;
  private quotePersistence: QuotePersistence;
  private healthPersistence: HealthPersistence;
  private cexConnectors: Map<string, BinanceConnector | CoinbaseConnector | BybitConnector>;
  private dexConnectors: Map<string, UniswapV3Connector>;
  private protocolConnectors: Map<string, LstRateOracle>;
  private chainProviders: Map<Chain, ChainProvider>;
  private blockWatchers: Map<Chain, BlockWatcher>;
  private venueIdMap: Map<string, number>;
  private pairIdMap: Map<string, number>;

  constructor(config: CollectorOrchestratorConfig, pool: Pool) {
    super();
    this.config = config;
    this.pool = pool;
    this.logger = createChildLogger({ component: 'collector-orchestrator' });
    this.quoteCache = new QuoteCache(config.quoteCache);
    this.quotePersistence = new QuotePersistence(pool, config.quotePersistence);
    this.healthPersistence = new HealthPersistence(pool);
    this.cexConnectors = new Map();
    this.dexConnectors = new Map();
    this.protocolConnectors = new Map();
    this.chainProviders = new Map();
    this.blockWatchers = new Map();
    this.venueIdMap = new Map();
    this.pairIdMap = new Map();
  }

  public async start(): Promise<void> {
    this.logger.info('Starting collector orchestrator');

    await this.loadVenueAndPairMappings();

    await this.startChainProviders();
    await this.startCexConnectors();
    await this.startDexConnectors();
    await this.startProtocolConnectors();

    this.quotePersistence.startRollups();

    this.logger.info('Collector orchestrator started');
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping collector orchestrator');

    for (const connector of this.cexConnectors.values()) {
      await connector.disconnect();
    }

    for (const connector of this.dexConnectors.values()) {
      await connector.stop();
    }

    for (const connector of this.protocolConnectors.values()) {
      await connector.stop();
    }

    for (const watcher of this.blockWatchers.values()) {
      await watcher.stop();
    }

    this.quotePersistence.stopRollups();

    this.logger.info('Collector orchestrator stopped');
  }

  public getQuoteCache(): QuoteCache {
    return this.quoteCache;
  }

  public getDexConnector(chain: Chain): UniswapV3Connector | undefined {
    return this.dexConnectors.get(`uniswap_v3:${chain}`);
  }

  public getDexConnectors(): Map<string, UniswapV3Connector> {
    return this.dexConnectors;
  }

  private async loadVenueAndPairMappings(): Promise<void> {
    const venuesResult = await this.pool.query('SELECT id, name FROM venues');
    for (const row of venuesResult.rows) {
      this.venueIdMap.set(row.name, row.id);
    }

    const pairsResult = await this.pool.query('SELECT id, canonical FROM pairs');
    for (const row of pairsResult.rows) {
      this.pairIdMap.set(row.canonical, row.id);
    }

    this.logger.info(
      { venues: this.venueIdMap.size, pairs: this.pairIdMap.size },
      'Loaded venue and pair mappings'
    );
  }

  private async startChainProviders(): Promise<void> {
    for (const [chain, chainConfig] of Object.entries(this.config.chains)) {
      if (!chainConfig.enabled) continue;

      const provider = new ChainProvider({
        chain: chain as Chain,
        endpoints: chainConfig.endpoints,
      });

      this.chainProviders.set(chain as Chain, provider);

      const blockWatcher = new BlockWatcher(
        { chain: chain as Chain },
        provider
      );

      blockWatcher.on('block', (blockInfo: { blockNumber: bigint; timestamp: number }) => {
        this.quoteCache.updateCurrentBlock(chain as Chain, blockInfo.blockNumber);
      });

      await blockWatcher.start();
      this.blockWatchers.set(chain as Chain, blockWatcher);

      this.logger.info({ chain }, 'Chain provider and block watcher started');
    }
  }

  private async startCexConnectors(): Promise<void> {
    if (this.config.cex.binance?.enabled && this.config.cex.binance.pairs.length > 0) {
      const connector = new BinanceConnector(this.config.cex.binance.pairs);
      this.setupCexConnector(connector, 'binance');
      await connector.connect();
    }

    if (this.config.cex.coinbase?.enabled && this.config.cex.coinbase.pairs.length > 0) {
      const connector = new CoinbaseConnector(this.config.cex.coinbase.pairs);
      this.setupCexConnector(connector, 'coinbase');
      await connector.connect();
    }

    if (this.config.cex.bybit?.enabled && this.config.cex.bybit.pairs.length > 0) {
      const connector = new BybitConnector(this.config.cex.bybit.pairs);
      this.setupCexConnector(connector, 'bybit');
      await connector.connect();
    }
  }

  private async startDexConnectors(): Promise<void> {
    this.logger.info({
      uniswapEnabled: this.config.dex.uniswap_v3?.enabled,
      configuredChains: this.config.dex.uniswap_v3?.enabled ? Object.keys(this.config.dex.uniswap_v3.chains) : [],
      availableProviders: Array.from(this.chainProviders.keys()),
    }, 'Starting DEX connectors');

    if (this.config.dex.uniswap_v3?.enabled) {
      for (const [chain, rawPools] of Object.entries(this.config.dex.uniswap_v3.chains)) {
        if (!rawPools || rawPools.length === 0) {
          this.logger.warn({ chain, poolCount: rawPools?.length ?? 0 }, 'No pools configured for chain');
          continue;
        }

        const provider = this.chainProviders.get(chain as Chain);
        const blockWatcher = this.blockWatchers.get(chain as Chain);

        if (!provider || !blockWatcher) {
          this.logger.warn({
            chain,
            hasProvider: !!provider,
            hasBlockWatcher: !!blockWatcher,
          }, 'Chain provider or block watcher not found, skipping DEX connector');
          continue;
        }

        const initializedPools: PoolConfig[] = [];
        for (const rawPool of rawPools) {
          try {
            const poolAddress = (rawPool as { poolAddress?: string; address?: string }).poolAddress ||
                               (rawPool as { address?: string }).address;
            if (!poolAddress) {
              this.logger.warn({ chain, rawPool }, 'Pool address not found in config');
              continue;
            }
            const pool = await UniswapV3Connector.initializePool(
              poolAddress as `0x${string}`,
              provider,
              (rawPool as { feeTier?: number }).feeTier || 3000,
              (rawPool as { canonical?: string }).canonical || ''
            );
            initializedPools.push(pool);
            this.logger.info({ chain, pool: poolAddress, canonical: pool.canonical }, 'Pool initialized');
          } catch (error) {
            this.logger.error({ chain, rawPool, error: (error as Error).message }, 'Failed to initialize pool');
          }
        }

        if (initializedPools.length === 0) {
          this.logger.warn({ chain }, 'No pools initialized, skipping connector');
          continue;
        }

        const connector = new UniswapV3Connector(
          {
            chain: chain as Chain,
            pools: initializedPools,
          },
          provider,
          blockWatcher
        );

        connector.on('quote', (quote: NormalizedQuote) => {
          this.handleDexQuote(quote, 'uniswap_v3');
        });

        connector.on('connected', (data: { venue: string; chain: Chain }) => {
          const venueId = this.venueIdMap.get(data.venue);
          if (venueId) {
            this.healthPersistence.markConnectorConnected(venueId, data.chain);
          }
          this.logger.info({ venue: data.venue, chain: data.chain }, 'DEX connector connected');
        });

        connector.on('error', (data: { venue: string; chain: Chain; error: string }) => {
          this.logger.error({ venue: data.venue, chain: data.chain, error: data.error }, 'DEX connector error');
        });

        await connector.start();
        this.dexConnectors.set(`uniswap_v3:${chain}`, connector);

        this.logger.info({ chain, pools: initializedPools.length }, 'Uniswap V3 connector started');
      }
    }
  }

  private async startProtocolConnectors(): Promise<void> {
    if (!this.config.protocol?.lstOracle?.enabled) {
      this.logger.info('LST rate oracle disabled');
      return;
    }

    const pollIntervalMs = this.config.protocol.lstOracle.pollIntervalMs || 10000;

    for (const [chain, provider] of this.chainProviders.entries()) {
      const tokens: LstConfig[] = chain === 'base' ? BASE_LST_TOKENS : MAINNET_LST_TOKENS;

      if (tokens.length === 0) {
        continue;
      }

      const client = provider.getPublicClient();
      const oracle = new LstRateOracle(
        {
          chain,
          tokens,
          pollIntervalMs,
        },
        client
      );

      oracle.on('quote', (quote: NormalizedQuote) => {
        this.handleProtocolQuote(quote);
      });

      oracle.on('connected', (data: { venue: string; chain: Chain }) => {
        this.logger.info({ venue: data.venue, chain: data.chain }, 'Protocol oracle connected');
      });

      await oracle.start();
      this.protocolConnectors.set(`lst:${chain}`, oracle);

      this.logger.info({ chain, tokens: tokens.map((t) => t.symbol) }, 'LST rate oracle started');
    }
  }

  private handleProtocolQuote(quote: NormalizedQuote): void {
    const venueId = this.venueIdMap.get('protocol');
    const pairId = this.pairIdMap.get(quote.pair);

    this.quoteCache.updateQuote(quote);

    if (venueId && pairId) {
      this.quotePersistence.insertRawQuote(quote, venueId, pairId).catch((err) => {
        this.logger.error({ error: (err as Error).message, pair: quote.pair }, 'Failed to persist protocol quote');
      });
    }

    this.emit('protocolQuote', quote);
  }

  private setupCexConnector(
    connector: BinanceConnector | CoinbaseConnector | BybitConnector,
    venue: string
  ): void {
    connector.on('quote', (quote: NormalizedQuote) => {
      this.handleCexQuote(quote);
    });

    connector.on('connected', () => {
      const venueId = this.venueIdMap.get(venue);
      if (venueId) {
        this.healthPersistence.markConnectorConnected(venueId);
      }
      this.logger.info({ venue }, 'CEX connector connected');
    });

    connector.on('disconnected', (data: { venue: string; planned: boolean }) => {
      const venueId = this.venueIdMap.get(venue);
      if (venueId) {
        this.healthPersistence.markConnectorDisconnected(venueId);
        if (!data.planned) {
          this.healthPersistence.incrementReconnectCount(venueId);
        }
      }
      this.logger.warn({ venue, planned: data.planned }, 'CEX connector disconnected');
    });

    connector.on('error', (data: { venue: string; error: string }) => {
      const venueId = this.venueIdMap.get(venue);
      if (venueId) {
        this.healthPersistence.incrementErrorCount(venueId);
      }
      this.logger.error({ venue: data.venue, error: data.error }, 'CEX connector error');
    });

    this.cexConnectors.set(venue, connector);
  }

  private handleCexQuote(quote: NormalizedQuote): void {
    this.quoteCache.updateQuote(quote);
    this.emit('quote', quote);

    const venueId = this.venueIdMap.get(quote.venue);
    const pairId = this.pairIdMap.get(quote.pair);

    if (venueId && pairId) {
      this.quotePersistence.insertRawQuote(quote, venueId, pairId);
      this.healthPersistence.updateLastQuote(venueId, undefined);
    }
  }

  private handleDexQuote(quote: NormalizedQuote, venue: string): void {
    this.logger.info(
      { venue, pair: quote.pair, mid: quote.mid, blockNumber: quote.blockNumber?.toString() },
      'Received DEX quote in orchestrator'
    );

    this.quoteCache.updateQuote(quote);
    this.emit('quote', quote);

    const venueId = this.venueIdMap.get(venue);
    const pairId = this.pairIdMap.get(quote.pair);

    this.logger.info(
      { venue, venueId, pair: quote.pair, pairId, hasChain: !!quote.chain },
      'Looking up venue and pair IDs'
    );

    if (venueId && pairId && quote.chain) {
      this.logger.info(
        { venue, venueId, pair: quote.pair, pairId, chain: quote.chain },
        'Persisting DEX quote'
      );
      this.quotePersistence.insertRawQuote(quote, venueId, pairId);
      this.healthPersistence.updateLastQuote(venueId, quote.chain, quote.blockNumber);
    } else {
      this.logger.warn(
        { venue, venueId, pair: quote.pair, pairId, chain: quote.chain },
        'Skipping DEX quote persistence due to missing venueId, pairId, or chain'
      );
    }
  }
}
