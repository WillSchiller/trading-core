import { z } from 'zod';
import type { PolymarketConfig } from './types.js';

const riskLimitsSchema = z.object({
  maxPositionUsd: z.number().positive(),
  maxTotalExposureUsd: z.number().positive(),
  dailyLossLimitUsd: z.number().positive(),
  maxMarketsOpen: z.number().int().positive(),
});

const polymarketConfigSchema = z.object({
  enabled: z.boolean(),
  paperMode: z.boolean(),
  pollIntervalMs: z.number().int().positive(),
  discoveryIntervalMs: z.number().int().positive(),
  positionUpdateIntervalMs: z.number().int().positive(),
  killSwitchCheckIntervalMs: z.number().int().positive(),
  bankrollUsd: z.number().positive(),
  maxTraders: z.number().int().positive(),
  riskLimits: riskLimitsSchema,
  privateKey: z.string().optional(),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  passphrase: z.string().optional(),
  discoveryCategories: z.array(z.string()),
  copyCategories: z.array(z.string()),
  clobApiUrl: z.string().url(),
  gammaApiUrl: z.string().url(),
  dataApiUrl: z.string().url(),
});

export function loadPolymarketConfig(): PolymarketConfig {
  const raw = {
    enabled: process.env.POLYMARKET_ENABLED === 'true',
    paperMode: process.env.POLYMARKET_PAPER_MODE !== 'false',
    pollIntervalMs: Number(process.env.POLYMARKET_POLL_INTERVAL_MS || '2000'),
    discoveryIntervalMs: Number(process.env.POLYMARKET_DISCOVERY_INTERVAL_MS || '3600000'),
    positionUpdateIntervalMs: Number(process.env.POLYMARKET_POSITION_UPDATE_MS || '30000'),
    killSwitchCheckIntervalMs: Number(process.env.POLYMARKET_KILLSWITCH_CHECK_MS || '60000'),
    bankrollUsd: Number(process.env.POLYMARKET_BANKROLL_USD || '500'),
    maxTraders: Number(process.env.POLYMARKET_MAX_TRADERS || '10'),
    riskLimits: {
      maxPositionUsd: Number(process.env.POLYMARKET_MAX_POSITION_USD || '100'),
      maxTotalExposureUsd: Number(process.env.POLYMARKET_MAX_EXPOSURE_USD || '500'),
      dailyLossLimitUsd: Number(process.env.POLYMARKET_DAILY_LOSS_LIMIT_USD || '50'),
      maxMarketsOpen: Number(process.env.POLYMARKET_MAX_MARKETS_OPEN || '10'),
    },
    discoveryCategories: (process.env.PM_DISCOVERY_CATEGORIES || 'SPORTS,CRYPTO,POLITICS').split(',').map(s => s.trim()),
    copyCategories: (process.env.PM_COPY_CATEGORIES || 'SPORTS').split(',').map(s => s.trim()),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY || undefined,
    apiKey: process.env.POLYMARKET_API_KEY || undefined,
    apiSecret: process.env.POLYMARKET_API_SECRET || undefined,
    passphrase: process.env.POLYMARKET_PASSPHRASE || undefined,
    clobApiUrl: process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com',
    gammaApiUrl: process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com',
    dataApiUrl: process.env.POLYMARKET_DATA_URL || 'https://data-api.polymarket.com',
  };

  return polymarketConfigSchema.parse(raw);
}
