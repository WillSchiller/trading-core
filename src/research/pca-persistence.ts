import type { Pool } from 'pg';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { FactorModel, PCASignalEvent, PCAExitEvent, AssetSignal } from './pca-stat-arb.js';

export class PCAPersistence {
  private pool: Pool;
  private logger: Logger;

  constructor(pool: Pool) {
    this.pool = pool;
    this.logger = createChildLogger({ component: 'pca-persistence' });
  }

  async saveFactorModel(model: FactorModel): Promise<number> {
    const pc1Loadings: Record<string, number> = {};
    const pc2Loadings: Record<string, number> = {};

    for (const [asset, betas] of model.assetBetas) {
      if (betas[0] !== undefined) pc1Loadings[asset] = betas[0];
      if (betas[1] !== undefined) pc2Loadings[asset] = betas[1];
    }

    const result = await this.pool.query(
      `INSERT INTO pca_factor_models (timestamp, num_factors, variance_explained, pc1_loadings, pc2_loadings, eigenvalues)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        model.timestamp,
        model.eigenvectors.length,
        model.varianceExplained,
        JSON.stringify(pc1Loadings),
        Object.keys(pc2Loadings).length > 0 ? JSON.stringify(pc2Loadings) : null,
        model.eigenvalues,
      ]
    );

    this.logger.debug({ id: result.rows[0].id }, 'Factor model saved');
    return result.rows[0].id;
  }

  async saveSignal(event: PCASignalEvent): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO pca_signals (timestamp, asset, direction, z_score, residual, confidence, pc1_return, pc2_return, all_residuals, entry_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        event.timestamp,
        event.asset,
        event.direction,
        event.zScore,
        event.residual,
        event.confidence,
        event.factorContext.pc1Return,
        event.factorContext.pc2Return,
        JSON.stringify(event.allAssetResiduals),
        event.entryPrice > 0 ? event.entryPrice : null,
      ]
    );

    this.logger.debug({ id: result.rows[0].id, asset: event.asset }, 'Signal saved');
    return result.rows[0].id;
  }

  async resolveSignal(event: PCAExitEvent): Promise<void> {
    await this.pool.query(
      `UPDATE pca_signals
       SET resolved = true, exit_timestamp = $1, exit_z_score = $2, hold_time_ms = $3,
           exit_price = $5, pnl_bps = $6
       WHERE asset = $4 AND resolved = false
       ORDER BY timestamp DESC LIMIT 1`,
      [event.exitTimestamp, event.exitZScore, event.holdTimeMs, event.asset, event.exitPrice > 0 ? event.exitPrice : null, event.pnlBps ?? null]
    );

    this.logger.debug({ asset: event.asset, holdTimeMs: event.holdTimeMs }, 'Signal resolved');
  }

  async saveResiduals(signals: AssetSignal[]): Promise<void> {
    if (signals.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const signal of signals) {
      placeholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
      );
      values.push(
        signal.timestamp,
        signal.asset,
        signal.actualReturn,
        signal.expectedReturn,
        signal.residual,
        signal.residualZScore,
        signal.factorReturns[0] ?? null,
        signal.factorReturns[1] ?? null
      );
    }

    await this.pool.query(
      `INSERT INTO pca_residuals (timestamp, asset, actual_return, expected_return, residual, z_score, pc1_return, pc2_return)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  }

  async getSignalPerformance(): Promise<
    Array<{
      asset: string;
      direction: string;
      totalSignals: number;
      resolvedSignals: number;
      avgHoldMin: number;
      avgEntryZscore: number;
      avgExitZscore: number;
      correctDirection: number;
      accuracyPct: number;
    }>
  > {
    const result = await this.pool.query(`SELECT * FROM v_pca_signal_performance`);
    return result.rows.map((row) => ({
      asset: row.asset,
      direction: row.direction,
      totalSignals: parseInt(row.total_signals),
      resolvedSignals: parseInt(row.resolved_signals),
      avgHoldMin: parseFloat(row.avg_hold_min) || 0,
      avgEntryZscore: parseFloat(row.avg_entry_zscore) || 0,
      avgExitZscore: parseFloat(row.avg_exit_zscore) || 0,
      correctDirection: parseInt(row.correct_direction) || 0,
      accuracyPct: parseFloat(row.accuracy_pct) || 0,
    }));
  }

  async getResidualStats(): Promise<
    Array<{
      asset: string;
      observations: number;
      avgResidual: number;
      stdResidual: number;
      minZscore: number;
      maxZscore: number;
      avgAbsZscore: number;
    }>
  > {
    const result = await this.pool.query(`SELECT * FROM v_pca_residual_stats`);
    return result.rows.map((row) => ({
      asset: row.asset,
      observations: parseInt(row.observations),
      avgResidual: parseFloat(row.avg_residual) || 0,
      stdResidual: parseFloat(row.std_residual) || 0,
      minZscore: parseFloat(row.min_zscore) || 0,
      maxZscore: parseFloat(row.max_zscore) || 0,
      avgAbsZscore: parseFloat(row.avg_abs_zscore) || 0,
    }));
  }

  async getRecentFactorModels(
    limit: number = 10
  ): Promise<
    Array<{
      id: number;
      timestamp: number;
      numFactors: number;
      varianceExplained: number[];
      pc1Loadings: Record<string, number>;
    }>
  > {
    const result = await this.pool.query(
      `SELECT id, timestamp, num_factors, variance_explained, pc1_loadings
       FROM pca_factor_models
       ORDER BY timestamp DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map((row) => ({
      id: row.id,
      timestamp: parseInt(row.timestamp),
      numFactors: row.num_factors,
      varianceExplained: row.variance_explained,
      pc1Loadings: row.pc1_loadings,
    }));
  }

  async getActiveSignals(): Promise<
    Array<{
      id: number;
      timestamp: number;
      asset: string;
      direction: string;
      zScore: number;
      residual: number;
    }>
  > {
    const result = await this.pool.query(
      `SELECT id, timestamp, asset, direction, z_score, residual
       FROM pca_signals
       WHERE resolved = false
       ORDER BY timestamp DESC`
    );

    return result.rows.map((row) => ({
      id: row.id,
      timestamp: parseInt(row.timestamp),
      asset: row.asset,
      direction: row.direction,
      zScore: parseFloat(row.z_score),
      residual: parseFloat(row.residual),
    }));
  }

  async updateCurrentPrices(prices: Record<string, number>): Promise<void> {
    const assets = Object.keys(prices);
    if (assets.length === 0) return;

    const cases = assets.map((_asset, i) => `WHEN asset = $${i + 1} THEN $${assets.length + i + 1}`).join(' ');
    const params = [...assets, ...assets.map(a => prices[a])];

    await this.pool.query(
      `UPDATE pca_signals
       SET current_price = CASE ${cases} END
       WHERE resolved = false AND asset = ANY($${params.length + 1})`,
      [...params, assets]
    );
  }
}
