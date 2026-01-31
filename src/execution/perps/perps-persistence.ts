import type { Pool } from 'pg';
import { createChildLogger } from '../../utils/logger.js';
import { toMicros } from './money.js';
import type { PerpsExecution, PerpsExecutionStatus, PerpsMode } from './types.js';

const log = createChildLogger({ component: 'perps-persistence' });

interface PerpsExecutionRow {
  id: number;
  run_id: string;
  mode: string;
  symbol: string;
  asset: string;
  direction: string;
  side: string;
  entry_price: string;
  exit_price: string | null;
  quantity: string;
  notional_usd: string;
  realized_pnl: string | null;
  unrealized_pnl: string | null;
  client_order_id: string;
  entry_order_id: string | null;
  exit_order_id: string | null;
  status: string;
  is_paper_trade: boolean;
  signal_timestamp: string;
  z_score: string;
  residual: string;
  confidence: string;
  exit_reason: string | null;
  leverage: number;
  margin_type: string;
  created_at: Date;
  updated_at: Date;
}

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

function validateNumeric(value: string, field: string): string {
  if (!NUMERIC_RE.test(value)) {
    throw new Error(`Invalid numeric value for ${field}: "${value}"`);
  }
  return value;
}

export class PerpsPersistence {
  constructor(
    private readonly pool: Pool,
    private readonly runId: string,
    private readonly mode: PerpsMode,
  ) {}

  async saveExecution(exec: Omit<PerpsExecution, 'id' | 'runId' | 'mode' | 'createdAt' | 'updatedAt'>): Promise<number> {
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO perps_executions
       (run_id, mode, symbol, asset, direction, side, entry_price, exit_price, quantity, notional_usd,
        realized_pnl, unrealized_pnl, client_order_id, entry_order_id, exit_order_id,
        status, is_paper_trade, signal_timestamp, z_score, residual, confidence,
        exit_reason, leverage, margin_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT (run_id, client_order_id) DO NOTHING
       RETURNING id`,
      [
        this.runId, this.mode,
        exec.symbol, exec.asset, exec.direction, exec.side,
        exec.entryPrice, exec.exitPrice, exec.quantity, exec.notionalUsd,
        exec.realizedPnl, exec.unrealizedPnl, exec.clientOrderId,
        exec.entryOrderId, exec.exitOrderId, exec.status, exec.isPaperTrade,
        exec.signalTimestamp, exec.zScore, exec.residual, exec.confidence,
        exec.exitReason, exec.leverage, exec.marginType,
      ]
    );
    const id = result.rows[0]?.id ?? -1;
    if (id === -1) {
      log.warn({ clientOrderId: exec.clientOrderId, runId: this.runId }, 'Duplicate execution, skipped insert');
    }
    return id;
  }

  async updateExecution(clientOrderId: string, updates: {
    status?: PerpsExecutionStatus;
    exitPrice?: string;
    exitOrderId?: string;
    realizedPnl?: string;
    unrealizedPnl?: string;
    exitReason?: string;
  }): Promise<void> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: (string | number)[] = [];
    let idx = 1;

    if (updates.status !== undefined) { setClauses.push(`status = $${idx++}`); values.push(updates.status); }
    if (updates.exitPrice !== undefined) { setClauses.push(`exit_price = $${idx++}`); values.push(updates.exitPrice); }
    if (updates.exitOrderId !== undefined) { setClauses.push(`exit_order_id = $${idx++}`); values.push(updates.exitOrderId); }
    if (updates.realizedPnl !== undefined) { setClauses.push(`realized_pnl = $${idx++}`); values.push(updates.realizedPnl); }
    if (updates.unrealizedPnl !== undefined) { setClauses.push(`unrealized_pnl = $${idx++}`); values.push(updates.unrealizedPnl); }
    if (updates.exitReason !== undefined) { setClauses.push(`exit_reason = $${idx++}`); values.push(updates.exitReason); }

    values.push(this.runId, clientOrderId);
    await this.pool.query(
      `UPDATE perps_executions SET ${setClauses.join(', ')} WHERE run_id = $${idx++} AND client_order_id = $${idx}`,
      values
    );
  }

  async updateExecutionEntry(clientOrderId: string, updates: {
    status: PerpsExecutionStatus;
    entryPrice: string;
    quantity: string;
    notionalUsd: string;
    entryOrderId: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE perps_executions
       SET status = $1, entry_price = $2, quantity = $3, notional_usd = $4,
           entry_order_id = $5, updated_at = NOW()
       WHERE run_id = $6 AND client_order_id = $7`,
      [updates.status, updates.entryPrice, updates.quantity, updates.notionalUsd,
       updates.entryOrderId, this.runId, clientOrderId]
    );
  }

  async claimClose(clientOrderId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE perps_executions SET status = 'closing', updated_at = NOW()
       WHERE run_id = $1 AND client_order_id = $2 AND status = 'open'`,
      [this.runId, clientOrderId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getExecutionByClientOrderId(clientOrderId: string): Promise<PerpsExecution | null> {
    const result = await this.pool.query<PerpsExecutionRow>(
      `SELECT * FROM perps_executions WHERE run_id = $1 AND client_order_id = $2`,
      [this.runId, clientOrderId]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async getOpenExecutions(): Promise<PerpsExecution[]> {
    const result = await this.pool.query<PerpsExecutionRow>(
      `SELECT * FROM perps_executions WHERE run_id = $1 AND status IN ('pending_open', 'open', 'closing') ORDER BY created_at`,
      [this.runId]
    );
    return result.rows.map(r => this.mapRow(r));
  }

  async getDailyPnlMicros(): Promise<bigint> {
    const result = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(realized_pnl), 0) AS total
       FROM perps_executions
       WHERE run_id = $1 AND status = 'closed'
       AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')`,
      [this.runId]
    );
    return toMicros(result.rows[0]?.total ?? '0');
  }

  async getTotalPnlMicros(): Promise<bigint> {
    const result = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(realized_pnl), 0) AS total
       FROM perps_executions WHERE run_id = $1 AND status = 'closed'`,
      [this.runId]
    );
    return toMicros(result.rows[0]?.total ?? '0');
  }

  async getConsecutiveLosses(): Promise<number> {
    const result = await this.pool.query<{ cnt: string }>(
      `WITH recent AS (
         SELECT realized_pnl,
                ROW_NUMBER() OVER (ORDER BY updated_at DESC) AS rn
         FROM perps_executions
         WHERE run_id = $1 AND status = 'closed' AND realized_pnl IS NOT NULL
       )
       SELECT COUNT(*) AS cnt FROM recent
       WHERE rn <= (
         SELECT COALESCE(MIN(rn) - 1, COUNT(*))
         FROM recent WHERE realized_pnl >= 0
       )`,
      [this.runId]
    );
    return parseInt(result.rows[0]?.cnt ?? '0', 10);
  }

  async getOpenExecutionForAsset(asset: string): Promise<PerpsExecution | null> {
    const result = await this.pool.query<PerpsExecutionRow>(
      `SELECT * FROM perps_executions WHERE run_id = $1 AND asset = $2 AND status IN ('pending_open', 'open', 'closing') LIMIT 1`,
      [this.runId, asset]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async saveKillSwitchEvent(event: Omit<import('./types.js').KillSwitchEvent, 'id' | 'timestamp'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO perps_kill_switch_events (run_id, reason, daily_pnl, total_pnl, consecutive_losses, positions_closed_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [this.runId, event.reason, event.dailyPnl, event.totalPnl, event.consecutiveLosses, event.positionsClosedCount]
    );
  }

  getRunId(): string {
    return this.runId;
  }

  getMode(): PerpsMode {
    return this.mode;
  }

  private mapRow(row: PerpsExecutionRow): PerpsExecution {
    if (!row.client_order_id || !row.asset || !row.symbol) {
      throw new Error(`Malformed perps_executions row: missing required field (id=${row.id})`);
    }
    const entryPrice = validateNumeric(row.entry_price, 'entry_price');
    const quantity = validateNumeric(row.quantity, 'quantity');
    const notionalUsd = validateNumeric(row.notional_usd, 'notional_usd');

    return {
      id: row.id,
      runId: row.run_id,
      mode: row.mode as PerpsExecution['mode'],
      symbol: row.symbol,
      asset: row.asset,
      direction: row.direction as PerpsExecution['direction'],
      side: row.side as PerpsExecution['side'],
      entryPrice,
      exitPrice: row.exit_price ? validateNumeric(row.exit_price, 'exit_price') : null,
      quantity,
      notionalUsd,
      realizedPnl: row.realized_pnl ? validateNumeric(row.realized_pnl, 'realized_pnl') : null,
      unrealizedPnl: row.unrealized_pnl ? validateNumeric(row.unrealized_pnl, 'unrealized_pnl') : null,
      clientOrderId: row.client_order_id,
      entryOrderId: row.entry_order_id,
      exitOrderId: row.exit_order_id,
      status: row.status as PerpsExecution['status'],
      isPaperTrade: row.is_paper_trade,
      signalTimestamp: parseInt(row.signal_timestamp, 10),
      zScore: Number(row.z_score),
      residual: Number(row.residual),
      confidence: Number(row.confidence),
      exitReason: row.exit_reason as PerpsExecution['exitReason'],
      leverage: row.leverage,
      marginType: row.margin_type as PerpsExecution['marginType'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
