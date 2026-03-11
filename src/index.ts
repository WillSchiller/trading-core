import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, type Address } from 'viem';
import { base, mainnet } from 'viem/chains';
import { logger } from './utils/logger.js';
import { getConfig } from './config/index.js';
import { createPool, closePool, getPool } from './persistence/client.js';
import { runMigrations } from './persistence/migrate.js';
import { CollectorOrchestrator } from './collectors/orchestrator.js';
import { OpportunityDetector } from './detection/index.js';
import { RankSpaceDetector } from './detection/rank-space/index.js';
import { ExecutionManager, SlippageCalibrator, type TokenConfig } from './execution/index.js';
import { PCAStatArbMonitor, PCAPersistence, MarketContextService, VolumeTracker } from './research/index.js';
import { PaperMarketMaker } from './execution/market-maker/index.js';
import { PerpsExecutor, BinanceFuturesClient, HyperliquidClient } from './execution/perps/index.js';
import type { PerpsExchangeClient } from './execution/perps/types.js';
import type { Chain } from './types/index.js';
import type { RpcEndpoint } from './chain/provider-pool.js';
import type { PoolConfig } from './config/types.js';

interface ChainRpcConfig {
  endpoints: RpcEndpoint[];
  enabled: boolean;
}

interface CexPairConfig {
  symbol: string;
  canonical: string;
}

interface CexConnectorConfig {
  enabled: boolean;
  pairs: CexPairConfig[];
}

interface UniswapPoolConfig {
  poolAddress: string;
  canonical: string;
  feeTier: number;
  isPrimary: boolean;
}

interface DexConnectorConfig {
  enabled: boolean;
  chains: Record<string, UniswapPoolConfig[]>;
}
import { checkNtpSync } from './utils/clock.js';
import { initAlerts, sendAlert } from './utils/alerts.js';
import { buildRpcEndpoints } from './chain/index.js';

const BASE_TOKENS: Record<string, TokenConfig> = {
  WETH: {
    address: '0x4200000000000000000000000000000000000006' as Address,
    decimals: 18,
    symbol: 'WETH',
  },
  USDC: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    decimals: 6,
    symbol: 'USDC',
  },
  USDbC: {
    address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' as Address,
    decimals: 6,
    symbol: 'USDbC',
  },
  cbETH: {
    address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' as Address,
    decimals: 18,
    symbol: 'cbETH',
  },
  weETH: {
    address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A' as Address,
    decimals: 18,
    symbol: 'weETH',
  },
  wstETH: {
    address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452' as Address,
    decimals: 18,
    symbol: 'wstETH',
  },
  rETH: {
    address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c' as Address,
    decimals: 18,
    symbol: 'rETH',
  },
  cbBTC: {
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as Address,
    decimals: 8,
    symbol: 'cbBTC',
  },
};

const MAINNET_TOKENS: Record<string, TokenConfig> = {
  WETH: {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
    decimals: 18,
    symbol: 'WETH',
  },
  USDC: {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address,
    decimals: 6,
    symbol: 'USDC',
  },
  wstETH: {
    address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as Address,
    decimals: 18,
    symbol: 'wstETH',
  },
  rETH: {
    address: '0xae78736Cd615f374D3085123A210448E74Fc6393' as Address,
    decimals: 18,
    symbol: 'rETH',
  },
  cbETH: {
    address: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704' as Address,
    decimals: 18,
    symbol: 'cbETH',
  },
};

function buildTokenMap(chain: Chain): Map<string, TokenConfig> {
  const tokenMap = new Map<string, TokenConfig>();
  const tokens = chain === 'base' ? BASE_TOKENS : MAINNET_TOKENS;

  for (const [symbol, config] of Object.entries(tokens)) {
    tokenMap.set(symbol, config);
  }

  return tokenMap;
}

async function main() {
  logger.info('Starting dislocation-trader');

  const ntpStatus = await checkNtpSync();
  logger.info(
    {
      isSynced: ntpStatus.isSynced,
      service: ntpStatus.service,
      offsetMs: ntpStatus.offsetMs,
      details: ntpStatus.details,
    },
    'NTP clock sync status'
  );

  if (!ntpStatus.isSynced) {
    logger.warn('NTP clock not synchronized - timestamp accuracy may be degraded');
  }

  const config = getConfig();

  const telegramEnabled = !!config.env.telegram;
  initAlerts({
    enabled: telegramEnabled,
    telegramBotToken: config.env.telegram?.botToken,
    telegramChatId: config.env.telegram?.chatId,
  });
  logger.info({
    paperMode: config.env.paperMode,
    enableBase: config.env.enableBase,
    enableMainnet: config.env.enableMainnet,
    telegramEnabled,
    telegramChatId: config.env.telegram?.chatId ? `${config.env.telegram.chatId.slice(0, 4)}...` : 'not set',
  }, 'Config loaded');

  logger.info({
    gitSha: process.env.GIT_SHA ?? 'unknown',
    nodeEnv: process.env.NODE_ENV,
    enableBase: config.env.enableBase,
    enableMainnet: config.env.enableMainnet,
    enableExecution: config.env.enableExecution,
    perpsEnabled: config.app.perpsExecution?.enabled ?? false,
    pcaEnabled: config.app.research?.pcaStatArb?.enabled ?? false,
    runIds: config.app.perpsExecution?.runs?.map(r => r.runId) ?? [],
  }, 'Observatory boot');

  if (telegramEnabled) {
    sendAlert('🚀 *Dislocation Trader Started*\n\nSystem initialized successfully.', 'info')
      .then(() => logger.info('Startup alert sent'))
      .catch((err) => logger.error({ error: (err as Error).message }, 'Failed to send startup alert'));
  }

  createPool(config.env.postgres);
  logger.info('Database pool initialized');

  const pool = getPool();

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sqlDir = join(__dirname, '..', 'sql');
  await runMigrations(pool, sqlDir);


  const chainConfigs: Record<string, ChainRpcConfig> = {};
  for (const [chainName, chainConfig] of Object.entries(config.app.chains)) {
    const envEnabled = chainName === 'mainnet' ? config.env.enableMainnet
      : chainName === 'base' ? config.env.enableBase
      : false;
    const isEnabled = envEnabled !== undefined ? envEnabled : chainConfig.enabled;
    logger.info({
      chain: chainName,
      configEnabled: chainConfig.enabled,
      envEnabled,
      isEnabled,
    }, 'Chain enable check');
    if (isEnabled) {
      try {
        const endpoints = buildRpcEndpoints(chainName as Chain, config.env);
        chainConfigs[chainName] = {
          endpoints,
          enabled: true,
        };
        logger.info({ chain: chainName, endpointCount: endpoints.length }, 'RPC endpoints configured');
      } catch (error) {
        logger.error(
          { chain: chainName, error: (error as Error).message },
          'Failed to configure RPC endpoints'
        );
      }
    }
  }
  logger.info({ enabledChains: Object.keys(chainConfigs) }, 'Chain configuration complete');

  const cexConfigs: Record<string, CexConnectorConfig> = {};

  if (config.app.venues.cex.binance.enabled) {
    cexConfigs.binance = {
      enabled: true,
      pairs: config.pairs
        .filter(p => (p.enabled !== false || p.researchOnly) && p.venues.binance)
        .map(p => ({
          symbol: (p.venues.binance as { symbol: string }).symbol,
          canonical: `${p.base}/${p.quote}`,
        })),
    };
  }

  if (config.app.venues.cex.coinbase.enabled) {
    cexConfigs.coinbase = {
      enabled: true,
      pairs: config.pairs
        .filter(p => p.enabled !== false && p.venues.coinbase)
        .map(p => ({
          symbol: (p.venues.coinbase as { symbol: string }).symbol,
          canonical: `${p.base}/${p.quote}`,
        })),
    };
  }

  if (config.app.venues.cex.bybit.enabled) {
    cexConfigs.bybit = {
      enabled: true,
      pairs: config.pairs
        .filter(p => p.enabled !== false && p.venues.bybit)
        .map(p => ({
          symbol: (p.venues.bybit as { symbol: string }).symbol,
          canonical: `${p.base}/${p.quote}`,
        })),
    };
  }

  if (config.app.venues.cex.hyperliquid?.enabled) {
    const hlAssets = config.app.research?.pcaStatArb?.assets || ['ETH', 'BTC', 'SOL', 'AVAX', 'ARB', 'OP', 'LINK', 'UNI', 'AAVE', 'ATOM', 'SUI', 'DOT'];
    cexConfigs.hyperliquid = {
      enabled: true,
      pairs: hlAssets.map(asset => ({
        symbol: asset,
        canonical: asset === 'ETH' ? 'WETH/USDC' : asset === 'BTC' ? 'WBTC/USDC' : `${asset}/USDC`,
      })),
    };
  }

  const dexConfigs: Record<string, DexConnectorConfig> = {};

  if (config.app.venues.dex.uniswap_v3.enabled) {
    const uniswapChains: Record<string, UniswapPoolConfig[]> = {};

    for (const pairConfig of config.pairs) {
      if (pairConfig.enabled === false) continue;
      const chain = pairConfig.chain;
      const uniV3Venues = pairConfig.venues.uniswap_v3 as Record<string, PoolConfig[]> | undefined;

      if (!uniV3Venues || !uniV3Venues[chain]) continue;

      if (!uniswapChains[chain]) {
        uniswapChains[chain] = [];
      }

      const chainPools = uniV3Venues[chain];
      for (const poolConfig of chainPools) {
        uniswapChains[chain].push({
          poolAddress: poolConfig.pool,
          canonical: `${pairConfig.base}/${pairConfig.quote}`,
          feeTier: poolConfig.feeTier ?? 0,
          isPrimary: poolConfig.primary === true,
        });
      }
    }

    dexConfigs.uniswap_v3 = {
      enabled: true,
      chains: uniswapChains,
    };
  }

  const orchestrator = new CollectorOrchestrator(
    {
      chains: chainConfigs,
      cex: cexConfigs,
      dex: dexConfigs,
      protocol: config.app.venues.protocol,
      quoteCache: {
        cexStaleThresholdMs: config.app.system.quoteStaleThresholdMs,
        dexBlockLagThreshold: config.app.system.dexBlockLagThreshold ?? 2,
        maxFutureTsMs: config.app.system.maxFutureTsMs,
        maxPastTsMs: config.app.system.maxPastTsMs,
        thinMarketPairs: config.pairs
          .filter(p => p.thresholds.thinMarketMode)
          .map(p => ({
            pair: `${p.base}/${p.quote}`,
            maxQuoteAgeMs: p.thresholds.maxQuoteAgeMs ?? 300000,
          })),
      },
      quotePersistence: {
        sampleRate: config.app.system.rawQuoteSampleRate,
        rollupIntervals: config.app.system.rollupIntervals,
      },
    },
    pool
  );

  await orchestrator.start();
  logger.info('Collector orchestrator started');

  interface VenueRow {
    id: number;
    name: string;
  }
  const venueIdMapQuery = await pool.query<VenueRow>('SELECT id, name FROM venues');
  const venueIdMap = new Map<string, number>();
  for (const row of venueIdMapQuery.rows) {
    venueIdMap.set(row.name, row.id);
  }

  interface PairRow {
    id: number;
    canonical: string;
  }
  const pairIdMapQuery = await pool.query<PairRow>('SELECT id, canonical FROM pairs');
  const pairIdMap = new Map<string, number>();
  for (const row of pairIdMapQuery.rows) {
    pairIdMap.set(row.canonical, row.id);
  }

  const detector = new OpportunityDetector({
    quoteCache: orchestrator.getQuoteCache(),
    appConfig: config.app,
    pairsConfig: config.pairs,
    venueIdMap,
    pairIdMap,
    onSpreadUpdate: (chain, _pair, spreadBps, thresholdBps) => {
      const connector = orchestrator.getDexConnector(chain);
      if (connector) {
        connector.updateSpreadProximity(spreadBps, thresholdBps);
      }
    },
  });

  detector.start();
  logger.info('Opportunity detector started');

  const emitter = detector.getEmitter();

  const rankSpaceDetector = new RankSpaceDetector({
    quoteCache: orchestrator.getQuoteCache(),
    appConfig: config.app,
    pairsConfig: config.pairs,
    venueIdMap,
    pairIdMap,
    emitter,
  });

  rankSpaceDetector.start();
  logger.info('RankSpace detector started');

  const executionManagers: Map<Chain, ExecutionManager> = new Map();
  const slippageCalibrators: SlippageCalibrator[] = [];

  if (config.env.enableExecution) {
    for (const [chainName, chainConfig] of Object.entries(config.app.chains)) {
      const envEnabled = chainName === 'mainnet' ? config.env.enableMainnet
        : chainName === 'base' ? config.env.enableBase
        : false;
      const isEnabled = envEnabled !== undefined ? envEnabled : chainConfig.enabled;
      if (!isEnabled) continue;

      const chain = chainName as Chain;
      const endpoints = buildRpcEndpoints(chain, config.env);
      const primaryEndpoint = endpoints.sort((a, b) => a.priority - b.priority)[0];
      const httpUrl = primaryEndpoint.httpUrl;

      const viemChain = chain === 'base' ? base : mainnet;
      const publicClient = createPublicClient({
        chain: viemChain,
        transport: http(httpUrl),
      });

      const tokenMap = buildTokenMap(chain);

      const executionManager = new ExecutionManager({
        chain,
        publicClient: publicClient as any,
        appConfig: config.app,
        pairsConfig: config.pairs.filter((p) => p.enabled !== false && p.chain === chain),
        quoterAddress: chainConfig.contracts.uniswapV3QuoterV2 as Address,
        routerAddress: chainConfig.contracts.uniswapV3Router as Address,
        httpUrl,
        privateKey: config.env.executorPrivateKey,
        paperMode: config.env.paperMode,
        tokenMap,
        pairIdMap,
        quoteCache: orchestrator.getQuoteCache(),
      });

      executionManager.subscribeToOpportunities(emitter);
      executionManager.start();
      executionManagers.set(chain, executionManager);

      logger.info(
        {
          chain,
          paperMode: config.env.paperMode,
          quoterAddress: chainConfig.contracts.uniswapV3QuoterV2,
          routerAddress: chainConfig.contracts.uniswapV3Router,
        },
        'Execution manager started'
      );

      const calibratorPools = config.pairs
        .filter((p) => p.enabled !== false && p.chain === chain)
        .flatMap((pairConfig) => {
          const uniV3Venues = pairConfig.venues.uniswap_v3 as Record<string, PoolConfig[]> | undefined;
          if (!uniV3Venues || !uniV3Venues[chain]) return [];

          const baseToken = tokenMap.get(pairConfig.base);
          const quoteToken = tokenMap.get(pairConfig.quote);
          if (!baseToken || !quoteToken) return [];

          const baseAddr = baseToken.address.toLowerCase();
          const quoteAddr = quoteToken.address.toLowerCase();
          const baseIsToken0 = baseAddr < quoteAddr;

          return uniV3Venues[chain].map((poolCfg: PoolConfig) => ({
            address: poolCfg.pool as `0x${string}`,
            feeTierBps: (poolCfg.feeTier ?? 0) / 100,
            token0: (baseIsToken0 ? baseToken.address : quoteToken.address) as `0x${string}`,
            token1: (baseIsToken0 ? quoteToken.address : baseToken.address) as `0x${string}`,
            token0Decimals: baseIsToken0 ? baseToken.decimals : quoteToken.decimals,
            token1Decimals: baseIsToken0 ? quoteToken.decimals : baseToken.decimals,
            token0Symbol: baseIsToken0 ? pairConfig.base : pairConfig.quote,
            token1Symbol: baseIsToken0 ? pairConfig.quote : pairConfig.base,
          }));
        });

      if (calibratorPools.length > 0) {
        const calibrator = new SlippageCalibrator(
          {
            chain,
            quoterAddress: chainConfig.contracts.uniswapV3QuoterV2 as `0x${string}`,
            pools: calibratorPools,
            notionalSizes: [100, 500, 1000, 2000, 4000],
            edgeBufferBps: 10,
            gasUsd: 0.05,
          },
          publicClient as any
        );
        calibrator.startPeriodicCalibration(5 * 60 * 1000);
        slippageCalibrators.push(calibrator);
        logger.info({ chain, pools: calibratorPools.length }, 'Slippage calibrator started');
      }
    }
  } else {
    emitter.on('opportunity_detected', (opportunity) => {
      const pairName = Array.from(pairIdMap.entries()).find(([, id]) => id === opportunity.pairId)?.[0];
      logger.info(
        {
          pair: pairName,
          spreadBps: opportunity.spreadBps,
          direction: opportunity.direction,
          chain: opportunity.chain,
          anchorMid: opportunity.anchorMid,
          dexMid: opportunity.dexMid,
        },
        'Opportunity detected (execution disabled)'
      );
    });
  }

  // PCA Statistical Arbitrage Monitor (Hyperliquid prices only)
  let pcaMonitor: PCAStatArbMonitor | null = null;
  let pcaPersistence: PCAPersistence | null = null;
  let marketContext: MarketContextService | null = null;
  let volumeTracker: VolumeTracker | null = null;
  let paperMM: PaperMarketMaker | null = null;

  if (config.app.research?.pcaStatArb?.enabled) {
    const pcaConfig = config.app.research.pcaStatArb;
    pcaPersistence = new PCAPersistence(pool);
    pcaMonitor = new PCAStatArbMonitor(pcaConfig);

    // Build pair→asset mapping dynamically from PCA config
    const pairToAsset: Record<string, string> = {
      'WETH/USDC': 'ETH',
      'WBTC/USDC': 'BTC',
      'cbBTC/USDC': 'BTC',
    };
    for (const asset of pcaConfig.assets) {
      pairToAsset[`${asset}/USDC`] = asset;
    }

    // Subscribe to Hyperliquid quotes from orchestrator for PCA assets
    const lastPriceSave: Record<string, number> = {};
    orchestrator.on('quote', (quote: { venue: string; pair: string; mid: number }) => {
      if (quote.venue !== 'hyperliquid') return;
      const asset = pairToAsset[quote.pair];
      if (!asset || !pcaMonitor) return;

      pcaMonitor.updatePrice(asset, quote.mid);
      const now = Date.now();
      if (pcaPersistence && (!lastPriceSave[asset] || now - lastPriceSave[asset] > 10000)) {
        lastPriceSave[asset] = now;
        pcaPersistence.savePrice(asset, quote.mid).catch(() => {});
      }
    });

    // Start market context service for multi-signal research
    marketContext = new MarketContextService(pool, pcaConfig.assets);
    await marketContext.start(60000);

    // Start volume tracker for trade-level data collection
    volumeTracker = new VolumeTracker(pool, pcaConfig.assets);
    await volumeTracker.start();

    // Start paper market maker if enabled
    if (process.env.PAPER_MM_ENABLED === 'true') {
      const mmAssets = (process.env.MM_ASSETS || 'kPEPE,ARB,POPCAT,MOODENG,SAGA,DYM,MEME,MANTA,IO').split(',');
      // Side filter from env: "kPEPE:buy,DYM:sell,MOODENG:both"
      const sideFilterMap: Record<string, 'both' | 'buy' | 'sell'> = {};
      const sideFilterStr = process.env.MM_SIDE_FILTER || '';
      if (sideFilterStr) {
        for (const entry of sideFilterStr.split(',')) {
          const [asset, side] = entry.split(':');
          if (asset && (side === 'both' || side === 'buy' || side === 'sell')) {
            sideFilterMap[asset] = side;
          }
        }
      }

      paperMM = new PaperMarketMaker({
        assets: mmAssets,
        assetSideFilter: Object.keys(sideFilterMap).length > 0 ? sideFilterMap : undefined,
        positionSizeUsd: Number(process.env.MM_POSITION_SIZE_USD || '200'),
        maxInventoryUsd: Number(process.env.MM_MAX_INVENTORY_USD || '500'),
        requoteIntervalMs: 5000,
        minSpreadBps: Number(process.env.MM_MIN_SPREAD_BPS || '3'),
        skewBpsPerUnit: 1,
        maxOpenOrders: 4,
        paperMode: true,
        gamma: Number(process.env.MM_GAMMA || '0.3'),
        ofiThreshold: Number(process.env.MM_OFI_THRESHOLD || '0.6'),
        vpinThreshold: Number(process.env.MM_VPIN_THRESHOLD || '0.7'),
        volCutoffPct: Number(process.env.MM_VOL_CUTOFF_PCT || '95'),
      }, pool);
      await paperMM.start();
      logger.info({ assets: mmAssets }, 'Paper market maker started');
    }

    pcaMonitor.setMarketContextProvider((asset) => marketContext?.getContext(asset));

    // Helper to wire persistence for a PCA monitor
    const wirePcaPersistence = (monitor: PCAStatArbMonitor, source: string) => {
      monitor.on('signal', async (event) => {
        try {
          if (pcaPersistence) {
            const ctx = marketContext?.getContextSnapshot(event.asset) ?? null;
            if (ctx && volumeTracker) {
              const rv = volumeTracker.getRelativeVolume(event.asset);
              const bsr = volumeTracker.getBuySellRatio(event.asset);
              if (rv !== undefined) ctx.relativeVolume = rv;
              if (bsr !== undefined) ctx.buySellRatio = bsr;
            }
            await pcaPersistence.saveSignal({ ...event, marketContext: ctx });
          }
        } catch (err) {
          logger.error({ error: (err as Error).message, source }, 'Failed to save PCA signal');
        }
      });

      monitor.on('exit', async (event) => {
        try {
          if (pcaPersistence) {
            await pcaPersistence.resolveSignal(event);
          }
        } catch (err) {
          logger.error({ error: (err as Error).message, source }, 'Failed to resolve PCA signal');
        }
      });

      monitor.on('shadow_exit', async (event) => {
        try {
          if (pcaPersistence) {
            await pcaPersistence.resolveShadow(event);
          }
        } catch (err) {
          logger.error({ error: (err as Error).message, source }, 'Failed to resolve shadow position');
        }
      });

      monitor.on('benchmark_signal', async (event) => {
        try {
          if (pcaPersistence) {
            await pcaPersistence.saveBenchmarkSignal(event);
          }
        } catch (err) {
          logger.error({ error: (err as Error).message, source }, 'Failed to save benchmark signal');
        }
      });

      monitor.on('benchmark_exit', async (event) => {
        try {
          if (pcaPersistence) {
            await pcaPersistence.resolveBenchmarkSignal(event);
          }
        } catch (err) {
          logger.error({ error: (err as Error).message, source }, 'Failed to resolve benchmark signal');
        }
      });

      monitor.on('factorModel', async (model) => {
        try {
          if (pcaPersistence) {
            await pcaPersistence.saveFactorModel(model);
          }
        } catch (err) {
          logger.error({ error: (err as Error).message, source }, 'Failed to save PCA factor model');
        }
      });

      let residualTick = 0;
      monitor.on('residuals', async (signals) => {
        try {
          if (pcaPersistence) {
            await pcaPersistence.saveResiduals(signals);
            const prices = monitor.getCurrentPrices();
            if (Object.keys(prices).length > 0) {
              await pcaPersistence.updateCurrentPrices(prices);
            }
            if (++residualTick % 5 === 0) {
              const metrics = monitor.getRegimeMetrics();
              if (metrics) await pcaPersistence.saveRegimeMetrics(metrics);
            }
          }
        } catch (err) {
          logger.error({ error: (err as Error).message, source }, 'Failed to save PCA residuals');
        }
      });
    };

    wirePcaPersistence(pcaMonitor, 'hyperliquid');

    // Load price history from database for faster warmup
    try {
      const lookbackMs = pcaConfig.returnWindowMs * pcaConfig.pcaLookbackPeriods * 2;
      const priceHistory = await pcaPersistence.loadPriceHistory(pcaConfig.assets, lookbackMs);
      pcaMonitor.loadPriceHistory(priceHistory);
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to load price history');
    }

    // Cleanup orphaned positions (multiple unresolved per asset) before loading
    try {
      const orphanMaxStaleMs = pcaConfig.orphanCleanup?.maxStaleMs ?? 7200000;
      await pcaPersistence.cleanupOrphanedPositions(orphanMaxStaleMs);
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to cleanup orphaned positions');
    }

    // Load existing open positions from database before starting
    try {
      const activePositions = await pcaPersistence.getActiveSignals();
      if (activePositions.length > 0) {
        pcaMonitor.loadPositions(activePositions);
        logger.info({ count: activePositions.length }, 'Loaded active PCA positions from database');
      }
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to load active PCA positions');
    }

    // Start monitor
    pcaMonitor.start();
    pcaMonitor.on('residuals', async () => {
      if (!pcaMonitor || !pcaPersistence) return;
      try {
        const prices = pcaMonitor.getCurrentPricesSnapshot();
        if (Object.keys(prices).length > 0) {
          await pcaPersistence.savePriceHistory(prices, Date.now());
        }
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'Failed to save price history');
      }
    });
    logger.info(
      { assets: pcaConfig.assets, numFactors: pcaConfig.numFactors, entryZScore: pcaConfig.entryZScore },
      'PCA stat-arb monitor started (hyperliquid)'
    );

    // Update open signal prices every 30 seconds
    setInterval(async () => {
      if (pcaPersistence) {
        try {
          await pcaPersistence.updateOpenSignalPrices();
        } catch (err) {
          logger.error({ error: (err as Error).message }, 'Failed to update open signal prices');
        }
      }
    }, 30000);
  }

  // Perps Execution Layer — supports multiple runs (paper + live side-by-side)
  const perpsExecutors: PerpsExecutor[] = [];

  if (config.app.perpsExecution?.enabled) {
    logger.warn('Perps execution is ENABLED — this should be false in observatory mode');
  }

  if (config.app.perpsExecution?.enabled && pcaMonitor) {
    const perpsConfig = config.app.perpsExecution;
    const futuresKey = config.env.binanceFutures.apiKey;
    const futuresSecret = config.env.binanceFutures.apiSecret;
    const hlPrivateKey = config.env.hyperliquid.privateKey;

    if (perpsConfig.runs.length === 0) {
      logger.warn('Perps execution enabled but no runs configured in perpsExecution.runs[]');
    } else {
      for (const run of perpsConfig.runs) {
        const exchange = run.exchange ?? 'binance';
        let client: PerpsExchangeClient;

        try {
          if (exchange === 'hyperliquid') {
            if (!hlPrivateKey) {
              logger.warn({ runId: run.runId }, 'Hyperliquid run but HYPERLIQUID_PRIVATE_KEY not set, skipping');
              continue;
            }
            client = new HyperliquidClient({
              privateKey: hlPrivateKey,
              paperMode: run.paperMode,
              paperFill: run.paperFill ?? perpsConfig.paperFill,
            });
          } else {
            if (!futuresKey || !futuresSecret) {
              logger.warn({ runId: run.runId }, 'Binance run but BINANCE_FUTURES_API_KEY/SECRET not set, skipping');
              continue;
            }
            client = new BinanceFuturesClient({
              apiKey: futuresKey,
              apiSecret: futuresSecret,
              paperMode: run.paperMode,
              paperFill: run.paperFill ?? perpsConfig.paperFill,
            });
          }
        } catch (err) {
          logger.error({ error: (err as Error).message, runId: run.runId, exchange }, 'Failed to create exchange client — skipping run');
          continue;
        }

        const resolvedConfig = {
          enabled: perpsConfig.enabled,
          paperMode: run.paperMode,
          leverage: run.leverage ?? perpsConfig.leverage,
          marginType: run.marginType ?? perpsConfig.marginType,
          enableLongs: run.enableLongs ?? perpsConfig.enableLongs,
          enableShorts: run.enableShorts ?? perpsConfig.enableShorts,
          maxConcurrentPositions: run.maxConcurrentPositions ?? perpsConfig.maxConcurrentPositions,
          maxPositionSizeUsd: run.maxPositionSizeUsd ?? perpsConfig.maxPositionSizeUsd,
          minPositionSizeUsd: run.minPositionSizeUsd ?? perpsConfig.minPositionSizeUsd,
          maxTotalExposureUsd: run.maxTotalExposureUsd ?? perpsConfig.maxTotalExposureUsd,
          cooldownMs: run.cooldownMs ?? perpsConfig.cooldownMs,
          heartbeatIntervalMs: perpsConfig.heartbeatIntervalMs,
          positionSyncIntervalMs: perpsConfig.positionSyncIntervalMs,
          maxHoldTimeMsShort: run.maxHoldTimeMsShort ?? perpsConfig.maxHoldTimeMsShort,
          maxHoldTimeMsLong: run.maxHoldTimeMsLong ?? perpsConfig.maxHoldTimeMsLong,
          heartbeatStopLossBps: perpsConfig.heartbeatStopLossBps,
          trailingStop: perpsConfig.trailingStop,
          stallExitMs: perpsConfig.stallExitMs,
          stallExitMinPeakBps: perpsConfig.stallExitMinPeakBps,
          maxPC1DisplacementBps: run.maxPC1DisplacementBps,
          orderType: run.orderType ?? perpsConfig.orderType,
          makerTimeoutMs: run.makerTimeoutMs ?? perpsConfig.makerTimeoutMs,
          exitMakerTimeoutMs: run.exitMakerTimeoutMs ?? perpsConfig.exitMakerTimeoutMs,
          exitFallbackToTaker: run.exitFallbackToTaker ?? perpsConfig.exitFallbackToTaker,
          killSwitch: run.killSwitch ?? perpsConfig.killSwitch,
          paperFill: run.paperFill ?? perpsConfig.paperFill,
          excludeAssets: run.excludeAssets,
        };

        const executor = new PerpsExecutor(resolvedConfig, pool, client, run.runId);
        perpsExecutors.push(executor);
        logger.info({ runId: run.runId, paperMode: run.paperMode, exchange }, 'Configured perps run');
      }

      // Wire all executors to the PCA monitor
      if (perpsExecutors.length > 0) {
        pcaMonitor.on('signal', async (event) => {
          const results = await Promise.allSettled(
            perpsExecutors.map(ex => ex.handleSignal(event))
          );
          for (const [i, result] of results.entries()) {
            if (result.status === 'rejected') {
              logger.error({ error: (result.reason as Error).message, asset: event.asset, runId: perpsExecutors[i].getRunId() }, 'Perps handleSignal error');
            }
          }
        });

        pcaMonitor.on('exit', async (event) => {
          const results = await Promise.allSettled(
            perpsExecutors.map(ex => ex.handleExit(event))
          );
          for (const [i, result] of results.entries()) {
            if (result.status === 'rejected') {
              logger.error({ error: (result.reason as Error).message, asset: event.asset, runId: perpsExecutors[i].getRunId() }, 'Perps handleExit error');
            }
          }
        });
      }

      // Start all executors
      const allExecutors = perpsExecutors;
      for (const ex of allExecutors) {
        try {
          await ex.start();
          orchestrator.on('quote', ex.getPriceCallback());
          logger.info({ mode: ex.getMode(), runId: ex.getRunId() }, 'Perps executor started');
        } catch (err) {
          logger.error({ error: (err as Error).message, runId: ex.getRunId() }, 'Perps executor failed to start — skipping run');
        }
      }
    }
  }

  // Health endpoint for Docker healthcheck
  const healthServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        gitSha: process.env.GIT_SHA ?? 'unknown',
        uptime: process.uptime(),
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(8080);
  logger.info('Health endpoint listening on :8080');

  // Observatory heartbeat — write stats every 60s
  let heartbeatQuotesSeen = 0;
  let heartbeatSignalsWritten = 0;
  orchestrator.on('quote', () => { heartbeatQuotesSeen++; });
  if (pcaMonitor) pcaMonitor.on('signal', () => { heartbeatSignalsWritten++; });

  const heartbeatInterval = setInterval(async () => {
    try {
      const pcaAssets = config.app.research?.pcaStatArb?.assets?.length ?? 0;
      await pool.query(
        `INSERT INTO observatory_heartbeat (quotes_seen_1m, signals_written_1m, active_positions, pca_assets_tracked)
         VALUES ($1, $2, $3, $4)`,
        [heartbeatQuotesSeen, heartbeatSignalsWritten, 0, pcaAssets]
      );
      heartbeatQuotesSeen = 0;
      heartbeatSignalsWritten = 0;
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to write observatory heartbeat');
    }
  }, 60000);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    clearInterval(heartbeatInterval);
    healthServer.close();

    await detector.stop();
    logger.info('Opportunity detector stopped');

    rankSpaceDetector.stop();
    logger.info('RankSpace detector stopped');

    // Stop PCA first (stops emitting new signals/exits), then executor
    if (paperMM) paperMM.stop();
    if (volumeTracker) volumeTracker.stop();
    if (marketContext) marketContext.stop();
    if (pcaMonitor) {
      pcaMonitor.stop();
      logger.info('PCA stat-arb monitor stopped');
    }

    const allPerpsExecutors = perpsExecutors;
    for (const ex of allPerpsExecutors) {
      await ex.stop();
      logger.info({ runId: ex.getRunId(), mode: ex.getMode() }, 'Perps executor stopped');
    }

    for (const calibrator of slippageCalibrators) {
      calibrator.stop();
    }
    if (slippageCalibrators.length > 0) {
      logger.info('Slippage calibrators stopped');
    }

    for (const [chain, manager] of executionManagers) {
      manager.stop();
      logger.info({ chain }, 'Execution manager stopped');
    }

    await orchestrator.stop();
    logger.info('Collector orchestrator stopped');

    await closePool();
    logger.info('Database pool closed');

    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      logger.error({ error: (err as Error).message }, 'Error during SIGINT shutdown');
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      logger.error({ error: (err as Error).message }, 'Error during SIGTERM shutdown');
      process.exit(1);
    });
  });

  logger.info('Dislocation trader ready - all systems online');
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
