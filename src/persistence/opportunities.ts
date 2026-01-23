import { getPool } from './client.js';
import type { Opportunity, Chain, TradeDirection, OpportunityStatus } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ component: 'opportunities-repo' });

export async function insertOpportunity(opportunity: Opportunity): Promise<bigint> {
  const pool = getPool();

  const query = `
    INSERT INTO opportunities (
      detected_at,
      pair_id,
      chain,
      anchor_venue_id,
      anchor_mid,
      confirm_venue_id,
      confirm_mid,
      dex_venue_id,
      dex_pool_address,
      dex_mid,
      dex_block_number,
      spread_bps,
      direction,
      estimated_slippage_bps,
      estimated_gas_usd,
      estimated_pool_fee_bps,
      estimated_profit_usd,
      status,
      skip_reason,
      volatility_regime,
      reason_codes,
      metadata,
      opened_at,
      closed_at,
      last_seen_at,
      close_reason,
      opp_key,
      max_spread_bps
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28
    )
    RETURNING id
  `;

  const params = [
    opportunity.detectedAt,
    opportunity.pairId,
    opportunity.chain,
    opportunity.anchorVenueId,
    opportunity.anchorMid,
    opportunity.confirmVenueId ?? null,
    opportunity.confirmMid ?? null,
    opportunity.dexVenueId,
    opportunity.dexPoolAddress,
    opportunity.dexMid,
    opportunity.dexBlockNumber ? opportunity.dexBlockNumber.toString() : null,
    opportunity.spreadBps,
    opportunity.direction,
    opportunity.estimatedSlippageBps ?? null,
    opportunity.estimatedGasUsd ?? null,
    opportunity.estimatedPoolFeeBps ?? null,
    opportunity.estimatedProfitUsd ?? null,
    opportunity.status,
    opportunity.skipReason ?? null,
    opportunity.volatilityRegime ?? null,
    opportunity.reasonCodes ?? null,
    opportunity.metadata ? JSON.stringify(opportunity.metadata) : null,
    opportunity.openedAt ?? null,
    opportunity.closedAt ?? null,
    opportunity.lastSeenAt ?? null,
    opportunity.closeReason ?? null,
    opportunity.oppKey ?? null,
    opportunity.maxSpreadBps ?? null,
  ];

  const result = await pool.query<{ id: string }>(query, params);

  const id = BigInt(result.rows[0].id);

  logger.debug(
    {
      opportunityId: id.toString(),
      pairId: opportunity.pairId,
      chain: opportunity.chain,
      spreadBps: opportunity.spreadBps,
      direction: opportunity.direction,
    },
    'Opportunity inserted'
  );

  return id;
}

export async function getOpportunityById(id: bigint): Promise<Opportunity | null> {
  const pool = getPool();

  const query = `
    SELECT
      id,
      detected_at,
      pair_id,
      chain,
      anchor_venue_id,
      anchor_mid,
      confirm_venue_id,
      confirm_mid,
      dex_venue_id,
      dex_pool_address,
      dex_mid,
      dex_block_number,
      spread_bps,
      direction,
      estimated_slippage_bps,
      estimated_gas_usd,
      estimated_pool_fee_bps,
      estimated_profit_usd,
      status,
      skip_reason,
      volatility_regime,
      reason_codes,
      metadata,
      opened_at,
      closed_at,
      last_seen_at,
      close_reason,
      opp_key,
      max_spread_bps
    FROM opportunities
    WHERE id = $1
  `;

  const result = await pool.query(query, [id.toString()]);

  if (result.rows.length === 0) {
    return null;
  }

  return mapRowToOpportunity(result.rows[0]);
}

export async function updateOpportunityStatus(
  id: bigint,
  status: OpportunityStatus,
  skipReason?: string,
  estimatedProfitUsd?: number
): Promise<void> {
  const pool = getPool();

  const query = `
    UPDATE opportunities
    SET status = $1, skip_reason = $2, estimated_profit_usd = COALESCE($4, estimated_profit_usd)
    WHERE id = $3
  `;

  await pool.query(query, [status, skipReason ?? null, id.toString(), estimatedProfitUsd ?? null]);

  logger.debug(
    {
      opportunityId: id.toString(),
      status,
      skipReason,
      estimatedProfitUsd,
    },
    'Opportunity status updated'
  );
}

export async function getRecentOpportunities(
  limit: number = 100
): Promise<Opportunity[]> {
  const pool = getPool();

  const query = `
    SELECT
      id,
      detected_at,
      pair_id,
      chain,
      anchor_venue_id,
      anchor_mid,
      confirm_venue_id,
      confirm_mid,
      dex_venue_id,
      dex_pool_address,
      dex_mid,
      dex_block_number,
      spread_bps,
      direction,
      estimated_slippage_bps,
      estimated_gas_usd,
      estimated_pool_fee_bps,
      estimated_profit_usd,
      status,
      skip_reason,
      volatility_regime,
      reason_codes,
      metadata,
      opened_at,
      closed_at,
      last_seen_at,
      close_reason,
      opp_key,
      max_spread_bps
    FROM opportunities
    ORDER BY detected_at DESC
    LIMIT $1
  `;

  const result = await pool.query(query, [limit]);

  return result.rows.map(mapRowToOpportunity);
}

export async function getOpportunitiesByPair(
  pairId: number,
  chain: Chain,
  limit: number = 100
): Promise<Opportunity[]> {
  const pool = getPool();

  const query = `
    SELECT
      id,
      detected_at,
      pair_id,
      chain,
      anchor_venue_id,
      anchor_mid,
      confirm_venue_id,
      confirm_mid,
      dex_venue_id,
      dex_pool_address,
      dex_mid,
      dex_block_number,
      spread_bps,
      direction,
      estimated_slippage_bps,
      estimated_gas_usd,
      estimated_pool_fee_bps,
      estimated_profit_usd,
      status,
      skip_reason,
      volatility_regime,
      reason_codes,
      metadata,
      opened_at,
      closed_at,
      last_seen_at,
      close_reason,
      opp_key,
      max_spread_bps
    FROM opportunities
    WHERE pair_id = $1 AND chain = $2
    ORDER BY detected_at DESC
    LIMIT $3
  `;

  const result = await pool.query(query, [pairId, chain, limit]);

  return result.rows.map(mapRowToOpportunity);
}

export async function updateOpportunityLastSeen(
  id: bigint,
  lastSeenAt: Date,
  maxSpreadBps: number
): Promise<void> {
  const pool = getPool();

  const query = `
    UPDATE opportunities
    SET last_seen_at = $1, max_spread_bps = GREATEST(COALESCE(max_spread_bps, 0), $2)
    WHERE id = $3
  `;

  await pool.query(query, [lastSeenAt, maxSpreadBps, id.toString()]);
}

export async function closeOpportunity(
  id: bigint,
  closedAt: Date,
  closeReason: string
): Promise<void> {
  const pool = getPool();

  const query = `
    UPDATE opportunities
    SET closed_at = $1, close_reason = $2, status = 'expired'
    WHERE id = $3
  `;

  await pool.query(query, [closedAt, closeReason, id.toString()]);

  logger.debug(
    {
      opportunityId: id.toString(),
      closedAt,
      closeReason,
    },
    'Opportunity closed'
  );
}

export async function getOpenOpportunityByKey(oppKey: string): Promise<Opportunity | null> {
  const pool = getPool();

  const query = `
    SELECT
      id,
      detected_at,
      pair_id,
      chain,
      anchor_venue_id,
      anchor_mid,
      confirm_venue_id,
      confirm_mid,
      dex_venue_id,
      dex_pool_address,
      dex_mid,
      dex_block_number,
      spread_bps,
      direction,
      estimated_slippage_bps,
      estimated_gas_usd,
      estimated_pool_fee_bps,
      estimated_profit_usd,
      status,
      skip_reason,
      volatility_regime,
      reason_codes,
      metadata,
      opened_at,
      closed_at,
      last_seen_at,
      close_reason,
      opp_key,
      max_spread_bps
    FROM opportunities
    WHERE opp_key = $1 AND status = 'detected' AND closed_at IS NULL
    ORDER BY opened_at DESC
    LIMIT 1
  `;

  const result = await pool.query(query, [oppKey]);

  if (result.rows.length === 0) {
    return null;
  }

  return mapRowToOpportunity(result.rows[0]);
}

function mapRowToOpportunity(row: any): Opportunity {
  return {
    id: BigInt(row.id),
    detectedAt: row.detected_at,
    pairId: row.pair_id,
    chain: row.chain as Chain,
    anchorVenueId: row.anchor_venue_id,
    anchorMid: parseFloat(row.anchor_mid),
    confirmVenueId: row.confirm_venue_id,
    confirmMid: row.confirm_mid ? parseFloat(row.confirm_mid) : undefined,
    dexVenueId: row.dex_venue_id,
    dexPoolAddress: row.dex_pool_address,
    dexMid: parseFloat(row.dex_mid),
    dexBlockNumber: row.dex_block_number ? BigInt(row.dex_block_number) : undefined,
    spreadBps: parseFloat(row.spread_bps),
    direction: row.direction as TradeDirection,
    estimatedSlippageBps: row.estimated_slippage_bps
      ? parseFloat(row.estimated_slippage_bps)
      : undefined,
    estimatedGasUsd: row.estimated_gas_usd ? parseFloat(row.estimated_gas_usd) : undefined,
    estimatedPoolFeeBps: row.estimated_pool_fee_bps
      ? parseFloat(row.estimated_pool_fee_bps)
      : undefined,
    estimatedProfitUsd: row.estimated_profit_usd
      ? parseFloat(row.estimated_profit_usd)
      : undefined,
    status: row.status as OpportunityStatus,
    skipReason: row.skip_reason,
    volatilityRegime: row.volatility_regime,
    reasonCodes: row.reason_codes,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    openedAt: row.opened_at || undefined,
    closedAt: row.closed_at || undefined,
    lastSeenAt: row.last_seen_at || undefined,
    closeReason: row.close_reason || undefined,
    oppKey: row.opp_key || undefined,
    maxSpreadBps: row.max_spread_bps ? parseFloat(row.max_spread_bps) : undefined,
  };
}
