-- Shadow-hold tracking for MAE/MFE analysis
-- Records what would have happened if positions had no stops,
-- only exiting on zero-cross or 12h max hold.

ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS shadow_exit_timestamp BIGINT;
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS shadow_pnl_bps NUMERIC(10,4);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS shadow_peak_pnl_bps NUMERIC(10,4);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS shadow_trough_pnl_bps NUMERIC(10,4);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS shadow_hold_time_ms BIGINT;
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS shadow_exit_reason VARCHAR(20);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS shadow_exit_price NUMERIC(18,8);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS shadow_pc1_pnl_bps NUMERIC(10,4);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS shadow_residual_pnl_bps NUMERIC(10,4);

CREATE INDEX IF NOT EXISTS idx_pca_signals_shadow ON pca_signals(shadow_exit_reason)
  WHERE shadow_exit_timestamp IS NOT NULL;

-- View 1: Real vs shadow outcomes side-by-side
CREATE OR REPLACE VIEW v_pca_mae_mfe AS
SELECT
    id,
    to_timestamp(timestamp / 1000) AS entry_time,
    asset,
    direction,
    exit_reason,
    pnl_bps AS real_pnl_bps,
    peak_pnl_bps AS real_mfe_bps,
    trough_pnl_bps AS real_mae_bps,
    hold_time_ms / 60000.0 AS real_hold_min,
    pc1_pnl_bps AS real_pc1_bps,
    residual_pnl_bps AS real_residual_bps,
    shadow_pnl_bps,
    shadow_peak_pnl_bps AS shadow_mfe_bps,
    shadow_trough_pnl_bps AS shadow_mae_bps,
    shadow_hold_time_ms / 60000.0 AS shadow_hold_min,
    shadow_exit_reason,
    shadow_pc1_pnl_bps,
    shadow_residual_pnl_bps,
    shadow_pnl_bps - pnl_bps AS shadow_vs_real_bps,
    CASE WHEN shadow_pnl_bps > pnl_bps THEN true ELSE false END AS shadow_better
FROM pca_signals
WHERE resolved = true
  AND shadow_exit_timestamp IS NOT NULL
ORDER BY timestamp DESC;

-- View 2: Q1 - Do stopped trades later become profitable?
CREATE OR REPLACE VIEW v_pca_stop_analysis AS
SELECT
    exit_reason AS real_exit_reason,
    direction,
    COUNT(*) AS total_trades,
    COUNT(*) FILTER (WHERE pnl_bps > 0) AS real_winners,
    ROUND(100.0 * COUNT(*) FILTER (WHERE pnl_bps > 0) / NULLIF(COUNT(*), 0), 1) AS real_win_pct,
    COUNT(*) FILTER (WHERE shadow_pnl_bps > 0) AS shadow_winners,
    ROUND(100.0 * COUNT(*) FILTER (WHERE shadow_pnl_bps > 0) / NULLIF(COUNT(*), 0), 1) AS shadow_win_pct,
    ROUND(AVG(pnl_bps)::numeric, 2) AS avg_real_pnl,
    ROUND(AVG(shadow_pnl_bps)::numeric, 2) AS avg_shadow_pnl,
    ROUND(AVG(shadow_pnl_bps - pnl_bps)::numeric, 2) AS avg_improvement_bps,
    COUNT(*) FILTER (WHERE shadow_pnl_bps > pnl_bps) AS shadow_better_count,
    ROUND(100.0 * COUNT(*) FILTER (WHERE shadow_pnl_bps > pnl_bps)
      / NULLIF(COUNT(*), 0), 1) AS shadow_better_pct
FROM pca_signals
WHERE resolved = true
  AND shadow_exit_timestamp IS NOT NULL
  AND exit_reason IN ('stop_loss', 'trailing_stop')
GROUP BY exit_reason, direction
ORDER BY exit_reason, direction;

-- View 3: Q2 - Is MAE distribution fat-tailed?
CREATE OR REPLACE VIEW v_pca_mae_distribution AS
SELECT
    direction,
    exit_reason,
    COUNT(*) AS trades,
    COUNT(*) FILTER (WHERE trough_pnl_bps > -25) AS mae_0_25,
    COUNT(*) FILTER (WHERE trough_pnl_bps BETWEEN -50 AND -25) AS mae_25_50,
    COUNT(*) FILTER (WHERE trough_pnl_bps BETWEEN -100 AND -50) AS mae_50_100,
    COUNT(*) FILTER (WHERE trough_pnl_bps BETWEEN -150 AND -100) AS mae_100_150,
    COUNT(*) FILTER (WHERE trough_pnl_bps < -150) AS mae_gt_150,
    COUNT(*) FILTER (WHERE shadow_trough_pnl_bps > -25) AS shadow_mae_0_25,
    COUNT(*) FILTER (WHERE shadow_trough_pnl_bps BETWEEN -50 AND -25) AS shadow_mae_25_50,
    COUNT(*) FILTER (WHERE shadow_trough_pnl_bps BETWEEN -100 AND -50) AS shadow_mae_50_100,
    COUNT(*) FILTER (WHERE shadow_trough_pnl_bps BETWEEN -150 AND -100) AS shadow_mae_100_150,
    COUNT(*) FILTER (WHERE shadow_trough_pnl_bps < -150) AS shadow_mae_gt_150,
    ROUND(PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY trough_pnl_bps)::numeric, 2) AS mae_p5_bps,
    ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY trough_pnl_bps)::numeric, 2) AS mae_p25_bps,
    ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY trough_pnl_bps)::numeric, 2) AS mae_p50_bps
FROM pca_signals
WHERE resolved = true
  AND shadow_exit_timestamp IS NOT NULL
GROUP BY direction, exit_reason;

-- View 4: Q3 - PC1 continuation vs residual collapse?
CREATE OR REPLACE VIEW v_pca_shadow_driver AS
SELECT
    direction,
    exit_reason AS real_exit_reason,
    shadow_exit_reason,
    COUNT(*) AS trades,
    ROUND(AVG(shadow_pc1_pnl_bps) FILTER (WHERE shadow_pnl_bps > 0)::numeric, 2) AS winner_pc1_bps,
    ROUND(AVG(shadow_residual_pnl_bps) FILTER (WHERE shadow_pnl_bps > 0)::numeric, 2) AS winner_residual_bps,
    ROUND(AVG(shadow_pc1_pnl_bps) FILTER (WHERE shadow_pnl_bps <= 0)::numeric, 2) AS loser_pc1_bps,
    ROUND(AVG(shadow_residual_pnl_bps) FILTER (WHERE shadow_pnl_bps <= 0)::numeric, 2) AS loser_residual_bps,
    COUNT(*) FILTER (
      WHERE shadow_pnl_bps > 0
        AND ABS(shadow_residual_pnl_bps) > ABS(shadow_pc1_pnl_bps)
    ) AS residual_driven_winners,
    COUNT(*) FILTER (
      WHERE shadow_pnl_bps > 0
        AND ABS(shadow_pc1_pnl_bps) >= ABS(shadow_residual_pnl_bps)
    ) AS pc1_driven_winners
FROM pca_signals
WHERE resolved = true
  AND shadow_exit_timestamp IS NOT NULL
GROUP BY direction, exit_reason, shadow_exit_reason;
