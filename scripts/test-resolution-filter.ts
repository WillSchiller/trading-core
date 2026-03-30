import pg from 'pg';

const DB = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 15432),
  database: process.env.POSTGRES_DB || 'dislocation_trader',
  user: process.env.POSTGRES_USER || 'trader',
  password: process.env.POSTGRES_PASSWORD || '',
};

async function main() {
  const pool = new pg.Pool(DB);

  // Get all resolved shadow trades with market end dates from gamma
  // We'll use resolution time as proxy for market duration
  const { rows } = await pool.query(`
    SELECT s.trader_address, s.trader_alias, s.pnl_if_copied::float as pnl,
      s.our_entry_price::float as entry,
      s.trader_timestamp as buy_ts,
      EXTRACT(EPOCH FROM s.resolved_at) * 1000 as resolve_ts,
      t.category, t.copy_eligible
    FROM pm_shadow_trades s
    JOIN pm_tracked_traders t ON s.trader_address = t.address
    WHERE s.resolved = true AND s.side = 'BUY' AND s.our_entry_price > 0
      AND s.resolved_at IS NOT NULL
    ORDER BY s.trader_timestamp
  `);

  console.log(`Loaded ${rows.length} resolved trades with timestamps\n`);

  // Compute hold duration and bucket
  interface Trade { pnl: number; holdHours: number; category: string; eligible: boolean }
  const trades: Trade[] = [];

  for (const r of rows) {
    const holdMs = r.resolve_ts - r.buy_ts;
    if (holdMs <= 0) continue;
    const holdHours = holdMs / (1000 * 60 * 60);
    trades.push({ pnl: r.pnl, holdHours, category: r.category, eligible: r.copy_eligible });
  }

  const BUCKETS = [
    { name: '< 6 hours', max: 6 },
    { name: '6h - 1 day', max: 24 },
    { name: '1 - 3 days', max: 72 },
    { name: '3 - 7 days', max: 168 },
    { name: '7 - 14 days', max: 336 },
    { name: '14 - 30 days', max: 720 },
    { name: '30+ days', max: Infinity },
  ];

  // All trades
  console.log('=== ALL TRADES BY HOLD DURATION ===');
  console.log('Bucket'.padEnd(15), 'Trades'.padStart(8), 'Wins'.padStart(6), 'WR%'.padStart(6), 'PnL'.padStart(12), 'AvgPnL'.padStart(8), 'PF'.padStart(6));
  console.log('-'.repeat(70));

  let prevMax = 0;
  for (const b of BUCKETS) {
    const bucket = trades.filter(t => t.holdHours >= prevMax && t.holdHours < b.max);
    if (bucket.length === 0) { prevMax = b.max; continue; }
    const wins = bucket.filter(t => t.pnl > 0).length;
    const total = bucket.reduce((a, t) => a + t.pnl, 0);
    const gw = bucket.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const gl = Math.abs(bucket.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : 99;
    console.log(
      b.name.padEnd(15),
      String(bucket.length).padStart(8),
      String(wins).padStart(6),
      (wins / bucket.length * 100).toFixed(1).padStart(6),
      ('$' + total.toFixed(0)).padStart(12),
      total.toFixed(2).padStart(8) ? ('$' + (total / bucket.length).toFixed(2)).padStart(8) : '',
      pf.toFixed(2).padStart(6),
    );
    prevMax = b.max;
  }

  // Eligible only
  const eligibleTrades = trades.filter(t => t.eligible);
  console.log('\n=== ELIGIBLE TRADERS ONLY ===');
  console.log('Bucket'.padEnd(15), 'Trades'.padStart(8), 'Wins'.padStart(6), 'WR%'.padStart(6), 'PnL'.padStart(12), 'AvgPnL'.padStart(8), 'PF'.padStart(6));
  console.log('-'.repeat(70));

  prevMax = 0;
  for (const b of BUCKETS) {
    const bucket = eligibleTrades.filter(t => t.holdHours >= prevMax && t.holdHours < b.max);
    if (bucket.length === 0) { prevMax = b.max; continue; }
    const wins = bucket.filter(t => t.pnl > 0).length;
    const total = bucket.reduce((a, t) => a + t.pnl, 0);
    const gw = bucket.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const gl = Math.abs(bucket.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : 99;
    console.log(
      b.name.padEnd(15),
      String(bucket.length).padStart(8),
      String(wins).padStart(6),
      (wins / bucket.length * 100).toFixed(1).padStart(6),
      ('$' + total.toFixed(0)).padStart(12),
      ('$' + (total / bucket.length).toFixed(2)).padStart(8),
      pf.toFixed(2).padStart(6),
    );
    prevMax = b.max;
  }

  // Simulate: what if we only took trades that resolve within X days?
  console.log('\n=== SIMULATED PnL BY MAX HOLD CUTOFF (eligible only) ===');
  console.log('Max Hold'.padEnd(15), 'Trades'.padStart(8), 'PnL'.padStart(12), 'WR%'.padStart(6), 'PF'.padStart(6), '% of trades'.padStart(12));

  const totalEligible = eligibleTrades.length;
  for (const maxDays of [1, 3, 7, 14, 30, 9999]) {
    const maxHours = maxDays * 24;
    const filtered = eligibleTrades.filter(t => t.holdHours <= maxHours);
    if (filtered.length === 0) continue;
    const wins = filtered.filter(t => t.pnl > 0).length;
    const total = filtered.reduce((a, t) => a + t.pnl, 0);
    const gw = filtered.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const gl = Math.abs(filtered.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : 99;
    console.log(
      (maxDays >= 9999 ? 'No limit' : maxDays + ' days').padEnd(15),
      String(filtered.length).padStart(8),
      ('$' + total.toFixed(0)).padStart(12),
      (wins / filtered.length * 100).toFixed(1).padStart(6),
      pf.toFixed(2).padStart(6),
      ((filtered.length / totalEligible * 100).toFixed(0) + '%').padStart(12),
    );
  }

  // By category
  for (const cat of ['SPORTS', 'CRYPTO', 'POLITICS']) {
    const catTrades = eligibleTrades.filter(t => t.category === cat);
    if (catTrades.length < 10) continue;
    console.log(`\n=== ${cat} — MAX HOLD CUTOFF ===`);
    console.log('Max Hold'.padEnd(15), 'Trades'.padStart(8), 'PnL'.padStart(12), 'WR%'.padStart(6), 'PF'.padStart(6));
    for (const maxDays of [1, 3, 7, 14, 30, 9999]) {
      const maxHours = maxDays * 24;
      const filtered = catTrades.filter(t => t.holdHours <= maxHours);
      if (filtered.length === 0) continue;
      const wins = filtered.filter(t => t.pnl > 0).length;
      const total = filtered.reduce((a, t) => a + t.pnl, 0);
      const gw = filtered.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
      const gl = Math.abs(filtered.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
      const pf = gl > 0 ? gw / gl : 99;
      console.log(
        (maxDays >= 9999 ? 'No limit' : maxDays + ' days').padEnd(15),
        String(filtered.length).padStart(8),
        ('$' + total.toFixed(0)).padStart(12),
        (wins / filtered.length * 100).toFixed(1).padStart(6),
        pf.toFixed(2).padStart(6),
      );
    }
  }

  await pool.end();
}

main().catch(console.error);
