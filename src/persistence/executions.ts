import { getPool } from './client.js';
import { createChildLogger } from '../utils/logger.js';
import type { Chain, TradeDirection, Strategy } from '../types/index.js';

const logger = createChildLogger({ component: 'executions-repo' });

export interface Execution {
  id?: bigint;
  opportunityId: bigint;
  createdAt: Date;
  pairId: number;
  chain: Chain;
  direction: TradeDirection;
  poolAddress: string;
  inputToken: string;
  inputAmount: bigint;
  inputAmountHuman: number;
  expectedOutput: bigint;
  expectedOutputHuman: number;
  quotedPrice: number;
  maxSlippageBps: number;
  amountOutMinimum: bigint;
  deadline: Date;
  gasPriceGwei: number;
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
  isPaperTrade: boolean;
  txHash?: string;
  submittedAt?: Date;
  submittedBlock?: bigint;
  status: string;
  confirmedAt?: Date;
  confirmedBlock?: bigint;
  gasUsed?: number;
  gasCostUsd?: number;
  actualOutput?: bigint;
  actualOutputHuman?: number;
  realizedPrice?: number;
  realizedSlippageBps?: number;
  realizedPnlUsd?: number;
  revertReason?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  strategy?: Strategy;
}

export async function insertExecution(execution: Execution): Promise<bigint> {
  const pool = getPool();

  const query = `
    INSERT INTO executions (
      opportunity_id,
      created_at,
      pair_id,
      chain,
      direction,
      pool_address,
      input_token,
      input_amount,
      input_amount_human,
      expected_output,
      expected_output_human,
      quoted_price,
      max_slippage_bps,
      amount_out_minimum,
      deadline,
      gas_price_gwei,
      max_fee_per_gas,
      max_priority_fee,
      gas_limit,
      is_paper_trade,
      tx_hash,
      submitted_at,
      submitted_block,
      status,
      confirmed_at,
      confirmed_block,
      gas_used,
      gas_cost_usd,
      actual_output,
      actual_output_human,
      realized_price,
      realized_slippage_bps,
      realized_pnl_usd,
      revert_reason,
      error_message,
      metadata,
      strategy
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37
    )
    RETURNING id
  `;

  const params = [
    execution.opportunityId.toString(),
    execution.createdAt,
    execution.pairId,
    execution.chain,
    execution.direction,
    execution.poolAddress,
    execution.inputToken,
    execution.inputAmount.toString(),
    execution.inputAmountHuman,
    execution.expectedOutput.toString(),
    execution.expectedOutputHuman,
    execution.quotedPrice,
    execution.maxSlippageBps,
    execution.amountOutMinimum.toString(),
    execution.deadline,
    execution.gasPriceGwei,
    execution.maxFeePerGas.toString(),
    execution.maxPriorityFee.toString(),
    execution.gasLimit,
    execution.isPaperTrade,
    execution.txHash ?? null,
    execution.submittedAt ?? null,
    execution.submittedBlock?.toString() ?? null,
    execution.status,
    execution.confirmedAt ?? null,
    execution.confirmedBlock?.toString() ?? null,
    execution.gasUsed ?? null,
    execution.gasCostUsd ?? null,
    execution.actualOutput?.toString() ?? null,
    execution.actualOutputHuman ?? null,
    execution.realizedPrice ?? null,
    execution.realizedSlippageBps ?? null,
    execution.realizedPnlUsd ?? null,
    execution.revertReason ?? null,
    execution.errorMessage ?? null,
    execution.metadata ? JSON.stringify(execution.metadata) : null,
    execution.strategy ?? 'dislocation',
  ];

  const result = await pool.query<{ id: string }>(query, params);
  const id = BigInt(result.rows[0].id);

  logger.debug(
    {
      executionId: id.toString(),
      opportunityId: execution.opportunityId.toString(),
      isPaperTrade: execution.isPaperTrade,
      status: execution.status,
    },
    'Execution inserted'
  );

  return id;
}

export async function updateExecutionStatus(
  id: bigint,
  update: {
    status: string;
    txHash?: string;
    submittedAt?: Date;
    submittedBlock?: bigint;
    confirmedAt?: Date;
    confirmedBlock?: bigint;
    gasUsed?: number;
    gasCostUsd?: number;
    actualOutput?: bigint;
    actualOutputHuman?: number;
    realizedPrice?: number;
    realizedSlippageBps?: number;
    realizedPnlUsd?: number;
    revertReason?: string;
    errorMessage?: string;
  }
): Promise<void> {
  const pool = getPool();

  const setClauses: string[] = ['status = $1'];
  const params: unknown[] = [update.status];
  let paramIndex = 2;

  if (update.txHash !== undefined) {
    setClauses.push(`tx_hash = $${paramIndex++}`);
    params.push(update.txHash);
  }
  if (update.submittedAt !== undefined) {
    setClauses.push(`submitted_at = $${paramIndex++}`);
    params.push(update.submittedAt);
  }
  if (update.submittedBlock !== undefined) {
    setClauses.push(`submitted_block = $${paramIndex++}`);
    params.push(update.submittedBlock.toString());
  }
  if (update.confirmedAt !== undefined) {
    setClauses.push(`confirmed_at = $${paramIndex++}`);
    params.push(update.confirmedAt);
  }
  if (update.confirmedBlock !== undefined) {
    setClauses.push(`confirmed_block = $${paramIndex++}`);
    params.push(update.confirmedBlock.toString());
  }
  if (update.gasUsed !== undefined) {
    setClauses.push(`gas_used = $${paramIndex++}`);
    params.push(update.gasUsed);
  }
  if (update.gasCostUsd !== undefined) {
    setClauses.push(`gas_cost_usd = $${paramIndex++}`);
    params.push(update.gasCostUsd);
  }
  if (update.actualOutput !== undefined) {
    setClauses.push(`actual_output = $${paramIndex++}`);
    params.push(update.actualOutput.toString());
  }
  if (update.actualOutputHuman !== undefined) {
    setClauses.push(`actual_output_human = $${paramIndex++}`);
    params.push(update.actualOutputHuman);
  }
  if (update.realizedPrice !== undefined) {
    setClauses.push(`realized_price = $${paramIndex++}`);
    params.push(update.realizedPrice);
  }
  if (update.realizedSlippageBps !== undefined) {
    setClauses.push(`realized_slippage_bps = $${paramIndex++}`);
    params.push(update.realizedSlippageBps);
  }
  if (update.realizedPnlUsd !== undefined) {
    setClauses.push(`realized_pnl_usd = $${paramIndex++}`);
    params.push(update.realizedPnlUsd);
  }
  if (update.revertReason !== undefined) {
    setClauses.push(`revert_reason = $${paramIndex++}`);
    params.push(update.revertReason);
  }
  if (update.errorMessage !== undefined) {
    setClauses.push(`error_message = $${paramIndex++}`);
    params.push(update.errorMessage);
  }

  params.push(id.toString());

  const query = `
    UPDATE executions
    SET ${setClauses.join(', ')}
    WHERE id = $${paramIndex}
  `;

  await pool.query(query, params);

  logger.debug(
    {
      executionId: id.toString(),
      status: update.status,
    },
    'Execution status updated'
  );
}

export async function getExecutionById(id: bigint): Promise<Execution | null> {
  const pool = getPool();

  const query = `
    SELECT * FROM executions WHERE id = $1
  `;

  const result = await pool.query(query, [id.toString()]);

  if (result.rows.length === 0) {
    return null;
  }

  return mapRowToExecution(result.rows[0]);
}

export async function getRecentExecutions(limit: number = 100): Promise<Execution[]> {
  const pool = getPool();

  const query = `
    SELECT * FROM executions
    ORDER BY created_at DESC
    LIMIT $1
  `;

  const result = await pool.query(query, [limit]);

  return result.rows.map(mapRowToExecution);
}

export async function getExecutionsByOpportunity(opportunityId: bigint): Promise<Execution[]> {
  const pool = getPool();

  const query = `
    SELECT * FROM executions
    WHERE opportunity_id = $1
    ORDER BY created_at DESC
  `;

  const result = await pool.query(query, [opportunityId.toString()]);

  return result.rows.map(mapRowToExecution);
}

export async function getExecutionStats(
  chain?: Chain,
  hoursBack: number = 24
): Promise<{
  total: number;
  paper: number;
  live: number;
  confirmed: number;
  reverted: number;
  pending: number;
  totalPnlUsd: number;
  totalGasCostUsd: number;
}> {
  const pool = getPool();

  const chainFilter = chain ? 'AND chain = $2' : '';
  const params: unknown[] = [hoursBack];
  if (chain) params.push(chain);

  const query = `
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE is_paper_trade = true) as paper,
      COUNT(*) FILTER (WHERE is_paper_trade = false) as live,
      COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
      COUNT(*) FILTER (WHERE status = 'reverted') as reverted,
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COALESCE(SUM(realized_pnl_usd), 0) as total_pnl_usd,
      COALESCE(SUM(gas_cost_usd), 0) as total_gas_cost_usd
    FROM executions
    WHERE created_at > NOW() - INTERVAL '1 hour' * $1
    ${chainFilter}
  `;

  const result = await pool.query(query, params);
  const row = result.rows[0];

  return {
    total: parseInt(row.total, 10),
    paper: parseInt(row.paper, 10),
    live: parseInt(row.live, 10),
    confirmed: parseInt(row.confirmed, 10),
    reverted: parseInt(row.reverted, 10),
    pending: parseInt(row.pending, 10),
    totalPnlUsd: parseFloat(row.total_pnl_usd),
    totalGasCostUsd: parseFloat(row.total_gas_cost_usd),
  };
}

function mapRowToExecution(row: Record<string, unknown>): Execution {
  return {
    id: BigInt(row.id as string),
    opportunityId: BigInt(row.opportunity_id as string),
    createdAt: row.created_at as Date,
    pairId: row.pair_id as number,
    chain: row.chain as Chain,
    direction: row.direction as TradeDirection,
    poolAddress: row.pool_address as string,
    inputToken: row.input_token as string,
    inputAmount: BigInt(row.input_amount as string),
    inputAmountHuman: parseFloat(row.input_amount_human as string),
    expectedOutput: BigInt(row.expected_output as string),
    expectedOutputHuman: parseFloat(row.expected_output_human as string),
    quotedPrice: parseFloat(row.quoted_price as string),
    maxSlippageBps: parseFloat(row.max_slippage_bps as string),
    amountOutMinimum: BigInt(row.amount_out_minimum as string),
    deadline: row.deadline as Date,
    gasPriceGwei: parseFloat(row.gas_price_gwei as string),
    maxFeePerGas: BigInt(row.max_fee_per_gas as string),
    maxPriorityFee: BigInt(row.max_priority_fee as string),
    gasLimit: row.gas_limit as number,
    isPaperTrade: row.is_paper_trade as boolean,
    txHash: row.tx_hash as string | undefined,
    submittedAt: row.submitted_at as Date | undefined,
    submittedBlock: row.submitted_block ? BigInt(row.submitted_block as string) : undefined,
    status: row.status as string,
    confirmedAt: row.confirmed_at as Date | undefined,
    confirmedBlock: row.confirmed_block ? BigInt(row.confirmed_block as string) : undefined,
    gasUsed: row.gas_used as number | undefined,
    gasCostUsd: row.gas_cost_usd ? parseFloat(row.gas_cost_usd as string) : undefined,
    actualOutput: row.actual_output ? BigInt(row.actual_output as string) : undefined,
    actualOutputHuman: row.actual_output_human
      ? parseFloat(row.actual_output_human as string)
      : undefined,
    realizedPrice: row.realized_price ? parseFloat(row.realized_price as string) : undefined,
    realizedSlippageBps: row.realized_slippage_bps
      ? parseFloat(row.realized_slippage_bps as string)
      : undefined,
    realizedPnlUsd: row.realized_pnl_usd ? parseFloat(row.realized_pnl_usd as string) : undefined,
    revertReason: row.revert_reason as string | undefined,
    errorMessage: row.error_message as string | undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    strategy: (row.strategy as Strategy) || 'dislocation',
  };
}
