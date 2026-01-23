import type { Chain, RollupInterval } from '../types/index.js';

export interface SystemConfig {
  tickIntervalMs: number;
  quoteStaleThresholdMs: number;
  rollupIntervals: RollupInterval[];
  persistRawQuotes: boolean;
  rawQuoteSampleRate: number;
  maxFutureTsMs?: number;
  maxPastTsMs?: number;
  dexBlockLagThreshold?: number;
}

export interface DetectionConfig {
  defaultMinSpreadBps: number;
  defaultMinDurationMs: number;
  defaultMinLiquidityUsd: number;
  volatilityAdjustment: boolean;
  requireConfirmationVenue: boolean;
  maxTimeSkewMsBase?: number;
  maxTimeSkewMsMainnet?: number;
}

export interface ExecutionConfig {
  paperMode: boolean;
  maxSlippageBps: number;
  deadlineSeconds: number;
  gasBufferPercent: number;
  simulateBeforeSend: boolean;
}

export interface RiskConfig {
  maxTradeSizeUsd: number;
  maxOpenExposureUsd: number;
  maxTradesPerHour: number;
  cooldownSeconds: number;
  maxGasGwei: number;
  haltOnConsecutiveReverts: number;
  skipProfitCheckForTesting?: boolean;
}

export interface ChainContracts {
  uniswapV3Factory: string;
  uniswapV3Quoter: string;
  uniswapV3QuoterV2: string;
  uniswapV3Router: string;
  uniswapUniversalRouter: string;
  aerodromeRouter?: string;
}

export interface ChainConfig {
  enabled: boolean;
  chainId: number;
  blockTimeMs: number;
  contracts: ChainContracts;
}

export interface CexVenueConfig {
  enabled: boolean;
  isAnchor: boolean;
  wsUrl: string;
}

export interface DexVenueConfig {
  enabled: boolean;
  chains: Chain[];
}

export interface VenuesConfig {
  cex: Record<string, CexVenueConfig>;
  dex: Record<string, DexVenueConfig>;
}

export interface PoolConfig {
  pool: string;
  feeTier?: number;
  primary?: boolean;
  stable?: boolean;
}

export interface PairThresholds {
  minSpreadBps: number;
  minDurationMs: number;
  minLiquidityUsd: number;
  maxTradeSizeUsd: number;
  thinMarketMode?: boolean;
  maxQuoteAgeMs?: number;
  thinMarketBufferBps?: number;
}

export interface PairConfig {
  base: string;
  quote: string;
  chain: Chain;
  tier: number;
  aliases?: string[];
  enabled?: boolean;
  venues: Record<string, unknown>;
  thresholds: PairThresholds;
}

export interface AppConfig {
  system: SystemConfig;
  detection: DetectionConfig;
  execution: ExecutionConfig;
  risk: RiskConfig;
  venues: VenuesConfig;
  chains: Record<string, ChainConfig>;
}

export interface EnvConfig {
  nodeEnv: string;
  logLevel: string;
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  rpc: {
    mainnetHttp?: string;
    mainnetWs?: string;
    baseHttp?: string;
    baseWs?: string;
  };
  cex: {
    binanceApiKey?: string;
    binanceApiSecret?: string;
    coinbaseApiKey?: string;
    coinbaseApiSecret?: string;
    coinbasePassphrase?: string;
    bybitApiKey?: string;
    bybitApiSecret?: string;
  };
  executorPrivateKey?: string;
  paperMode: boolean;
  enableExecution: boolean;
  enableMainnet: boolean;
  enableBase: boolean;
  telegram?: {
    botToken: string;
    chatId: string;
  };
}
