#!/usr/bin/env npx tsx
import pg from 'pg';

const connString = process.argv[2] || 'postgresql://trader@localhost:5432/dislocation_trader';
const pool = new pg.Pool({ connectionString: connString, ssl: false });

async function fetchFunding(coin: string, startTime: number, endTime: number) {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'fundingHistory', coin, startTime, endTime }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json() as Promise<Array<{ coin: string; fundingRate: string; premium: string; time: number }>>;
}

async function run() {
  const signals = await pool.query(`
    SELECT DISTINCT asset, MIN(timestamp) as min_ts, MAX(timestamp) as max_ts
    FROM pca_signals
    WHERE direction = 'short' AND resolved = true AND market_context IS NULL
    GROUP BY asset
  `);

  if (signals.rows.length === 0) {
    console.log('No signals missing market context.');
    await pool.end();
    return;
  }

  console.log(`${signals.rows.length} assets need funding backfill`);

  let updated = 0;
  for (const { asset, min_ts, max_ts } of signals.rows) {
    const startTime = Number(min_ts) - 3600000;
    const endTime = Number(max_ts) + 3600000;

    try {
      const funding = await fetchFunding(asset, startTime, endTime);
      if (funding.length === 0) {
        console.log(`  ${asset}: no funding data`);
        continue;
      }

      const assetSignals = await pool.query(
        `SELECT id, timestamp FROM pca_signals
         WHERE asset = $1 AND direction = 'short' AND resolved = true AND market_context IS NULL`,
        [asset]
      );

      for (const sig of assetSignals.rows) {
        const ts = Number(sig.timestamp);
        let closest = funding[0];
        for (const f of funding) {
          if (Math.abs(f.time - ts) < Math.abs(closest.time - ts)) closest = f;
        }

        await pool.query(
          `UPDATE pca_signals SET market_context = $1 WHERE id = $2`,
          [JSON.stringify({
            funding: parseFloat(closest.fundingRate),
            premium: parseFloat(closest.premium),
            oraclePx: 0, markPx: 0, openInterest: 0, dayNtlVlm: 0,
          }), sig.id]
        );
        updated++;
      }

      console.log(`  ${asset}: ${assetSignals.rows.length} signals backfilled from ${funding.length} funding records`);
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`  ${asset}: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. Updated ${updated} signals.`);
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
