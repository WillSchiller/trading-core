#!/usr/bin/env npx tsx
import pg from 'pg';

const connString = process.argv[2] || process.env.DATABASE_URL || `postgresql://${process.env.POSTGRES_USER || 'trader'}:${process.env.POSTGRES_PASSWORD || ''}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'dislocation_trader'}`;
const pool = new pg.Pool({ connectionString: connString, ssl: false });

async function query(sql: string) {
  const res = await pool.query(sql);
  return res.rows;
}

const DIRECTIONS = ['short', 'long'] as const;

const CORE_GATES: Record<string, string> = {
  short: `z_score BETWEEN 2.75 AND 3.0 AND pc1_return >= 0.0025 AND (market_context->>'funding')::float <= 0`,
  long: `z_score BETWEEN -3.0 AND -2.75 AND pc1_return <= -0.0025`,
};

interface Bucket { name: string; cond: string }

const VARIABLES: Record<string, Bucket[]> = {
  z_score: [
    { name: '2.0-2.5', cond: `ABS(z_score) BETWEEN 2.0 AND 2.5` },
    { name: '2.5-2.75', cond: `ABS(z_score) BETWEEN 2.5 AND 2.75` },
    { name: '2.75-3.0', cond: `ABS(z_score) BETWEEN 2.75 AND 3.0` },
    { name: '3.0-3.5', cond: `ABS(z_score) BETWEEN 3.0 AND 3.5` },
    { name: '3.5+', cond: `ABS(z_score) > 3.5` },
  ],
  pc1_return: [
    { name: '<-50bps', cond: `pc1_return < -0.005` },
    { name: '-50 to 0', cond: `pc1_return BETWEEN -0.005 AND 0` },
    { name: '0-25bps', cond: `pc1_return BETWEEN 0 AND 0.0025` },
    { name: '25-50bps', cond: `pc1_return BETWEEN 0.0025 AND 0.005` },
    { name: '50-100bps', cond: `pc1_return BETWEEN 0.005 AND 0.01` },
    { name: '100bps+', cond: `pc1_return > 0.01` },
  ],
  funding: [
    { name: '<-1bps', cond: `(market_context->>'funding')::float < -0.0001` },
    { name: '-1 to 0', cond: `(market_context->>'funding')::float BETWEEN -0.0001 AND 0` },
    { name: '0-1bps', cond: `(market_context->>'funding')::float BETWEEN 0 AND 0.0001` },
    { name: '>1bps', cond: `(market_context->>'funding')::float > 0.0001` },
  ],
  open_interest: [
    { name: '<1M', cond: `(market_context->>'openInterest')::float < 1000000` },
    { name: '1-10M', cond: `(market_context->>'openInterest')::float BETWEEN 1000000 AND 10000000` },
    { name: '10-100M', cond: `(market_context->>'openInterest')::float BETWEEN 10000000 AND 100000000` },
    { name: '>100M', cond: `(market_context->>'openInterest')::float > 100000000` },
  ],
  volume: [
    { name: '<100K', cond: `(market_context->>'dayNtlVlm')::float < 100000` },
    { name: '100K-1M', cond: `(market_context->>'dayNtlVlm')::float BETWEEN 100000 AND 1000000` },
    { name: '1-10M', cond: `(market_context->>'dayNtlVlm')::float BETWEEN 1000000 AND 10000000` },
    { name: '>10M', cond: `(market_context->>'dayNtlVlm')::float > 10000000` },
  ],
  hour_utc: [
    { name: '00-05', cond: `EXTRACT(HOUR FROM created_at) BETWEEN 0 AND 5` },
    { name: '06-11', cond: `EXTRACT(HOUR FROM created_at) BETWEEN 6 AND 11` },
    { name: '12-17', cond: `EXTRACT(HOUR FROM created_at) BETWEEN 12 AND 17` },
    { name: '18-23', cond: `EXTRACT(HOUR FROM created_at) BETWEEN 18 AND 23` },
  ],
  ewma_vol: [
    { name: '<50bps', cond: `ewma_vol_bps < 50` },
    { name: '50-100bps', cond: `ewma_vol_bps BETWEEN 50 AND 100` },
    { name: '100-200bps', cond: `ewma_vol_bps BETWEEN 100 AND 200` },
    { name: '>200bps', cond: `ewma_vol_bps > 200` },
  ],
  pc1_displacement: [
    { name: '<-200bps', cond: `pc1_displacement_bps < -200` },
    { name: '-200 to 0', cond: `pc1_displacement_bps BETWEEN -200 AND 0` },
    { name: '0-200bps', cond: `pc1_displacement_bps BETWEEN 0 AND 200` },
    { name: '>200bps', cond: `pc1_displacement_bps > 200` },
  ],
};

const STATS_SQL = (where: string) => `
  SELECT COUNT(*) as n,
    ROUND(AVG(pnl_bps)::numeric, 1) as avg_bps,
    ROUND(SUM(pnl_bps)::numeric, 0) as total_bps,
    ROUND(100.0 * SUM(CASE WHEN pnl_bps > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)::numeric, 1) as win_pct,
    ROUND(AVG(pc1_pnl_bps)::numeric, 1) as avg_pc1,
    ROUND(AVG(residual_pnl_bps)::numeric, 1) as avg_resid
  FROM pca_signals
  WHERE exit_reason IS NOT NULL AND ${where}
`;

function pad(s: string, len: number) { return s.padEnd(len); }
function rpad(s: string, len: number) { return s.padStart(len); }

function printRow(bucket: string, r: { n: string; avg_bps: string; total_bps: string; win_pct: string; avg_pc1: string; avg_resid: string }) {
  console.log(
    `  ${pad(bucket, 18)} ${rpad(r.n, 5)} ${rpad(r.avg_bps ?? '-', 8)} ${rpad(r.total_bps ?? '-', 8)} ${rpad(r.win_pct ? r.win_pct + '%' : '-', 7)} ${rpad(r.avg_pc1 ?? '-', 8)} ${rpad(r.avg_resid ?? '-', 8)}`
  );
}

async function sliceVariable(direction: string, varName: string, buckets: Bucket[], gates: string | null) {
  const label = gates ? `(conditioned)` : `(unconditioned)`;
  console.log(`\n  --- ${varName} ${label} ---`);
  console.log(`  ${pad('Bucket', 18)} ${rpad('n', 5)} ${rpad('avg_bps', 8)} ${rpad('tot_bps', 8)} ${rpad('win%', 7)} ${rpad('avg_pc1', 8)} ${rpad('avg_res', 8)}`);
  console.log(`  ${'-'.repeat(72)}`);

  for (const b of buckets) {
    const where = gates
      ? `direction = '${direction}' AND ${gates} AND ${b.cond}`
      : `direction = '${direction}' AND ${b.cond}`;
    const rows = await query(STATS_SQL(where));
    printRow(b.name, rows[0]);
  }
}

async function crossTab(direction: string, var1Name: string, var1Buckets: Bucket[], var2Name: string, var2Buckets: Bucket[]) {
  console.log(`\n  --- CROSS: ${var1Name} x ${var2Name} ---`);
  console.log(`  ${pad('Combo', 30)} ${rpad('n', 5)} ${rpad('avg_bps', 8)} ${rpad('win%', 7)}`);
  console.log(`  ${'-'.repeat(52)}`);

  for (const b1 of var1Buckets) {
    for (const b2 of var2Buckets) {
      const where = `direction = '${direction}' AND ${b1.cond} AND ${b2.cond}`;
      const rows = await query(STATS_SQL(where));
      if (Number(rows[0].n) >= 3) {
        const label = `${b1.name} | ${b2.name}`;
        console.log(`  ${pad(label, 30)} ${rpad(rows[0].n, 5)} ${rpad(rows[0].avg_bps ?? '-', 8)} ${rpad(rows[0].win_pct ? rows[0].win_pct + '%' : '-', 7)}`);
      }
    }
  }
}

async function topAssets(direction: string, gates: string | null) {
  const label = gates ? '(conditioned)' : '(unconditioned)';
  const where = gates
    ? `direction = '${direction}' AND exit_reason IS NOT NULL AND ${gates}`
    : `direction = '${direction}' AND exit_reason IS NOT NULL`;

  const rows = await query(`
    SELECT asset, COUNT(*) as n,
      ROUND(AVG(pnl_bps)::numeric, 1) as avg_bps,
      ROUND(SUM(pnl_bps)::numeric, 0) as total_bps,
      ROUND(100.0 * SUM(CASE WHEN pnl_bps > 0 THEN 1 ELSE 0 END) / COUNT(*)::numeric, 1) as win_pct
    FROM pca_signals WHERE ${where}
    GROUP BY asset HAVING COUNT(*) >= 3
    ORDER BY avg_bps DESC
  `);

  console.log(`\n  --- TOP/BOTTOM ASSETS ${label} ---`);
  console.log(`  ${pad('Asset', 12)} ${rpad('n', 5)} ${rpad('avg_bps', 8)} ${rpad('tot_bps', 8)} ${rpad('win%', 7)}`);
  console.log(`  ${'-'.repeat(42)}`);
  for (const r of rows.slice(0, 5)) {
    console.log(`  ${pad(r.asset, 12)} ${rpad(r.n, 5)} ${rpad(r.avg_bps, 8)} ${rpad(r.total_bps, 8)} ${rpad(r.win_pct + '%', 7)}`);
  }
  console.log(`  ...`);
  for (const r of rows.slice(-5)) {
    console.log(`  ${pad(r.asset, 12)} ${rpad(r.n, 5)} ${rpad(r.avg_bps, 8)} ${rpad(r.total_bps, 8)} ${rpad(r.win_pct + '%', 7)}`);
  }
}

async function run() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  PCA SIGNAL SLICER — ${new Date().toISOString().slice(0, 16)}`);
  console.log(`  Connected: ${connString.replace(/:[^:@]+@/, ':***@')}`);
  console.log('='.repeat(80));

  for (const dir of DIRECTIONS) {
    const gates = CORE_GATES[dir];
    const totalRows = await query(`SELECT COUNT(*) as n FROM pca_signals WHERE direction = '${dir}' AND exit_reason IS NOT NULL`);
    const gatedRows = gates ? await query(`SELECT COUNT(*) as n FROM pca_signals WHERE direction = '${dir}' AND exit_reason IS NOT NULL AND ${gates}`) : null;

    console.log(`\n${'#'.repeat(80)}`);
    console.log(`  DIRECTION: ${dir.toUpperCase()} — ${totalRows[0].n} total, ${gatedRows?.[0]?.n ?? '?'} gated`);
    console.log('#'.repeat(80));

    for (const [varName, buckets] of Object.entries(VARIABLES)) {
      await sliceVariable(dir, varName, buckets, null);
      if (gates) await sliceVariable(dir, varName, buckets, gates);
    }

    await topAssets(dir, null);
    if (gates) await topAssets(dir, gates);

    if (dir === 'short') {
      await crossTab(dir, 'funding', VARIABLES.funding, 'pc1_return', VARIABLES.pc1_return.slice(2));
      await crossTab(dir, 'open_interest', VARIABLES.open_interest, 'hour_utc', VARIABLES.hour_utc);
    }
  }

  await pool.end();
  console.log('\nDone.');
}

run().catch(err => { console.error(err); process.exit(1); });
