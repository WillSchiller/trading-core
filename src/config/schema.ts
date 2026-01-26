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
});

export const executionConfigSchema = z.object({
  paperMode: z.boolean(),
  maxSlippageBps: z.number().positive(),
  deadlineSeconds: z.number().int().positive(),
  gasBufferPercent: z.number().int().min(0),
  simulateBeforeSend: z.boolean(),
});

export const riskConfigSchema = z.object({
  maxTradeSizeUsd: z.number().positive(),
  maxOpenExposureUsd: z.number().positive(),
  maxTradesPerHour: z.number().int().positive(),
  cooldownSeconds: z.number().int().min(0),
  maxGasGwei: z.number().positive(),
  haltOnConsecutiveReverts: z.number().int().positive(),
  skipProfitCheckForTesting: z.boolean().optional(),
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

export const venuesConfigSchema = z.object({
  cex: z.record(cexVenueConfigSchema),
  dex: z.record(dexVenueConfigSchema),
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
  venues: z.record(z.unknown()),
  thresholds: pairThresholdsSchema,
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
