#!/usr/bin/env npx tsx
import pg from 'pg';

const connString = process.argv[2] || process.env.DATABASE_URL || `postgresql://${process.env.POSTGRES_USER || 'trader'}:${process.env.POSTGRES_PASSWORD || ''}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'dislocation_trader'}`;
const pool = new pg.Pool({ connectionString: connString, ssl: false, max: 1 });

const ASSETS = [
  'BTC','ETH','SOL','HYPE','XRP','BNB','SUI','DOGE','LTC','kPEPE',
  'BCH','LINK','TAO','ADA','AAVE','CRV','ENA','JUP','AVAX','ARB',
  'TRUMP','PENGU','UNI','XLM','NEAR','VIRTUAL','kSHIB','TRX','kBONK','S',
  'WIF','INJ','ICP','PENDLE','IP','ONDO','HBAR','APT','TON','OP',
  'ETHFI','DOT','KAITO','POL','STRK','SEI','AR','MORPHO','LDO','TIA',
  'PYTH','ZK','EIGEN','RENDER','POPCAT','ATOM','MNT','STX','MOODENG','JTO',
  'FIL','OM','SAND','WLD','RUNE','FET','ETC','ALGO','IMX','GALA',
  'ENS','DYDX','COMP','GMX','SNX','RSR','MKR','CAKE','PEOPLE','FXS',
  'SUPER','BADGER','NEO','SUSHI','ORDI','MEME','BLUR','NTRN','MANTA','UMA',
  'MAV','ZETA','DYM','W','BOME','TNSR','SAGA','TURBO','NOT','BRETT','IO','BLAST',
];

interface FundingEntry {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

async function getLatestTimestamp(asset: string): Promise<number | null> {
  const res = await pool.query('SELECT MAX(timestamp) as max_ts FROM hl_funding_history WHERE asset = $1', [asset]);
  return res.rows[0]?.max_ts ? parseInt(res.rows[0].max_ts) : null;
}

async function fetchFunding(asset: string, startTime: number, endTime: number): Promise<FundingEntry[]> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'fundingHistory', coin: asset, startTime, endTime }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function insertFunding(asset: string, entries: FundingEntry[]): Promise<number> {
  if (entries.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let idx = 1;

  for (const entry of entries) {
    placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++})`);
    values.push(asset, entry.time, parseFloat(entry.fundingRate), parseFloat(entry.premium));
  }

  const res = await pool.query(
    `INSERT INTO hl_funding_history (asset, timestamp, funding_rate, premium)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT DO NOTHING`,
    values
  );
  return res.rowCount ?? 0;
}

async function run() {
  const createSQL = (await import('fs')).readFileSync('sql/034_hl_funding_history.sql', 'utf-8');
  await pool.query(createSQL);

  const daysBack = parseInt(process.argv[3] || '30', 10);
  const now = Date.now();
  let totalInserted = 0;

  console.log(`Archiving ${daysBack} days of funding for ${ASSETS.length} assets...`);

  for (const asset of ASSETS) {
    try {
      const latest = await getLatestTimestamp(asset);
      let startTime = latest ? latest + 1 : now - daysBack * 86400000;
      let assetTotal = 0;
      let firstDate = '';

      while (startTime < now) {
        const entries = await fetchFunding(asset, startTime, now);
        if (entries.length === 0) break;

        const inserted = await insertFunding(asset, entries);
        assetTotal += inserted;
        if (!firstDate) firstDate = new Date(entries[0].time).toISOString().slice(0, 10);
        startTime = entries[entries.length - 1].time + 1;

        await new Promise(r => setTimeout(r, 200));
        if (entries.length < 500) break;
      }

      if (assetTotal > 0) {
        const lastDate = new Date(startTime).toISOString().slice(0, 10);
        console.log(`  ${asset}: ${assetTotal} entries (${firstDate} → ${lastDate})`);
      }

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`  ${asset}: ERROR — ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. ${totalInserted} funding entries archived.`);
  await pool.end();
}

run().catch(console.error);
