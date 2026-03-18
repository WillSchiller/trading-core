import { z } from 'zod';
import type { PMMConfig } from './types.js';

const pmmConfigSchema = z.object({
  enabled: z.boolean(),
  paperMode: z.boolean(),
  maxMarkets: z.number().int().positive(),
  positionSizeUsd: z.number().positive(),
  maxInventoryUsd: z.number().positive(),
  maxTotalExposureUsd: z.number().positive(),
  minSpreadCents: z.number().positive(),
  gamma: z.number().positive(),
  requoteIntervalMs: z.number().int().positive(),
  minVolume24h: z.number().positive(),
  exitBeforeResolutionH: z.number().positive(),
  makerFeeBps: z.number().min(0),
  takerFeeBps: z.number().min(0),
  gammaApiUrl: z.string().url(),
  clobWsUrl: z.string(),
});

export function loadPMMConfig(): PMMConfig {
  const raw = {
    enabled: process.env.PMM_ENABLED === 'true',
    paperMode: process.env.PMM_PAPER_MODE !== 'false',
    maxMarkets: Number(process.env.PMM_MAX_MARKETS || '5'),
    positionSizeUsd: Number(process.env.PMM_POSITION_SIZE_USD || '50'),
    maxInventoryUsd: Number(process.env.PMM_MAX_INVENTORY_USD || '100'),
    maxTotalExposureUsd: Number(process.env.PMM_MAX_TOTAL_EXPOSURE_USD || '500'),
    minSpreadCents: Number(process.env.PMM_MIN_SPREAD_CENTS || '2'),
    gamma: Number(process.env.PMM_GAMMA || '0.3'),
    requoteIntervalMs: Number(process.env.PMM_REQUOTE_INTERVAL_MS || '10000'),
    minVolume24h: Number(process.env.PMM_MIN_VOLUME_24H || '10000'),
    exitBeforeResolutionH: Number(process.env.PMM_EXIT_BEFORE_RESOLUTION_H || '6'),
    makerFeeBps: Number(process.env.PMM_MAKER_FEE_BPS || '0'),
    takerFeeBps: Number(process.env.PMM_TAKER_FEE_BPS || '0'),
    gammaApiUrl: process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com',
    clobWsUrl: process.env.PMM_CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  };

  return pmmConfigSchema.parse(raw);
}
