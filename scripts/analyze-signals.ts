#!/usr/bin/env npx tsx
import pg from 'pg';

const connString = process.argv[2] || process.env.DATABASE_URL || 'postgresql://trader@localhost:5432/dislocation_trader';
const sinceDate = process.argv[3] || '2026-03-05';

const pool = new pg.Pool({ connectionString: connString, ssl: false });

async function query(sql: string) {
  const res = await pool.query(sql);
  return res.rows;
}

function table(rows: Record<string, unknown>[], title: string) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(80));
  if (rows.length === 0) { console.log('  (no data)'); return; }
  console.table(rows);
}

async function run() {
  console.log(`\nPCA Signal Analysis — data since ${sinceDate}`);
  console.log(`Connected to: ${connString.replace(/:[^:@]+@/, ':***@')}`);

  // 1. Overview
  table(await query(`
    SELECT direction, COUNT(*) as signals,
      COUNT(CASE WHEN resolved THEN 1 END) as resolved,
      ROUND(AVG(CASE WHEN resolved THEN pnl_bps END)::numeric, 1) as avg_pnl_bps,
      ROUND(SUM(CASE WHEN resolved THEN pnl_bps END)::numeric, 0) as total_pnl_bps,
      ROUND(100.0 * COUNT(CASE WHEN pnl_bps > 0 THEN 1 END) / NULLIF(COUNT(CASE WHEN resolved THEN 1 END), 0)::numeric, 1) as win_pct
    FROM pca_signals WHERE created_at > '${sinceDate}'
    GROUP BY direction ORDER BY direction
  `), 'OVERVIEW: Signal counts by direction');

  // 2. Signal vs Random
  table(await query(`
    SELECT direction,
      COUNT(*) as cnt,
      ROUND(AVG(pnl_bps)::numeric, 1) as avg_pnl,
      ROUND(SUM(pnl_bps)::numeric, 0) as total_pnl,
      ROUND(100.0 * COUNT(CASE WHEN pnl_bps > 0 THEN 1 END) / COUNT(*)::numeric, 1) as win_pct,
      ROUND(AVG(pc1_pnl_bps)::numeric, 1) as avg_pc1_pnl,
      ROUND(AVG(residual_pnl_bps)::numeric, 1) as avg_residual_pnl
    FROM pca_signals
    WHERE created_at > '${sinceDate}' AND direction IN ('short','random_short') AND resolved = true
    GROUP BY direction ORDER BY direction
  `), 'SIGNAL vs RANDOM');

  // 3. Exit reason distribution
  table(await query(`
    SELECT exit_reason,
      COUNT(*) as cnt,
      ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER()::numeric, 1) as pct,
      ROUND(AVG(pnl_bps)::numeric, 1) as avg_pnl,
      ROUND(SUM(pnl_bps)::numeric, 0) as total_pnl,
      ROUND(100.0 * COUNT(CASE WHEN pnl_bps > 0 THEN 1 END) / COUNT(*)::numeric, 1) as win_pct
    FROM pca_signals
    WHERE created_at > '${sinceDate}' AND direction = 'short' AND resolved = true
    GROUP BY exit_reason ORDER BY cnt DESC
  `), 'EXIT REASON DISTRIBUTION (shorts)');

  // 4. Counter-trend vs with-trend
  table(await query(`
    SELECT
      CASE WHEN pc1_return > 0.001 THEN 'counter_trend' ELSE 'with_trend' END as entry_type,
      COUNT(*) as cnt,
      ROUND(AVG(pnl_bps)::numeric, 1) as avg_pnl,
      ROUND(SUM(pnl_bps)::numeric, 0) as total_pnl,
      ROUND(AVG(pc1_pnl_bps)::numeric, 1) as pc1_pnl,
      ROUND(AVG(residual_pnl_bps)::numeric, 1) as residual_pnl,
      ROUND(100.0 * COUNT(CASE WHEN exit_reason = 'trailing_stop' THEN 1 END) / COUNT(*)::numeric, 1) as trailing_pct,
      ROUND(100.0 * COUNT(CASE WHEN exit_reason = 'bounce_fail' THEN 1 END) / COUNT(*)::numeric, 1) as bf_pct
    FROM pca_signals
    WHERE created_at > '${sinceDate}' AND direction = 'short' AND resolved = true AND pc1_pnl_bps IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `), 'COUNTER-TREND vs WITH-TREND (shorts)');

  // 5. Per-asset performance
  table(await query(`
    SELECT asset,
      COUNT(*) as cnt,
      ROUND(AVG(pnl_bps)::numeric, 1) as avg_pnl,
      ROUND(SUM(pnl_bps)::numeric, 0) as total_pnl,
      COUNT(CASE WHEN exit_reason = 'trailing_stop' THEN 1 END) as trailing,
      COUNT(CASE WHEN exit_reason = 'bounce_fail' THEN 1 END) as bf,
      COUNT(CASE WHEN exit_reason = 'stall_exit' THEN 1 END) as stall
    FROM pca_signals
    WHERE created_at > '${sinceDate}' AND direction = 'short' AND resolved = true
    GROUP BY asset ORDER BY total_pnl DESC
  `), 'PER-ASSET PERFORMANCE (shorts, sorted by total PnL)');

  // 6. Hourly pattern
  table(await query(`
    SELECT EXTRACT(hour FROM created_at)::int as hour_utc,
      COUNT(*) as cnt,
      ROUND(AVG(pnl_bps)::numeric, 1) as avg_pnl,
      COUNT(CASE WHEN exit_reason = 'trailing_stop' THEN 1 END) as trailing,
      COUNT(CASE WHEN exit_reason = 'bounce_fail' THEN 1 END) as bf
    FROM pca_signals
    WHERE created_at > '${sinceDate}' AND direction = 'short' AND resolved = true
    GROUP BY 1 ORDER BY 1
  `), 'HOURLY PATTERN (shorts, UTC)');

  // 7. Daily consistency
  table(await query(`
    SELECT date_trunc('day', created_at)::date as day,
      COUNT(*) as signals,
      ROUND(AVG(pnl_bps)::numeric, 1) as avg_pnl,
      ROUND(AVG(CASE WHEN pc1_return > 0.001 THEN pnl_bps END)::numeric, 1) as counter_pnl,
      ROUND(AVG(CASE WHEN pc1_return <= 0.001 THEN pnl_bps END)::numeric, 1) as with_pnl,
      COUNT(CASE WHEN exit_reason = 'trailing_stop' THEN 1 END) as trailing,
      COUNT(CASE WHEN exit_reason = 'bounce_fail' THEN 1 END) as bf
    FROM pca_signals
    WHERE created_at > '${sinceDate}' AND direction = 'short' AND resolved = true
    GROUP BY 1 ORDER BY 1
  `), 'DAILY CONSISTENCY (shorts)');

  // 8. Bounce fail shadow recovery
  table(await query(`
    SELECT
      CASE WHEN shadow_pnl_bps > 0 THEN 'recovered' ELSE 'stayed_negative' END as outcome,
      COUNT(*) as cnt,
      ROUND(AVG(shadow_pnl_bps)::numeric, 1) as avg_shadow_pnl,
      ROUND(AVG(pnl_bps)::numeric, 1) as avg_exit_pnl,
      ROUND(AVG(shadow_peak_pnl_bps)::numeric, 1) as avg_shadow_peak
    FROM pca_signals
    WHERE created_at > '${sinceDate}' AND direction = 'short' AND exit_reason = 'bounce_fail' AND shadow_exit_reason IS NOT NULL
    GROUP BY 1
  `), 'BOUNCE FAIL SHADOW RECOVERY');

  // 9. minPC1ReturnBps threshold simulation
  table(await query(`
    SELECT * FROM (
      SELECT 'no_filter' as filter, 0 as threshold_bps,
        COUNT(*) as cnt, ROUND(AVG(pnl_bps)::numeric, 1) as avg_pnl,
        ROUND(SUM(pnl_bps)::numeric, 0) as total_pnl,
        ROUND(AVG(residual_pnl_bps)::numeric, 1) as resid_pnl,
        ROUND(100.0 * COUNT(CASE WHEN exit_reason='trailing_stop' THEN 1 END)/COUNT(*)::numeric, 1) as ts_pct,
        ROUND(100.0 * COUNT(CASE WHEN exit_reason='bounce_fail' THEN 1 END)/COUNT(*)::numeric, 1) as bf_pct
      FROM pca_signals WHERE direction='short' AND resolved=true AND pc1_pnl_bps IS NOT NULL
        AND ((created_at >= '2026-02-09' AND created_at < '2026-02-14') OR created_at > '2026-03-05')
      UNION ALL
      SELECT 'pc1>' || t.bps || 'bps', t.bps,
        COUNT(*), ROUND(AVG(pnl_bps)::numeric, 1),
        ROUND(SUM(pnl_bps)::numeric, 0),
        ROUND(AVG(residual_pnl_bps)::numeric, 1),
        ROUND(100.0 * COUNT(CASE WHEN exit_reason='trailing_stop' THEN 1 END)/COUNT(*)::numeric, 1),
        ROUND(100.0 * COUNT(CASE WHEN exit_reason='bounce_fail' THEN 1 END)/COUNT(*)::numeric, 1)
      FROM pca_signals
      CROSS JOIN (VALUES (10),(25),(50),(75),(100)) t(bps)
      WHERE direction='short' AND resolved=true AND pc1_pnl_bps IS NOT NULL
        AND pc1_return * 10000 >= t.bps
        AND ((created_at >= '2026-02-09' AND created_at < '2026-02-14') OR created_at > '2026-03-05')
      GROUP BY t.bps
    ) sub ORDER BY threshold_bps
  `), 'SIMULATION: minPC1ReturnBps threshold sweep (all bounce_fail data)');

  // 10. Best threshold by period consistency
  table(await query(`
    SELECT
      CASE WHEN created_at < '2026-02-14' THEN 'feb9_14' ELSE 'post_mar5' END as period,
      CASE
        WHEN pc1_return * 10000 >= 50 THEN 'strong_counter(>=50bps)'
        WHEN pc1_return * 10000 >= 10 THEN 'weak_counter(10-50bps)'
        ELSE 'with_trend(<10bps)'
      END as bucket,
      COUNT(*) as cnt,
      ROUND(AVG(pnl_bps)::numeric, 1) as avg_pnl,
      ROUND(AVG(residual_pnl_bps)::numeric, 1) as resid_pnl,
      ROUND(100.0 * COUNT(CASE WHEN exit_reason='trailing_stop' THEN 1 END)/COUNT(*)::numeric, 1) as ts_pct
    FROM pca_signals
    WHERE direction='short' AND resolved=true AND pc1_pnl_bps IS NOT NULL
      AND ((created_at >= '2026-02-09' AND created_at < '2026-02-14') OR created_at > '2026-03-05')
    GROUP BY 1, 2 ORDER BY 1, 2
  `), 'SIMULATION: PC1 buckets by period (consistency check)');

  await pool.end();
  console.log('\nDone.');
}

run().catch(err => { console.error(err); process.exit(1); });
