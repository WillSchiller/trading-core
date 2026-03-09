#!/usr/bin/env npx tsx
import pg from 'pg';

const connString = process.argv[2] || process.env.DATABASE_URL || `postgresql://${process.env.POSTGRES_USER || 'trader'}:${process.env.POSTGRES_PASSWORD || ''}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'dislocation_trader'}`;
const pool = new pg.Pool({ connectionString: connString, ssl: false });

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

interface Candle {
  t: number; T: number;
  o: string; h: string; l: string; c: string;
  v: string; n: number; i: string; s: string;
}

async function fetchCandles(coin: string, startTime: number, endTime: number): Promise<Candle[]> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1m', startTime, endTime } }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json() as Promise<Candle[]>;
}

async function getLatestTimestamp(asset: string): Promise<number | null> {
  const res = await pool.query('SELECT MAX(timestamp) as max_ts FROM hl_candles WHERE asset = $1', [asset]);
  return res.rows[0]?.max_ts ?? null;
}

async function insertCandles(asset: string, candles: Candle[]) {
  if (candles.length === 0) return 0;
  const values: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;

  for (const c of candles) {
    values.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7})`);
    params.push(c.t, asset, c.o, c.h, c.l, c.c, c.v, c.n);
    idx += 8;
  }

  await pool.query(`
    INSERT INTO hl_candles (timestamp, asset, open, high, low, close, volume, trade_count)
    VALUES ${values.join(',')}
    ON CONFLICT (asset, timestamp) DO NOTHING
  `, params);

  return candles.length;
}

async function run() {
  // Ensure table exists
  const createSQL = await import('fs').then(fs => fs.readFileSync('sql/032_hl_candles.sql', 'utf-8'));
  await pool.query(createSQL);

  const hoursBack = parseInt(process.argv[3] || '24', 10);
  const now = Date.now();
  let totalInserted = 0;

  console.log(`Archiving ${hoursBack}h of 1m candles for ${ASSETS.length} assets...`);

  for (const asset of ASSETS) {
    try {
      const latest = await getLatestTimestamp(asset);
      const startTime = latest ? latest + 60000 : now - hoursBack * 3600000;
      const endTime = now;

      if (startTime >= endTime) {
        continue;
      }

      const candles = await fetchCandles(asset, startTime, endTime);
      if (candles.length > 0) {
        const inserted = await insertCandles(asset, candles);
        totalInserted += inserted;
        console.log(`  ${asset}: ${inserted} candles (${new Date(candles[0].t).toISOString().slice(0,16)} → ${new Date(candles[candles.length-1].t).toISOString().slice(0,16)})`);
      }

      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.error(`  ${asset}: ERROR — ${(err as Error).message}`);
    }
  }

  console.log(`\nDone. ${totalInserted} candles archived.`);
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
