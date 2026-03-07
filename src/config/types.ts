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
  gasBpsPerGwei?: number;
  defaultGasGwei?: number;
}

export type ValidationMode = 'none' | 'direction_only' | 'full';

export interface RankSpaceConfig {
  minVenues: number;
  triggerPercentile: number;
  minSpreadBps: number;
  minDurationMs: number;
  validationMode: ValidationMode;
  directionToleranceBps: number;
}

export interface ExecutionConfig {
  paperMode: boolean;
  maxSlippageBps: number;
  edgeBufferBps: number;
  deadlineSeconds: number;
  gasBufferPercent: number;
  simulateBeforeSend: boolean;
  minProfitUsd?: number;
}

export interface ChainRiskOverrides {
  maxTradeSizeUsd?: number;
  maxOpenExposureUsd?: number;
  maxTradesPerHour?: number;
}

export interface RiskConfig {
  maxTradeSizeUsd: number;
  maxOpenExposureUsd: number;
  maxTradesPerHour: number;
  cooldownSeconds: number;
  maxGasGwei: number;
  haltOnConsecutiveReverts: number;
  minProfitUsd?: number;
  skipProfitCheckForTesting?: boolean;
  chainOverrides?: {
    mainnet?: ChainRiskOverrides;
    base?: ChainRiskOverrides;
    arbitrum?: ChainRiskOverrides;
  };
}

export interface InventoryConfig {
  trackingEnabled: boolean;
  initialBalances: Record<string, number>;
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

export interface ProtocolVenueConfig {
  lstOracle?: {
    enabled: boolean;
    pollIntervalMs: number;
  };
}

export interface VenuesConfig {
  cex: Record<string, CexVenueConfig>;
  dex: Record<string, DexVenueConfig>;
  protocol?: ProtocolVenueConfig;
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
  researchOnly?: boolean;
  venues: Record<string, unknown>;
  thresholds: PairThresholds;
}

export interface PCATrailingExitConfig {
  enabled: boolean;
  activationPnlBps: number;
  trailStopBps: number;
}

export interface PCARegimeGatingConfig {
  enabled: boolean;
  ewmaSpan: number;
  regimeThreshold: number;
  hysteresisTicks: number;
  minVolatilityBps?: number;
  maxPC1DisplacementBps?: number;
  pc1DisplacementLookback?: number;
  trendGateThresholdBps?: number;
}

export interface PCAExposureLimitsConfig {
  maxPositionsLong: number;
  maxPositionsShort: number;
  maxPositionsTotal: number;
}

export interface PCASizingConfig {
  mode: 'flat' | 'vol_adjusted' | 'factor_neutral';
  baseNotionalUsd: number;
  minPositionUsd: number;
  maxPositionUsd: number;
  targetVolBps?: number;
  loadingSmoothingSpan?: number;
  maxPortfolioPC1ExposureUsd?: number;
}

export interface PCALongConfig {
  enabled: boolean;
  entryZScore: number;
  exitZScore: number;
  maxHoldTimeMs: number;
  minHoldTimeMs: number;
  zeroCrossExit: boolean;
  stopLossBps: number;
  requireRegimeConfirmation: boolean;
}

export interface PCABounceFailConfig {
  enabled: boolean;
  holdMs: number;
  thresholdBps: number;
}

export interface PCAShortConfig {
  entryZScore: number;
  maxEntryZScore?: number;
  exitZScore: number;
  maxHoldTimeMs: number;
  minHoldTimeMs: number;
  zeroCrossExit: boolean;
  zscoreExit: boolean;
  stopLossBps: number;
  stopLossIgnoresMinHold: boolean;
  trailingExit: PCATrailingExitConfig;
  stallExitMs?: number;
  stallExitMinPeakBps?: number;
  bounceFail?: PCABounceFailConfig;
  minPC1ReturnBps?: number;
  maxFundingRate?: number;
  maxBookBidImbalance?: number;
}

export interface PCAHeatScalingConfig {
  enabled: boolean;
  decayPerPosition: number;
  dispersionThresholdBps: number;
  dispersionPenalty: number;
}

export interface PCAOrphanCleanupConfig {
  maxStaleMs: number;
}

export interface PCAStatArbConfig {
  enabled: boolean;
  assets: string[];
  returnWindowMs: number;
  pcaLookbackPeriods: number;
  numFactors: number;
  minVarianceExplained: number;
  residualLookbackPeriods: number;
  entryZScore: number;
  exitZScore: number;
  tickIntervalMs: number;
  pcaRefreshPeriods: number;
  positionSizeUsd: number;
  regimeGating: PCARegimeGatingConfig;
  exposureLimits: PCAExposureLimitsConfig;
  sizing: PCASizingConfig;
  long: PCALongConfig;
  short: PCAShortConfig;
  orphanCleanup?: PCAOrphanCleanupConfig;
  heatScaling?: PCAHeatScalingConfig;
}

export interface KillSwitchConfig {
  dailyDrawdownLimitUsd: number;
  maxTotalLossUsd: number;
  maxConsecutiveLosses: number;
  checkIntervalMs: number;
}

export interface PaperFillConfig {
  spreadBps: number;
  slippageBps: number;
  takerFeeBps: number;
  makerFeeBps?: number;
  maxSlippageBps: number;
}

export interface PerpsRunConfig {
  runId: string;
  paperMode: boolean;
  exchange?: 'binance' | 'hyperliquid';
  priceSource?: 'binance' | 'hyperliquid';
  leverage?: number;
  marginType?: 'ISOLATED' | 'CROSSED';
  enableLongs?: boolean;
  enableShorts?: boolean;
  maxConcurrentPositions?: number;
  maxPositionSizeUsd?: number;
  minPositionSizeUsd?: number;
  maxTotalExposureUsd?: number;
  cooldownMs?: number;
  maxHoldTimeMsShort?: number;
  maxHoldTimeMsLong?: number;
  excludeAssets?: string[];
  maxPC1DisplacementBps?: number;
  orderType?: 'maker' | 'taker';
  makerTimeoutMs?: number;
  exitMakerTimeoutMs?: number;
  exitFallbackToTaker?: boolean;
  killSwitch?: KillSwitchConfig;
  paperFill?: PaperFillConfig;
}

export interface PerpsExecutionConfig {
  enabled: boolean;
  leverage: number;
  marginType: 'ISOLATED' | 'CROSSED';
  enableLongs: boolean;
  enableShorts: boolean;
  maxConcurrentPositions: number;
  maxPositionSizeUsd: number;
  minPositionSizeUsd: number;
  maxTotalExposureUsd: number;
  cooldownMs: number;
  heartbeatIntervalMs: number;
  positionSyncIntervalMs: number;
  maxHoldTimeMsShort: number;
  maxHoldTimeMsLong: number;
  heartbeatStopLossBps: number;
  trailingStop: { activationPnlBps: number; trailStopBps: number };
  stallExitMs?: number;
  stallExitMinPeakBps?: number;
  orderType?: 'maker' | 'taker';
  makerTimeoutMs?: number;
  exitMakerTimeoutMs?: number;
  exitFallbackToTaker?: boolean;
  killSwitch: KillSwitchConfig;
  paperFill: PaperFillConfig;
  runs: PerpsRunConfig[];
}

export interface ResearchConfig {
  pcaStatArb?: PCAStatArbConfig;
}

export interface AppConfig {
  system: SystemConfig;
  detection: DetectionConfig;
  rankSpace: RankSpaceConfig;
  execution: ExecutionConfig;
  risk: RiskConfig;
  inventory: InventoryConfig;
  venues: VenuesConfig;
  chains: Record<string, ChainConfig>;
  research?: ResearchConfig;
  perpsExecution?: PerpsExecutionConfig;
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
    mainnet: {
      drpc: {
        http?: string;
        ws?: string;
      };
      alchemy: {
        http?: string;
        ws?: string;
      };
    };
    base: {
      drpc: {
        http?: string;
        ws?: string;
      };
      alchemy: {
        http?: string;
        ws?: string;
      };
    };
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
  binanceFutures: {
    apiKey?: string;
    apiSecret?: string;
  };
  hyperliquid: {
    privateKey?: string;
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
