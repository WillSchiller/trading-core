import type { Pool } from 'pg';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { FactorModel, PCASignalEvent, PCAExitEvent, PCAShadowExitEvent, AssetSignal, RegimeState } from './pca-stat-arb.js';

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

  async saveSignal(event: PCASignalEvent & { pc1Momentum?: number; regimeState?: RegimeState; ewmaVolBps?: number; pc1DisplacementBps?: number; marketContext?: Record<string, number> | null }): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO pca_signals (timestamp, asset, direction, z_score, residual, confidence, pc1_return, pc2_return, all_residuals, entry_price, pc1_momentum, regime_state, position_size_usd, ewma_vol_bps, pc1_displacement_bps, market_context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
        event.pc1Momentum ?? null,
        event.regimeState ?? null,
        event.positionSizeUsd > 0 ? event.positionSizeUsd : null,
        event.ewmaVolBps ?? null,
        event.pc1DisplacementBps ?? null,
        event.marketContext ? JSON.stringify(event.marketContext) : null,
      ]
    );

    this.logger.debug({ id: result.rows[0].id, asset: event.asset }, 'Signal saved');
    return result.rows[0].id;
  }

  async resolveSignal(event: PCAExitEvent): Promise<void> {
    const pnlUsd = event.positionSizeUsd > 0 && event.pnlBps != null
      ? (event.positionSizeUsd * event.pnlBps) / 10000
      : null;

    const attr = event.attribution;

    await this.pool.query(
      `UPDATE pca_signals
       SET resolved = true, exit_timestamp = $1, exit_z_score = $2, hold_time_ms = $3,
           exit_price = $5, pnl_bps = $6, exit_reason = $7, peak_pnl_bps = $8, trough_pnl_bps = $9, pnl_usd = $10,
           pc1_pnl_bps = $11, residual_pnl_bps = $12, pc1_pct_of_total = $13
       WHERE id = (SELECT id FROM pca_signals WHERE asset = $4 AND resolved = false ORDER BY timestamp DESC LIMIT 1)`,
      [
        event.exitTimestamp,
        event.exitZScore,
        event.holdTimeMs,
        event.asset,
        event.exitPrice > 0 ? event.exitPrice : null,
        event.pnlBps ?? null,
        event.exitReason ?? null,
        event.peakPnlBps ?? null,
        event.troughPnlBps ?? null,
        pnlUsd,
        attr?.pc1PnlBps ?? null,
        attr?.residualPnlBps ?? null,
        attr?.pc1PctOfTotal ?? null,
      ]
    );

    this.logger.debug({
      asset: event.asset,
      holdTimeMs: event.holdTimeMs,
      exitReason: event.exitReason,
      pnlUsd,
      pc1PnlBps: attr?.pc1PnlBps,
      residualPnlBps: attr?.residualPnlBps,
      pc1PctOfTotal: attr?.pc1PctOfTotal,
    }, 'Signal resolved');
  }

  async saveBenchmarkSignal(event: { asset: string; entryPrice: number; timestamp: number }): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO pca_signals (timestamp, asset, direction, z_score, residual, confidence, pc1_return, pc2_return, entry_price, position_size_usd)
       VALUES ($1, $2, 'random_short', 0, 0, 0, 0, 0, $3, 100)
       RETURNING id`,
      [event.timestamp, event.asset, event.entryPrice]
    );
    return result.rows[0].id;
  }

  async resolveBenchmarkSignal(event: {
    asset: string; exitPrice: number; pnlBps: number; peakPnlBps: number;
    troughPnlBps: number; holdTimeMs: number; exitReason: string; timestamp: number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE pca_signals
       SET resolved = true, exit_timestamp = $1, hold_time_ms = $2, exit_price = $3,
           pnl_bps = $4, exit_reason = $5, peak_pnl_bps = $6, trough_pnl_bps = $7,
           pnl_usd = $8
       WHERE id = (SELECT id FROM pca_signals WHERE asset = $9 AND direction = 'random_short' AND resolved = false AND timestamp = $10 LIMIT 1)`,
      [
        Date.now(), event.holdTimeMs, event.exitPrice, event.pnlBps,
        event.exitReason, event.peakPnlBps, event.troughPnlBps,
        100 * event.pnlBps / 10000,
        event.asset, event.timestamp,
      ]
    );
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

  async cleanupOrphanedPositions(maxStaleMs: number = 7200000): Promise<number> {
    const now = Date.now();

    const result = await this.pool.query(
      `WITH duplicates AS (
         SELECT id, asset, timestamp,
                ROW_NUMBER() OVER (PARTITION BY asset ORDER BY timestamp DESC) as rn
         FROM pca_signals
         WHERE resolved = false
       ),
       stale AS (
         SELECT id FROM pca_signals
         WHERE resolved = false AND ($1 - timestamp) > $2
       )
       UPDATE pca_signals
       SET resolved = true, exit_timestamp = $1, exit_reason = 'orphaned'
       WHERE id IN (
         SELECT id FROM duplicates WHERE rn > 1
         UNION
         SELECT id FROM stale
       )
       RETURNING id, asset`,
      [now, maxStaleMs]
    );
    this.logger.info(
      { count: result.rowCount ?? 0, maxStaleMs, assets: result.rows.map((r: { asset: string }) => r.asset) },
      'Orphan cleanup completed'
    );
    return result.rowCount ?? 0;
  }

  async getActiveSignals(): Promise<
    Array<{
      id: number;
      timestamp: number;
      asset: string;
      direction: 'long' | 'short';
      zScore: number;
      residual: number;
      entryPrice: number;
      positionSizeUsd: number;
      pc1Return: number;
      pc2Return: number;
      confidence: number;
    }>
  > {
    const result = await this.pool.query(
      `SELECT id, timestamp, asset, direction, z_score, residual, entry_price,
              position_size_usd, pc1_return, pc2_return, confidence
       FROM pca_signals
       WHERE resolved = false
       ORDER BY timestamp DESC`
    );

    return result.rows.map((row) => ({
      id: row.id,
      timestamp: parseInt(row.timestamp),
      asset: row.asset,
      direction: row.direction as 'long' | 'short',
      zScore: parseFloat(row.z_score),
      residual: parseFloat(row.residual),
      entryPrice: parseFloat(row.entry_price) || 0,
      positionSizeUsd: parseFloat(row.position_size_usd) || 100,
      pc1Return: parseFloat(row.pc1_return) || 0,
      pc2Return: parseFloat(row.pc2_return) || 0,
      confidence: parseFloat(row.confidence) || 0,
    }));
  }

  async updateCurrentPrices(prices: Record<string, number>): Promise<void> {
    const assets = Object.keys(prices);
    if (assets.length === 0) return;

    const cases = assets.map((_asset, i) => `WHEN asset = $${i + 1} THEN $${assets.length + i + 1}::numeric`).join(' ');
    const params = [...assets, ...assets.map(a => prices[a])];

    await this.pool.query(
      `UPDATE pca_signals
       SET current_price = CASE ${cases} END
       WHERE resolved = false AND asset = ANY($${params.length + 1})`,
      [...params, assets]
    );
  }

  async savePrice(asset: string, price: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO pca_prices (asset, price, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (asset) DO UPDATE SET price = $2, updated_at = NOW()`,
      [asset, price]
    );
  }

  async updateOpenSignalPrices(): Promise<void> {
    await this.pool.query(
      `UPDATE pca_signals s
       SET current_price = p.price
       FROM pca_prices p
       WHERE s.asset = p.asset AND s.resolved = false`
    );
  }

  async getCapitalDeployed(): Promise<{
    openPositions: number;
    totalDeployedUsd: number;
    longExposureUsd: number;
    shortExposureUsd: number;
    unrealizedPnlUsd: number;
  }> {
    const result = await this.pool.query(`SELECT * FROM v_pca_capital_deployed`);
    const row = result.rows[0];
    return {
      openPositions: parseInt(row?.open_positions ?? '0'),
      totalDeployedUsd: parseFloat(row?.total_deployed_usd ?? '0'),
      longExposureUsd: parseFloat(row?.long_exposure_usd ?? '0'),
      shortExposureUsd: parseFloat(row?.short_exposure_usd ?? '0'),
      unrealizedPnlUsd: parseFloat(row?.unrealized_pnl_usd ?? '0'),
    };
  }

  async savePriceHistory(prices: Record<string, number>, timestamp: number): Promise<void> {
    const assets = Object.keys(prices);
    if (assets.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const asset of assets) {
      placeholders.push(`($${idx++}, $${idx++}, $${idx++})`);
      values.push(timestamp, asset, prices[asset]);
    }

    await this.pool.query(
      `INSERT INTO pca_price_history (timestamp, asset, price) VALUES ${placeholders.join(', ')}`,
      values
    );
  }

  async loadPriceHistory(assets: string[], lookbackMs: number): Promise<Map<string, Array<{ price: number; ts: number }>>> {
    const cutoff = Date.now() - lookbackMs;

    const result = await this.pool.query(
      `SELECT asset, price, timestamp
       FROM pca_price_history
       WHERE asset = ANY($1) AND timestamp >= $2
       ORDER BY asset, timestamp ASC`,
      [assets, cutoff]
    );

    const history = new Map<string, Array<{ price: number; ts: number }>>();
    for (const asset of assets) {
      history.set(asset, []);
    }

    for (const row of result.rows) {
      const arr = history.get(row.asset);
      if (arr) {
        arr.push({ price: parseFloat(row.price), ts: parseInt(row.timestamp) });
      }
    }

    return history;
  }

  async resolveShadow(event: PCAShadowExitEvent): Promise<void> {
    await this.pool.query(
      `UPDATE pca_signals
       SET shadow_exit_timestamp = $1,
           shadow_pnl_bps = $2,
           shadow_peak_pnl_bps = $3,
           shadow_trough_pnl_bps = $4,
           shadow_hold_time_ms = $5,
           shadow_exit_reason = $6,
           shadow_exit_price = $7,
           shadow_pc1_pnl_bps = $8,
           shadow_residual_pnl_bps = $9
       WHERE asset = $10
         AND timestamp = $11
         AND resolved = true`,
      [
        event.shadowExitTimestamp,
        event.shadowPnlBps,
        event.shadowPeakPnlBps,
        event.shadowTroughPnlBps,
        event.shadowHoldTimeMs,
        event.shadowExitReason,
        event.shadowExitPrice,
        event.shadowPC1PnlBps,
        event.shadowResidualPnlBps,
        event.asset,
        event.signalTimestamp,
      ]
    );
    this.logger.debug(
      { asset: event.asset, realExit: event.realExitReason, shadowExit: event.shadowExitReason, shadowPnlBps: event.shadowPnlBps.toFixed(1) },
      'Shadow position resolved'
    );
  }
}
