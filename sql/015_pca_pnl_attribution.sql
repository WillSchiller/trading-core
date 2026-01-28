-- P&L Attribution columns for pca_signals
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS pc1_pnl_bps NUMERIC(10,4);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS residual_pnl_bps NUMERIC(10,4);
ALTER TABLE pca_signals ADD COLUMN IF NOT EXISTS pc1_pct_of_total NUMERIC(6,4);

-- Attribution summary view
CREATE OR REPLACE VIEW v_pca_pnl_attribution AS
SELECT
    direction,
    COUNT(*) AS total_trades,
    ROUND(AVG(pnl_bps)::numeric, 2) AS avg_total_pnl_bps,
    ROUND(SUM(pnl_bps)::numeric, 2) AS sum_total_pnl_bps,
    ROUND(AVG(pc1_pnl_bps)::numeric, 2) AS avg_pc1_pnl_bps,
    ROUND(SUM(pc1_pnl_bps)::numeric, 2) AS sum_pc1_pnl_bps,
    ROUND(AVG(residual_pnl_bps)::numeric, 2) AS avg_residual_pnl_bps,
    ROUND(SUM(residual_pnl_bps)::numeric, 2) AS sum_residual_pnl_bps,
    ROUND(AVG(pc1_pct_of_total)::numeric * 100, 1) AS avg_pc1_pct,
    ROUND(
        CASE
            WHEN SUM(pnl_bps) != 0 THEN SUM(pc1_pnl_bps) / SUM(pnl_bps) * 100
            ELSE 0
        END::numeric, 1
    ) AS aggregate_pc1_pct
FROM pca_signals
WHERE resolved = true
    AND pnl_bps IS NOT NULL
    AND pc1_pnl_bps IS NOT NULL
GROUP BY direction;

-- Attribution by asset view
CREATE OR REPLACE VIEW v_pca_pnl_attribution_by_asset AS
SELECT
    asset,
    direction,
    COUNT(*) AS total_trades,
    ROUND(SUM(pnl_bps)::numeric, 2) AS sum_pnl_bps,
    ROUND(SUM(pc1_pnl_bps)::numeric, 2) AS sum_pc1_pnl_bps,
    ROUND(SUM(residual_pnl_bps)::numeric, 2) AS sum_residual_pnl_bps,
    ROUND(
        CASE
            WHEN SUM(pnl_bps) != 0 THEN SUM(pc1_pnl_bps) / SUM(pnl_bps) * 100
            ELSE 0
        END::numeric, 1
    ) AS pc1_pct
FROM pca_signals
WHERE resolved = true
    AND pnl_bps IS NOT NULL
    AND pc1_pnl_bps IS NOT NULL
GROUP BY asset, direction
ORDER BY asset, direction;

-- Time series of attribution (for trend analysis)
CREATE OR REPLACE VIEW v_pca_pnl_attribution_series AS
SELECT
    DATE_TRUNC('hour', to_timestamp(exit_timestamp / 1000)) AS hour,
    direction,
    COUNT(*) AS trades,
    ROUND(SUM(pnl_bps)::numeric, 2) AS pnl_bps,
    ROUND(SUM(pc1_pnl_bps)::numeric, 2) AS pc1_pnl_bps,
    ROUND(SUM(residual_pnl_bps)::numeric, 2) AS residual_pnl_bps
FROM pca_signals
WHERE resolved = true
    AND pnl_bps IS NOT NULL
    AND pc1_pnl_bps IS NOT NULL
GROUP BY hour, direction
ORDER BY hour DESC;
