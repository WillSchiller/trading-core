#!/usr/bin/env npx tsx
import pg from 'pg';

const connString = process.argv[2] || process.env.DATABASE_URL || `postgresql://${process.env.POSTGRES_USER || 'trader'}:${process.env.POSTGRES_PASSWORD || ''}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'dislocation_trader'}`;
const pool = new pg.Pool({ connectionString: connString, ssl: false, max: 1 });

interface FundingRow {
  asset: string;
  timestamp: string;
  funding_rate: string;
}

interface CandleRow {
  asset: string;
  timestamp: string;
  close: string;
}

interface Trade {
  asset: string;
  direction: 'short' | 'long';
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  pnlBps: number;
  fundingRate8h: number;
  exitReason: string;
  holdMin: number;
}

async function run() {
  // Load all funding data
  console.log('Loading funding data...');
  const fundingRes = await pool.query<FundingRow>(
    `SELECT asset, timestamp, funding_rate FROM hl_funding_history ORDER BY asset, timestamp`
  );

  // Group by asset
  const fundingByAsset = new Map<string, Array<{ ts: number; rate: number }>>();
  for (const row of fundingRes.rows) {
    const arr = fundingByAsset.get(row.asset) || [];
    arr.push({ ts: parseInt(row.timestamp), rate: parseFloat(row.funding_rate) });
    fundingByAsset.set(row.asset, arr);
  }
  console.log(`  ${fundingByAsset.size} assets, ${fundingRes.rows.length} funding entries`);

  // Load candle data for price lookups
  console.log('Loading candle data...');
  const candleRes = await pool.query<CandleRow>(
    `SELECT asset, timestamp, close FROM hl_candles ORDER BY asset, timestamp`
  );
  const pricesByAsset = new Map<string, Array<{ ts: number; price: number }>>();
  for (const row of candleRes.rows) {
    const arr = pricesByAsset.get(row.asset) || [];
    arr.push({ ts: parseInt(row.timestamp), price: parseFloat(row.close) });
    pricesByAsset.set(row.asset, arr);
  }
  console.log(`  ${pricesByAsset.size} assets, ${candleRes.rows.length} candle entries`);

  // Also load pca_signals prices for assets/times not in candles
  console.log('Loading PCA signal prices for price reference...');
  const priceRes = await pool.query(
    `SELECT asset, timestamp, entry_price FROM pca_signals WHERE entry_price IS NOT NULL ORDER BY asset, timestamp`
  );
  const signalPrices = new Map<string, Array<{ ts: number; price: number }>>();
  for (const row of priceRes.rows) {
    const arr = signalPrices.get(row.asset) || [];
    arr.push({ ts: parseInt(row.timestamp), price: parseFloat(row.entry_price) });
    signalPrices.set(row.asset, arr);
  }

  function getPrice(asset: string, ts: number): number | null {
    // Try candles first (1m resolution)
    const candles = pricesByAsset.get(asset);
    if (candles && candles.length > 0) {
      // Binary search for closest candle
      let lo = 0, hi = candles.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candles[mid].ts < ts) lo = mid + 1;
        else hi = mid;
      }
      const c = candles[lo];
      if (Math.abs(c.ts - ts) < 600000) return c.price; // within 10 min
    }
    // Fallback to signal prices
    const sigs = signalPrices.get(asset);
    if (sigs && sigs.length > 0) {
      let closest = sigs[0];
      let minDist = Math.abs(sigs[0].ts - ts);
      for (const s of sigs) {
        const dist = Math.abs(s.ts - ts);
        if (dist < minDist) { minDist = dist; closest = s; }
      }
      if (minDist < 3600000) return closest.price; // within 1 hour
    }
    return null;
  }

  // Strategy params — calibrated to HL funding distribution
  // Positive funding is rare (0.04% >0.5bps), negative is common (8.2% >0.5bps)
  // Use asymmetric thresholds
  const thresholds = [
    { name: 'neg >3bps (tail)', shortThresh: 0.0005, longThresh: -0.0003 },
    { name: 'neg >1bps (common)', shortThresh: 0.0003, longThresh: -0.0001 },
    { name: 'neg >0.5bps (broad)', shortThresh: 0.0001, longThresh: -0.00005 },
  ];
  const holdPeriods = [1, 2, 4, 8]; // hours

  for (const { name, shortThresh, longThresh } of thresholds) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Strategy: ${name}`);
    console.log(`${'='.repeat(60)}`);

    for (const holdHours of holdPeriods) {
      const trades: Trade[] = [];

      for (const [asset, funding] of fundingByAsset) {
        for (let i = 0; i < funding.length; i++) {
          const f = funding[i];

          // Check if funding exceeds threshold
          let direction: 'short' | 'long' | null = null;
          if (f.rate >= shortThresh) direction = 'short'; // crowded longs, fade
          else if (f.rate <= longThresh) direction = 'long'; // crowded shorts, fade

          if (!direction) continue;

          const entryTime = f.ts;
          const exitTime = entryTime + holdHours * 3600000;

          const entryPrice = getPrice(asset, entryTime);
          const exitPrice = getPrice(asset, exitTime);

          if (!entryPrice || !exitPrice) continue;

          const rawPnl = (exitPrice - entryPrice) / entryPrice;
          const pnlBps = direction === 'short' ? -rawPnl * 10000 : rawPnl * 10000;

          trades.push({
            asset,
            direction,
            entryTime,
            entryPrice,
            exitTime,
            exitPrice,
            pnlBps,
            fundingRate8h: f.rate * 10000,
            exitReason: 'time_stop',
            holdMin: holdHours * 60,
          });

          // Skip overlapping signals for same asset
          const skipTo = funding.findIndex((ff, j) => j > i && ff.ts >= exitTime);
          if (skipTo > 0) i = skipTo - 1;
        }
      }

      if (trades.length === 0) {
        console.log(`  Hold ${holdHours}h: no trades`);
        continue;
      }

      const shorts = trades.filter(t => t.direction === 'short');
      const longs = trades.filter(t => t.direction === 'long');
      const wins = trades.filter(t => t.pnlBps > 0);
      const avgBps = trades.reduce((s, t) => s + t.pnlBps, 0) / trades.length;
      const totalBps = trades.reduce((s, t) => s + t.pnlBps, 0);

      console.log(`  Hold ${holdHours}h: n=${trades.length} (${shorts.length}S/${longs.length}L) | avg=${avgBps.toFixed(1)}bps | total=${totalBps.toFixed(0)}bps | win=${(100*wins.length/trades.length).toFixed(1)}%`);

      if (shorts.length > 0) {
        const sAvg = shorts.reduce((s, t) => s + t.pnlBps, 0) / shorts.length;
        const sWin = shorts.filter(t => t.pnlBps > 0).length;
        console.log(`    Shorts: n=${shorts.length} | avg=${sAvg.toFixed(1)}bps | win=${(100*sWin/shorts.length).toFixed(1)}%`);
      }
      if (longs.length > 0) {
        const lAvg = longs.reduce((s, t) => s + t.pnlBps, 0) / longs.length;
        const lWin = longs.filter(t => t.pnlBps > 0).length;
        console.log(`    Longs:  n=${longs.length} | avg=${lAvg.toFixed(1)}bps | win=${(100*lWin/longs.length).toFixed(1)}%`);
      }

      // Top/bottom assets
      const byAsset = new Map<string, number[]>();
      for (const t of trades) {
        const arr = byAsset.get(t.asset) || [];
        arr.push(t.pnlBps);
        byAsset.set(t.asset, arr);
      }
      const assetPerf = [...byAsset.entries()]
        .filter(([, pnls]) => pnls.length >= 3)
        .map(([asset, pnls]) => ({ asset, n: pnls.length, avg: pnls.reduce((a, b) => a + b, 0) / pnls.length }))
        .sort((a, b) => b.avg - a.avg);

      if (assetPerf.length > 0) {
        const top3 = assetPerf.slice(0, 3).map(a => `${a.asset}(+${a.avg.toFixed(0)},n=${a.n})`).join(' ');
        const bot3 = assetPerf.slice(-3).map(a => `${a.asset}(${a.avg.toFixed(0)},n=${a.n})`).join(' ');
        console.log(`    Best:  ${top3}`);
        console.log(`    Worst: ${bot3}`);
      }
    }
  }

  await pool.end();
}

run().catch(console.error);
