import { z } from 'zod';

const rollupIntervalSchema = z.enum(['1s', '10s', '1m']);
const chainSchema = z.enum(['mainnet', 'base', 'arbitrum']);

export const systemConfigSchema = z.object({
  tickIntervalMs: z.number().int().positive(),
  quoteStaleThresholdMs: z.number().int().positive(),
  rollupIntervals: z.array(rollupIntervalSchema),
  persistRawQuotes: z.boolean(),
  rawQuoteSampleRate: z.number().int().positive(),
});

export const detectionConfigSchema = z.object({
  defaultMinSpreadBps: z.number().positive(),
  defaultMinDurationMs: z.number().int().positive(),
  defaultMinLiquidityUsd: z.number().positive(),
  volatilityAdjustment: z.boolean(),
  requireConfirmationVenue: z.boolean(),
});

export const rankSpaceConfigSchema = z.object({
  minVenues: z.number().int().min(3),
  triggerPercentile: z.number().min(0).max(1),
  minSpreadBps: z.number().positive(),
  minDurationMs: z.number().int().positive(),
  validationMode: z.enum(['none', 'direction_only', 'full']).default('direction_only'),
  directionToleranceBps: z.number().nonnegative().default(3),
});

export const executionConfigSchema = z.object({
  paperMode: z.boolean(),
  maxSlippageBps: z.number().positive(),
  edgeBufferBps: z.number().positive(),
  deadlineSeconds: z.number().int().positive(),
  gasBufferPercent: z.number().int().min(0),
  simulateBeforeSend: z.boolean(),
  minProfitUsd: z.number().positive().optional(),
});

export const chainRiskOverridesSchema = z.object({
  maxTradeSizeUsd: z.number().positive().optional(),
  maxOpenExposureUsd: z.number().positive().optional(),
  maxTradesPerHour: z.number().int().positive().optional(),
});

export const riskConfigSchema = z.object({
  maxTradeSizeUsd: z.number().positive(),
  maxOpenExposureUsd: z.number().positive(),
  maxTradesPerHour: z.number().int().positive(),
  cooldownSeconds: z.number().int().min(0),
  maxGasGwei: z.number().positive(),
  haltOnConsecutiveReverts: z.number().int().positive(),
  minProfitUsd: z.number().min(0).optional(),
  skipProfitCheckForTesting: z.boolean().optional(),
  chainOverrides: z.object({
    mainnet: chainRiskOverridesSchema.optional(),
    base: chainRiskOverridesSchema.optional(),
    arbitrum: chainRiskOverridesSchema.optional(),
  }).optional(),
});

export const inventoryConfigSchema = z.object({
  trackingEnabled: z.boolean().default(true),
  initialBalances: z.record(z.number().nonnegative()).default({}),
});

export const chainContractsSchema = z.object({
  uniswapV3Factory: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  uniswapV3Quoter: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  uniswapV3QuoterV2: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  uniswapV3Router: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  uniswapUniversalRouter: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  aerodromeRouter: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
});

export const chainConfigSchema = z.object({
  enabled: z.boolean(),
  chainId: z.number().int().positive(),
  blockTimeMs: z.number().int().positive(),
  contracts: chainContractsSchema,
});

export const cexVenueConfigSchema = z.object({
  enabled: z.boolean(),
  isAnchor: z.boolean(),
  wsUrl: z.string().url(),
});

export const dexVenueConfigSchema = z.object({
  enabled: z.boolean(),
  chains: z.array(chainSchema),
});

export const lstOracleConfigSchema = z.object({
  enabled: z.boolean(),
  pollIntervalMs: z.number().int().positive(),
});

export const protocolVenueConfigSchema = z.object({
  lstOracle: lstOracleConfigSchema.optional(),
});

export const venuesConfigSchema = z.object({
  cex: z.record(cexVenueConfigSchema),
  dex: z.record(dexVenueConfigSchema),
  protocol: protocolVenueConfigSchema.optional(),
});

export const poolConfigSchema = z.object({
  pool: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  feeTier: z.number().int().optional(),
  primary: z.boolean().optional(),
  stable: z.boolean().optional(),
});

export const pairThresholdsSchema = z.object({
  minSpreadBps: z.number().positive(),
  minDurationMs: z.number().int().positive(),
  minLiquidityUsd: z.number().positive(),
  maxTradeSizeUsd: z.number().positive(),
  thinMarketMode: z.boolean().optional(),
  maxQuoteAgeMs: z.number().int().positive().optional(),
  thinMarketBufferBps: z.number().positive().optional(),
});

export const pairConfigSchema = z.object({
  base: z.string().min(1),
  quote: z.string().min(1),
  chain: chainSchema,
  tier: z.number().int().min(1).max(3),
  aliases: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  researchOnly: z.boolean().optional(),
  venues: z.record(z.unknown()),
  thresholds: pairThresholdsSchema,
});

const trailingExitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  activationPnlBps: z.number().default(25),
  trailStopBps: z.number().default(20),
}).default({
  enabled: true,
  activationPnlBps: 25,
  trailStopBps: 20,
});

const regimeGatingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ewmaSpan: z.number().int().positive().default(10),
  regimeThreshold: z.number().default(0.5),
  hysteresisTicks: z.number().int().positive().default(3),
  minVolatilityBps: z.number().positive().optional(),
  maxPC1DisplacementBps: z.number().positive().optional(),
  pc1DisplacementLookback: z.number().int().positive().optional(),
}).default({
  enabled: true,
  ewmaSpan: 10,
  regimeThreshold: 0.5,
  hysteresisTicks: 3,
});

const exposureLimitsConfigSchema = z.object({
  maxPositionsLong: z.number().int().nonnegative().default(3),
  maxPositionsShort: z.number().int().nonnegative().default(5),
  maxPositionsTotal: z.number().int().nonnegative().default(6),
}).default({
  maxPositionsLong: 3,
  maxPositionsShort: 5,
  maxPositionsTotal: 6,
});

const sizingConfigSchema = z.object({
  mode: z.enum(['flat', 'vol_adjusted', 'factor_neutral']).default('factor_neutral'),
  baseNotionalUsd: z.number().positive().default(100),
  minPositionUsd: z.number().positive().default(25),
  maxPositionUsd: z.number().positive().default(200),
  targetVolBps: z.number().positive().optional(),
  loadingSmoothingSpan: z.number().int().positive().optional(),
  maxPortfolioPC1ExposureUsd: z.number().positive().optional(),
}).default({
  mode: 'factor_neutral',
  baseNotionalUsd: 100,
  minPositionUsd: 25,
  maxPositionUsd: 200,
  targetVolBps: 100,
  loadingSmoothingSpan: 20,
  maxPortfolioPC1ExposureUsd: 150,
});

const longConfigSchema = z.object({
  enabled: z.boolean().default(true),
  entryZScore: z.number().positive().default(3.0),
  exitZScore: z.number().nonnegative().default(0.0),
  maxHoldTimeMs: z.number().int().positive().default(21600000),
  minHoldTimeMs: z.number().int().nonnegative().default(2700000),
  zeroCrossExit: z.boolean().default(true),
  stopLossBps: z.number().positive().default(150),
  requireRegimeConfirmation: z.boolean().default(true),
}).default({
  enabled: true,
  entryZScore: 3.0,
  exitZScore: 0.0,
  maxHoldTimeMs: 21600000,
  minHoldTimeMs: 2700000,
  zeroCrossExit: true,
  stopLossBps: 150,
  requireRegimeConfirmation: true,
});

const shortConfigSchema = z.object({
  entryZScore: z.number().positive().default(2.5),
  maxEntryZScore: z.number().positive().optional(),
  exitZScore: z.number().nonnegative().default(0.0),
  maxHoldTimeMs: z.number().int().positive().default(43200000),
  minHoldTimeMs: z.number().int().nonnegative().default(1800000),
  zeroCrossExit: z.boolean().default(false),
  zscoreExit: z.boolean().default(true),
  stopLossBps: z.number().positive().default(150),
  stopLossIgnoresMinHold: z.boolean().default(false),
  trailingExit: trailingExitConfigSchema,
  stallExitMs: z.number().int().positive().optional(),
  stallExitMinPeakBps: z.number().nonnegative().optional(),
}).default({
  entryZScore: 2.5,
  exitZScore: 0.0,
  maxHoldTimeMs: 43200000,
  minHoldTimeMs: 1800000,
  zeroCrossExit: false,
  zscoreExit: true,
  stopLossBps: 150,
  stopLossIgnoresMinHold: false,
  trailingExit: {
    enabled: true,
    activationPnlBps: 25,
    trailStopBps: 20,
  },
});

const orphanCleanupConfigSchema = z.object({
  maxStaleMs: z.number().int().positive().default(7200000),
}).optional();

export const pcaStatArbConfigSchema = z.object({
  enabled: z.boolean().default(true),
  assets: z.array(z.string()).default(['ETH', 'BTC', 'SOL', 'AVAX', 'MATIC', 'ARB']),
  returnWindowMs: z.number().int().positive().default(60000),
  pcaLookbackPeriods: z.number().int().positive().default(60),
  numFactors: z.number().int().min(1).max(10).default(2),
  minVarianceExplained: z.number().min(0).max(1).default(0.7),
  residualLookbackPeriods: z.number().int().positive().default(30),
  entryZScore: z.number().positive().default(2.0),
  exitZScore: z.number().positive().default(0.5),
  tickIntervalMs: z.number().int().positive().default(60000),
  pcaRefreshPeriods: z.number().int().positive().default(15),
  positionSizeUsd: z.number().positive().default(100),
  regimeGating: regimeGatingConfigSchema,
  exposureLimits: exposureLimitsConfigSchema,
  sizing: sizingConfigSchema,
  long: longConfigSchema,
  short: shortConfigSchema,
  orphanCleanup: orphanCleanupConfigSchema,
});

export const killSwitchConfigSchema = z.object({
  dailyDrawdownLimitUsd: z.number().positive().default(100),
  maxTotalLossUsd: z.number().positive().default(500),
  maxConsecutiveLosses: z.number().int().positive().default(5),
  checkIntervalMs: z.number().int().positive().default(60000),
}).default({
  dailyDrawdownLimitUsd: 100,
  maxTotalLossUsd: 500,
  maxConsecutiveLosses: 5,
  checkIntervalMs: 60000,
});

export const paperFillConfigSchema = z.object({
  spreadBps: z.number().nonnegative().default(2),
  slippageBps: z.number().nonnegative().default(5),
  takerFeeBps: z.number().nonnegative().default(2),
  maxSlippageBps: z.number().nonnegative().default(20),
}).default({});

export const perpsRunConfigSchema = z.object({
  runId: z.string().min(1),
  paperMode: z.boolean(),
  exchange: z.enum(['binance', 'hyperliquid']).default('binance'),
  priceSource: z.enum(['binance', 'hyperliquid']).optional(),
  leverage: z.number().int().min(1).max(20).optional(),
  marginType: z.enum(['ISOLATED', 'CROSSED']).optional(),
  enableLongs: z.boolean().optional(),
  enableShorts: z.boolean().optional(),
  maxConcurrentPositions: z.number().int().positive().optional(),
  maxPositionSizeUsd: z.number().positive().optional(),
  minPositionSizeUsd: z.number().positive().optional(),
  maxTotalExposureUsd: z.number().positive().optional(),
  cooldownMs: z.number().int().nonnegative().optional(),
  maxHoldTimeMsShort: z.number().int().positive().optional(),
  maxHoldTimeMsLong: z.number().int().positive().optional(),
  excludeAssets: z.array(z.string()).optional(),
  maxPC1DisplacementBps: z.number().optional(),
  killSwitch: killSwitchConfigSchema.optional(),
  paperFill: paperFillConfigSchema.optional(),
});

export const perpsExecutionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  leverage: z.number().int().min(1).max(20).default(1),
  marginType: z.enum(['ISOLATED', 'CROSSED']).default('ISOLATED'),
  enableLongs: z.boolean().default(false),
  enableShorts: z.boolean().default(true),
  maxConcurrentPositions: z.number().int().positive().default(5),
  maxPositionSizeUsd: z.number().positive().default(150),
  minPositionSizeUsd: z.number().positive().default(10),
  maxTotalExposureUsd: z.number().positive().default(750),
  cooldownMs: z.number().int().nonnegative().default(30000),
  heartbeatIntervalMs: z.number().int().positive().default(5000),
  positionSyncIntervalMs: z.number().int().positive().default(60000),
  maxHoldTimeMsShort: z.number().int().positive().default(14400000),
  maxHoldTimeMsLong: z.number().int().positive().default(21600000),
  heartbeatStopLossBps: z.number().positive().default(150),
  trailingStop: z.object({
    activationPnlBps: z.number().nonnegative().default(30),
    trailStopBps: z.number().positive().default(25),
  }).default({ activationPnlBps: 30, trailStopBps: 25 }),
  stallExitMs: z.number().int().positive().optional(),
  stallExitMinPeakBps: z.number().nonnegative().optional(),
  killSwitch: killSwitchConfigSchema,
  paperFill: paperFillConfigSchema,
  runs: z.array(perpsRunConfigSchema).default([]),
}).optional();

export const researchConfigSchema = z.object({
  pcaStatArb: pcaStatArbConfigSchema.optional(),
});

export const appConfigSchema = z.object({
  system: systemConfigSchema,
  detection: detectionConfigSchema,
  rankSpace: rankSpaceConfigSchema,
  execution: executionConfigSchema,
  risk: riskConfigSchema,
  inventory: inventoryConfigSchema.default({ trackingEnabled: true, initialBalances: {} }),
  venues: venuesConfigSchema,
  chains: z.record(chainConfigSchema),
  research: researchConfigSchema.optional(),
  perpsExecution: perpsExecutionConfigSchema,
});

export const pairsFileSchema = z.object({
  pairs: z.array(pairConfigSchema),
});

const optionalUrl = z
  .string()
  .optional()
  .transform((val) => (val === '' || val === undefined ? undefined : val))
  .pipe(z.string().url().optional());

const rpcProviderSchema = z.object({
  http: optionalUrl,
  ws: optionalUrl,
});

export const envConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  postgres: z.object({
    host: z.string().default('localhost'),
    port: z.coerce.number().int().default(5432),
    database: z.string().default('dislocation_trader'),
    user: z.string().default('trader'),
    password: z.string().default('devpassword'),
  }),
  rpc: z.object({
    mainnet: z.object({
      drpc: rpcProviderSchema,
      alchemy: rpcProviderSchema,
    }),
    base: z.object({
      drpc: rpcProviderSchema,
      alchemy: rpcProviderSchema,
    }),
  }),
  cex: z.object({
    binanceApiKey: z.string().optional(),
    binanceApiSecret: z.string().optional(),
    coinbaseApiKey: z.string().optional(),
    coinbaseApiSecret: z.string().optional(),
    coinbasePassphrase: z.string().optional(),
    bybitApiKey: z.string().optional(),
    bybitApiSecret: z.string().optional(),
  }),
  binanceFutures: z.object({
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),
  }).default({}),
  hyperliquid: z.object({
    privateKey: z.string().optional(),
  }).default({}),
  executorPrivateKey: z.string().optional(),
  paperMode: z.coerce.boolean().default(true),
  enableExecution: z.coerce.boolean().default(false),
  enableMainnet: z.coerce.boolean().default(false),
  enableBase: z.coerce.boolean().default(true),
  telegram: z
    .object({
      botToken: z.string(),
      chatId: z.string(),
    })
    .optional(),
});
