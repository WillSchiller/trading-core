-- Widen direction column to support 'random_short' benchmark entries
-- Must drop/recreate all dependent views

DROP VIEW IF EXISTS v_pca_signal_performance, v_pca_open_signals, v_pca_capital_deployed,
  v_pca_pnl_attribution_series, v_pca_regime_performance, v_pca_regime_summary,
  v_pca_pnl_attribution, v_pca_pnl_attribution_by_asset, v_pca_mae_mfe,
  v_pca_stop_analysis, v_pca_mae_distribution, v_pca_shadow_driver CASCADE;

ALTER TABLE pca_signals ALTER COLUMN direction TYPE VARCHAR(20);

-- Recreate all views (copied from their original migrations)

CREATE OR REPLACE VIEW v_pca_signal_performance AS
SELECT asset, direction, count(*) AS total_signals,
  count(*) FILTER (WHERE resolved) AS resolved_signals,
  avg(hold_time_ms) / 60000::numeric AS avg_hold_min,
  avg(abs(z_score)) AS avg_entry_zscore,
  avg(abs(exit_z_score)) FILTER (WHERE resolved) AS avg_exit_zscore,
  count(*) FILTER (WHERE resolved AND abs(exit_z_score) < abs(z_score)) AS correct_direction,
  round(100.0 * count(*) FILTER (WHERE resolved AND abs(exit_z_score) < abs(z_score))::numeric / NULLIF(count(*) FILTER (WHERE resolved), 0)::numeric, 1) AS accuracy_pct
FROM pca_signals
WHERE timestamp::numeric > (EXTRACT(epoch FROM now() - '7 days'::interval) * 1000::numeric)
GROUP BY asset, direction;

CREATE OR REPLACE VIEW v_pca_open_signals AS
SELECT id, to_timestamp((timestamp / 1000)::double precision) AS opened_at, asset, direction,
  z_score AS entry_z, residual * 10000::numeric AS residual_bps, entry_price, current_price,
  CASE WHEN entry_price > 0 AND current_price > 0 THEN
    CASE direction WHEN 'long' THEN (current_price - entry_price) / entry_price * 10000
                   WHEN 'short' THEN (entry_price - current_price) / entry_price * 10000
                   ELSE NULL END
  ELSE NULL END AS unrealized_pnl_bps,
  EXTRACT(epoch FROM now() - to_timestamp((timestamp / 1000)::double precision)) / 60 AS hold_time_min
FROM pca_signals WHERE resolved = false ORDER BY timestamp DESC;

CREATE OR REPLACE VIEW v_pca_capital_deployed AS
SELECT count(*) AS open_positions,
  COALESCE(sum(position_size_usd), 0) AS total_deployed_usd,
  COALESCE(sum(CASE direction WHEN 'long' THEN position_size_usd ELSE 0 END), 0) AS long_exposure_usd,
  COALESCE(sum(CASE direction WHEN 'short' THEN position_size_usd ELSE 0 END), 0) AS short_exposure_usd,
  COALESCE(sum(CASE WHEN entry_price > 0 AND current_price > 0 THEN position_size_usd *
    CASE direction WHEN 'long' THEN (current_price - entry_price) / entry_price
                   WHEN 'short' THEN (entry_price - current_price) / entry_price ELSE NULL END
  ELSE 0 END), 0) AS unrealized_pnl_usd
FROM pca_signals WHERE resolved = false;

CREATE OR REPLACE VIEW v_pca_pnl_attribution_series AS
SELECT date_trunc('hour', to_timestamp((exit_timestamp / 1000)::double precision)) AS hour,
  direction, count(*) AS trades, round(sum(pnl_bps), 2) AS pnl_bps,
  round(sum(pc1_pnl_bps), 2) AS pc1_pnl_bps, round(sum(residual_pnl_bps), 2) AS residual_pnl_bps
FROM pca_signals WHERE resolved = true AND pnl_bps IS NOT NULL AND pc1_pnl_bps IS NOT NULL
GROUP BY date_trunc('hour', to_timestamp((exit_timestamp / 1000)::double precision)), direction
ORDER BY date_trunc('hour', to_timestamp((exit_timestamp / 1000)::double precision)) DESC;

CREATE OR REPLACE VIEW v_pca_regime_performance AS
SELECT asset, direction, regime_state, exit_reason, count(*) AS total_signals,
  count(*) FILTER (WHERE resolved) AS resolved_signals,
  round(avg(pnl_bps) FILTER (WHERE resolved), 2) AS avg_pnl_bps,
  round(sum(pnl_bps) FILTER (WHERE resolved), 2) AS total_pnl_bps,
  round(avg(hold_time_ms) FILTER (WHERE resolved) / 60000::numeric, 1) AS avg_hold_min,
  count(*) FILTER (WHERE resolved AND pnl_bps > 0) AS winning_trades,
  count(*) FILTER (WHERE resolved AND pnl_bps <= 0) AS losing_trades,
  round(100.0 * count(*) FILTER (WHERE resolved AND pnl_bps > 0)::numeric / NULLIF(count(*) FILTER (WHERE resolved), 0)::numeric, 1) AS win_rate_pct,
  round(avg(peak_pnl_bps) FILTER (WHERE resolved), 2) AS avg_peak_pnl_bps,
  round(avg(trough_pnl_bps) FILTER (WHERE resolved), 2) AS avg_trough_pnl_bps
FROM pca_signals WHERE timestamp::numeric > (EXTRACT(epoch FROM now() - '7 days'::interval) * 1000::numeric)
GROUP BY asset, direction, regime_state, exit_reason
ORDER BY direction, regime_state, round(sum(pnl_bps) FILTER (WHERE resolved), 2) DESC;

CREATE OR REPLACE VIEW v_pca_regime_summary AS
SELECT direction, regime_state, count(*) AS total_signals,
  count(*) FILTER (WHERE resolved) AS resolved,
  round(sum(pnl_bps) FILTER (WHERE resolved), 2) AS total_pnl_bps,
  round(100.0 * count(*) FILTER (WHERE resolved AND pnl_bps > 0)::numeric / NULLIF(count(*) FILTER (WHERE resolved), 0)::numeric, 1) AS win_rate_pct
FROM pca_signals WHERE timestamp::numeric > (EXTRACT(epoch FROM now() - '7 days'::interval) * 1000::numeric)
GROUP BY direction, regime_state ORDER BY direction, regime_state;

CREATE OR REPLACE VIEW v_pca_pnl_attribution AS
SELECT direction, count(*) AS total_trades,
  round(avg(pnl_bps), 2) AS avg_total_pnl_bps, round(sum(pnl_bps), 2) AS sum_total_pnl_bps,
  round(avg(pc1_pnl_bps), 2) AS avg_pc1_pnl_bps, round(sum(pc1_pnl_bps), 2) AS sum_pc1_pnl_bps,
  round(avg(residual_pnl_bps), 2) AS avg_residual_pnl_bps, round(sum(residual_pnl_bps), 2) AS sum_residual_pnl_bps,
  round(avg(pc1_pct_of_total) * 100, 1) AS avg_pc1_pct,
  round(CASE WHEN sum(pnl_bps) <> 0 THEN sum(pc1_pnl_bps) / sum(pnl_bps) * 100 ELSE 0 END, 1) AS aggregate_pc1_pct
FROM pca_signals WHERE resolved = true AND pnl_bps IS NOT NULL AND pc1_pnl_bps IS NOT NULL
GROUP BY direction;

CREATE OR REPLACE VIEW v_pca_pnl_attribution_by_asset AS
SELECT asset, direction, count(*) AS total_trades,
  round(sum(pnl_bps), 2) AS sum_pnl_bps, round(sum(pc1_pnl_bps), 2) AS sum_pc1_pnl_bps,
  round(sum(residual_pnl_bps), 2) AS sum_residual_pnl_bps,
  round(CASE WHEN sum(pnl_bps) <> 0 THEN sum(pc1_pnl_bps) / sum(pnl_bps) * 100 ELSE 0 END, 1) AS pc1_pct
FROM pca_signals WHERE resolved = true AND pnl_bps IS NOT NULL AND pc1_pnl_bps IS NOT NULL
GROUP BY asset, direction ORDER BY asset, direction;

CREATE OR REPLACE VIEW v_pca_mae_mfe AS
SELECT id, to_timestamp((timestamp / 1000)::double precision) AS entry_time, asset, direction, exit_reason,
  pnl_bps AS real_pnl_bps, peak_pnl_bps AS real_mfe_bps, trough_pnl_bps AS real_mae_bps,
  hold_time_ms::numeric / 60000.0 AS real_hold_min, pc1_pnl_bps AS real_pc1_bps, residual_pnl_bps AS real_residual_bps,
  shadow_pnl_bps, shadow_peak_pnl_bps AS shadow_mfe_bps, shadow_trough_pnl_bps AS shadow_mae_bps,
  shadow_hold_time_ms::numeric / 60000.0 AS shadow_hold_min, shadow_exit_reason,
  shadow_pc1_pnl_bps, shadow_residual_pnl_bps, shadow_pnl_bps - pnl_bps AS shadow_vs_real_bps,
  CASE WHEN shadow_pnl_bps > pnl_bps THEN true ELSE false END AS shadow_better
FROM pca_signals WHERE resolved = true AND shadow_exit_timestamp IS NOT NULL ORDER BY timestamp DESC;

CREATE OR REPLACE VIEW v_pca_stop_analysis AS
SELECT exit_reason AS real_exit_reason, direction, count(*) AS total_trades,
  count(*) FILTER (WHERE pnl_bps > 0) AS real_winners,
  round(100.0 * count(*) FILTER (WHERE pnl_bps > 0)::numeric / NULLIF(count(*), 0)::numeric, 1) AS real_win_pct,
  count(*) FILTER (WHERE shadow_pnl_bps > 0) AS shadow_winners,
  round(100.0 * count(*) FILTER (WHERE shadow_pnl_bps > 0)::numeric / NULLIF(count(*), 0)::numeric, 1) AS shadow_win_pct,
  round(avg(pnl_bps), 2) AS avg_real_pnl, round(avg(shadow_pnl_bps), 2) AS avg_shadow_pnl,
  round(avg(shadow_pnl_bps - pnl_bps), 2) AS avg_improvement_bps,
  count(*) FILTER (WHERE shadow_pnl_bps > pnl_bps) AS shadow_better_count,
  round(100.0 * count(*) FILTER (WHERE shadow_pnl_bps > pnl_bps)::numeric / NULLIF(count(*), 0)::numeric, 1) AS shadow_better_pct
FROM pca_signals WHERE resolved = true AND shadow_exit_timestamp IS NOT NULL
  AND exit_reason IN ('stop_loss', 'trailing_stop')
GROUP BY exit_reason, direction ORDER BY exit_reason, direction;

CREATE OR REPLACE VIEW v_pca_mae_distribution AS
SELECT direction, exit_reason, count(*) AS trades,
  count(*) FILTER (WHERE trough_pnl_bps > -25) AS mae_0_25,
  count(*) FILTER (WHERE trough_pnl_bps >= -50 AND trough_pnl_bps <= -25) AS mae_25_50,
  count(*) FILTER (WHERE trough_pnl_bps >= -100 AND trough_pnl_bps <= -50) AS mae_50_100,
  count(*) FILTER (WHERE trough_pnl_bps >= -150 AND trough_pnl_bps <= -100) AS mae_100_150,
  count(*) FILTER (WHERE trough_pnl_bps < -150) AS mae_gt_150,
  count(*) FILTER (WHERE shadow_trough_pnl_bps > -25) AS shadow_mae_0_25,
  count(*) FILTER (WHERE shadow_trough_pnl_bps >= -50 AND shadow_trough_pnl_bps <= -25) AS shadow_mae_25_50,
  count(*) FILTER (WHERE shadow_trough_pnl_bps >= -100 AND shadow_trough_pnl_bps <= -50) AS shadow_mae_50_100,
  count(*) FILTER (WHERE shadow_trough_pnl_bps >= -150 AND shadow_trough_pnl_bps <= -100) AS shadow_mae_100_150,
  count(*) FILTER (WHERE shadow_trough_pnl_bps < -150) AS shadow_mae_gt_150,
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY trough_pnl_bps::double precision)::numeric, 2) AS mae_p5_bps,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY trough_pnl_bps::double precision)::numeric, 2) AS mae_p25_bps,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY trough_pnl_bps::double precision)::numeric, 2) AS mae_p50_bps
FROM pca_signals WHERE resolved = true AND shadow_exit_timestamp IS NOT NULL
GROUP BY direction, exit_reason;

CREATE OR REPLACE VIEW v_pca_shadow_driver AS
SELECT direction, exit_reason AS real_exit_reason, shadow_exit_reason, count(*) AS trades,
  round(avg(shadow_pc1_pnl_bps) FILTER (WHERE shadow_pnl_bps > 0), 2) AS winner_pc1_bps,
  round(avg(shadow_residual_pnl_bps) FILTER (WHERE shadow_pnl_bps > 0), 2) AS winner_residual_bps,
  round(avg(shadow_pc1_pnl_bps) FILTER (WHERE shadow_pnl_bps <= 0), 2) AS loser_pc1_bps,
  round(avg(shadow_residual_pnl_bps) FILTER (WHERE shadow_pnl_bps <= 0), 2) AS loser_residual_bps,
  count(*) FILTER (WHERE shadow_pnl_bps > 0 AND abs(shadow_residual_pnl_bps) > abs(shadow_pc1_pnl_bps)) AS residual_driven_winners,
  count(*) FILTER (WHERE shadow_pnl_bps > 0 AND abs(shadow_pc1_pnl_bps) >= abs(shadow_residual_pnl_bps)) AS pc1_driven_winners
FROM pca_signals WHERE resolved = true AND shadow_exit_timestamp IS NOT NULL
GROUP BY direction, exit_reason, shadow_exit_reason;
