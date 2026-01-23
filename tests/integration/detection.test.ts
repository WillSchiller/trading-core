import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { QuoteCache } from '../../src/state/quote-cache.js';
import { OpportunityDetector } from '../../src/detection/index.js';
import type { AppConfig, PairConfig } from '../../src/config/types.js';
import type { NormalizedQuote } from '../../src/types/index.js';
import { createPool } from '../../src/persistence/client.js';
import { getOpportunityById } from '../../src/persistence/opportunities.js';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Opportunity Detection Integration', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let quoteCache: QuoteCache;
  let detector: OpportunityDetector;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();

    const connectionUri = container.getConnectionUri();
    pool = new Pool({ connectionString: connectionUri });

    createPool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
      max: 10,
    });

    const schemaSql = readFileSync(join(__dirname, '../../sql/001_initial_schema.sql'), 'utf-8');
    await pool.query(schemaSql);

    const seedSql = readFileSync(join(__dirname, '../../sql/002_seed_venues.sql'), 'utf-8');
    await pool.query(seedSql);
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(() => {
    quoteCache = new QuoteCache({
      cexStaleThresholdMs: 3000,
      dexBlockLagThreshold: 2,
    });
  });

  it('detects opportunity when synthetic quotes meet all filter criteria', async () => {
    const venueIdMap = new Map([
      ['binance', 1],
      ['coinbase', 2],
      ['uniswap_v3', 3],
    ]);

    const pairIdMap = new Map([['WETH/USDC', 1]]);

    const appConfig: AppConfig = {
      system: {
        tickIntervalMs: 100,
        quoteStaleThresholdMs: 3000,
        rollupIntervals: ['1s', '10s', '1m'],
        persistRawQuotes: false,
        rawQuoteSampleRate: 10,
      },
      detection: {
        defaultMinSpreadBps: 15,
        defaultMinDurationMs: 1000,
        defaultMinLiquidityUsd: 50000,
        volatilityAdjustment: false,
        requireConfirmationVenue: false,
      },
      execution: {
        paperMode: true,
        maxSlippageBps: 50,
        deadlineSeconds: 120,
        gasBufferPercent: 20,
        simulateBeforeSend: true,
      },
      risk: {
        maxTradeSizeUsd: 1000,
        maxOpenExposureUsd: 5000,
        maxTradesPerHour: 20,
        cooldownSeconds: 30,
        maxGasGwei: 100,
        haltOnConsecutiveReverts: 3,
      },
      venues: {
        cex: {
          binance: { enabled: true, isAnchor: true, wsUrl: 'wss://stream.binance.com:9443/ws' },
          coinbase: { enabled: true, isAnchor: false, wsUrl: 'wss://ws-feed.exchange.coinbase.com' },
        },
        dex: {
          uniswap_v3: { enabled: true, chains: ['base'] },
        },
      },
      chains: {
        base: {
          enabled: true,
          chainId: 8453,
          blockTimeMs: 2000,
          contracts: {
            uniswapV3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
            uniswapV3Quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
            uniswapV3QuoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
            uniswapV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481',
            uniswapUniversalRouter: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
          },
        },
      },
    };

    const pairsConfig: PairConfig[] = [
      {
        base: 'WETH',
        quote: 'USDC',
        chain: 'base',
        tier: 1,
        enabled: true,
        venues: {
          uniswap_v3: {
            base: [
              {
                pool: '0xd0b53D9277642d899DF5C87A3966A349A798F224',
                feeTier: 500,
                primary: true,
              },
            ],
          },
        },
        thresholds: {
          minSpreadBps: 15,
          minDurationMs: 1000,
          minLiquidityUsd: 50000,
          maxTradeSizeUsd: 5000,
        },
      },
    ];

    detector = new OpportunityDetector({
      quoteCache,
      appConfig,
      pairsConfig,
      venueIdMap,
      pairIdMap,
    });

    quoteCache.updateCurrentBlock('base', BigInt(12345));

    const anchorQuote: NormalizedQuote = {
      ts: new Date(),
      venue: 'binance',
      pair: 'WETH/USDC',
      mid: 2000,
      bid: 1999,
      ask: 2001,
      latencyMs: 10,
    };

    const dexQuote: NormalizedQuote = {
      ts: new Date(),
      venue: 'uniswap_v3',
      pair: 'WETH/USDC',
      chain: 'base',
      mid: 1960,
      blockNumber: BigInt(12345),
      liquidity: BigInt(100),
      latencyMs: 20,
    };

    quoteCache.updateQuote(anchorQuote);
    quoteCache.updateQuote(dexQuote);

    let opportunityDetected = false;
    let detectedOpportunityId: bigint | undefined;

    detector.getEmitter().onOpportunityDetected((event) => {
      opportunityDetected = true;
      detectedOpportunityId = event.opportunity.id;
    });

    detector.start();

    await new Promise((resolve) => setTimeout(resolve, 1500));

    detector.stop();

    expect(opportunityDetected).toBe(true);
    expect(detectedOpportunityId).toBeDefined();

    if (detectedOpportunityId) {
      const savedOpportunity = await getOpportunityById(detectedOpportunityId);

      expect(savedOpportunity).toBeDefined();
      expect(savedOpportunity?.pairId).toBe(1);
      expect(savedOpportunity?.chain).toBe('base');
      expect(savedOpportunity?.anchorMid).toBe(2000);
      expect(savedOpportunity?.dexMid).toBe(1960);
      expect(savedOpportunity?.spreadBps).toBeCloseTo(-200, 1);
      expect(savedOpportunity?.direction).toBe('buy_dex');
      expect(savedOpportunity?.status).toBe('detected');
      expect(savedOpportunity?.reasonCodes).toContain('spread_above_threshold');
      expect(savedOpportunity?.reasonCodes).toContain('duration_met');
      expect(savedOpportunity?.reasonCodes).toContain('depth_sufficient');
    }
  });

  it('does not detect opportunity when spread is below threshold', async () => {
    const venueIdMap = new Map([
      ['binance', 1],
      ['uniswap_v3', 3],
    ]);

    const pairIdMap = new Map([['WETH/USDC', 1]]);

    const appConfig: AppConfig = {
      system: {
        tickIntervalMs: 100,
        quoteStaleThresholdMs: 3000,
        rollupIntervals: ['1s', '10s', '1m'],
        persistRawQuotes: false,
        rawQuoteSampleRate: 10,
      },
      detection: {
        defaultMinSpreadBps: 50,
        defaultMinDurationMs: 1000,
        defaultMinLiquidityUsd: 50000,
        volatilityAdjustment: false,
        requireConfirmationVenue: false,
      },
      execution: {
        paperMode: true,
        maxSlippageBps: 50,
        deadlineSeconds: 120,
        gasBufferPercent: 20,
        simulateBeforeSend: true,
      },
      risk: {
        maxTradeSizeUsd: 1000,
        maxOpenExposureUsd: 5000,
        maxTradesPerHour: 20,
        cooldownSeconds: 30,
        maxGasGwei: 100,
        haltOnConsecutiveReverts: 3,
      },
      venues: {
        cex: {
          binance: { enabled: true, isAnchor: true, wsUrl: 'wss://stream.binance.com:9443/ws' },
        },
        dex: {
          uniswap_v3: { enabled: true, chains: ['base'] },
        },
      },
      chains: {
        base: {
          enabled: true,
          chainId: 8453,
          blockTimeMs: 2000,
          contracts: {
            uniswapV3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
            uniswapV3Quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
            uniswapV3QuoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
            uniswapV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481',
            uniswapUniversalRouter: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
          },
        },
      },
    };

    const pairsConfig: PairConfig[] = [
      {
        base: 'WETH',
        quote: 'USDC',
        chain: 'base',
        tier: 1,
        enabled: true,
        venues: {
          uniswap_v3: {
            base: [
              {
                pool: '0xd0b53D9277642d899DF5C87A3966A349A798F224',
                feeTier: 500,
                primary: true,
              },
            ],
          },
        },
        thresholds: {
          minSpreadBps: 50,
          minDurationMs: 1000,
          minLiquidityUsd: 50000,
          maxTradeSizeUsd: 5000,
        },
      },
    ];

    detector = new OpportunityDetector({
      quoteCache,
      appConfig,
      pairsConfig,
      venueIdMap,
      pairIdMap,
    });

    quoteCache.updateCurrentBlock('base', BigInt(12345));

    const anchorQuote: NormalizedQuote = {
      ts: new Date(),
      venue: 'binance',
      pair: 'WETH/USDC',
      mid: 2000,
      latencyMs: 10,
    };

    const dexQuote: NormalizedQuote = {
      ts: new Date(),
      venue: 'uniswap_v3',
      pair: 'WETH/USDC',
      chain: 'base',
      mid: 1995,
      blockNumber: BigInt(12345),
      liquidity: BigInt(100),
      latencyMs: 20,
    };

    quoteCache.updateQuote(anchorQuote);
    quoteCache.updateQuote(dexQuote);

    let opportunityDetected = false;

    detector.getEmitter().onOpportunityDetected(() => {
      opportunityDetected = true;
    });

    detector.start();

    await new Promise((resolve) => setTimeout(resolve, 1500));

    detector.stop();

    expect(opportunityDetected).toBe(false);
  });
});
