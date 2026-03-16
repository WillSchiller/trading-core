#!/usr/bin/env npx tsx
import pg from 'pg';
import { loadPolymarketConfig } from '../src/polymarket/config.js';
import { PolymarketPersistence } from '../src/polymarket/persistence.js';
import { TraderBackfill } from '../src/polymarket/backfill.js';

const connString = process.argv[2] || 'postgresql://trader@localhost:5432/dislocation_trader';
const pool = new pg.Pool({ connectionString: connString, ssl: false });

async function run() {
  const config = loadPolymarketConfig();
  const persistence = new PolymarketPersistence(pool);
  const backfill = new TraderBackfill(config, persistence, pool);

  const result = await pool.query(
    `SELECT address, alias, bankroll_estimate::float as bankroll FROM pm_tracked_traders WHERE enabled = true ORDER BY rank ASC`,
  );

  console.log(`Found ${result.rows.length} active traders to backfill`);

  let totalSaved = 0;
  for (const row of result.rows) {
    const already = await backfill.isTraderBackfilled(row.address);
    if (already) {
      console.log(`  ${row.alias} (${row.address.slice(0, 10)}...): already backfilled, skipping`);
      continue;
    }

    try {
      const saved = await backfill.backfillTrader(row.address, row.alias, row.bankroll || 10000);
      console.log(`  ${row.alias}: ${saved} trades backfilled`);
      totalSaved += saved;
    } catch (err) {
      console.error(`  ${row.alias}: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. Total trades backfilled: ${totalSaved}`);
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
