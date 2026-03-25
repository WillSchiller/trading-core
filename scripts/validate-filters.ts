import pg from 'pg';

const DB = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 15432),
  database: process.env.POSTGRES_DB || 'dislocation_trader',
  user: process.env.POSTGRES_USER || 'trader',
  password: process.env.POSTGRES_PASSWORD || '',
};

interface FilterConfig {
  name: string;
  minTrades: number;
  minSharpe: number;
  minPF: number;
  minCoinflipWR: number;
  maxDdRatio: number;
  minActiveDays: number;
  recencyWindow: number;
  recencyMinPF: number;
  recencyMinWR: number;
}

const V1: FilterConfig = {
  name: 'v1 (current)',
  minTrades: 50, minSharpe: 0.05, minPF: 1.3, minCoinflipWR: 0.55,
  maxDdRatio: 0.5, minActiveDays: 14, recencyWindow: 0, recencyMinPF: 1.0, recencyMinWR: 0.50,
};

const V2: FilterConfig = {
  name: 'v2 (optimized)',
  minTrades: 20, minSharpe: 0.01, minPF: 1.0, minCoinflipWR: 0.50,
  maxDdRatio: 0.7, minActiveDays: 7, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40,
};

function computeStats(pnls: number[], entryPrices: number[], dates: Set<string>) {
  const n = pnls.length;
  if (n < 2) return { trades: n, wins: 0, pnl: 0, activeDays: 0, sharpe: 0, profitFactor: 0, maxDdRatio: 1, coinflipWR: 0 };

  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter(p => p > 0).length;
  const avg = totalPnl / n;
  const std = Math.sqrt(pnls.reduce((s, p) => s + (p - avg) ** 2, 0) / n);
  const sharpe = std > 0 ? avg / std : 0;
  const grossWins = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 0;

  let equity = 0, peak = 0, maxDD = 0;
  for (const p of pnls) { equity += p; if (equity > peak) peak = equity; if (equity - peak < maxDD) maxDD = equity - peak; }

  let cfWins = 0, cfTotal = 0;
  for (let i = 0; i < n; i++) {
    if (entryPrices[i] >= 0.30 && entryPrices[i] <= 0.70) { cfTotal++; if (pnls[i] > 0) cfWins++; }
  }

  return { trades: n, wins, pnl: totalPnl, activeDays: dates.size, sharpe, profitFactor, maxDdRatio: totalPnl > 0 ? Math.abs(maxDD) / totalPnl : 1, coinflipWR: cfTotal >= 10 ? cfWins / cfTotal : 0 };
}

function passesLifetime(stats: ReturnType<typeof computeStats>, cfg: FilterConfig) {
  return stats.trades >= cfg.minTrades && stats.sharpe >= cfg.minSharpe && stats.profitFactor >= cfg.minPF
    && stats.coinflipWR >= cfg.minCoinflipWR && stats.maxDdRatio <= cfg.maxDdRatio && stats.activeDays >= cfg.minActiveDays;
}

function simulate(traders: Map<string, { trainPnls: number[]; trainEntries: number[]; trainDates: Set<string>; testPnls: number[]; category: string }>, cfg: FilterConfig, category: string) {
  let testPnls: number[] = [];
  let eligible = 0;
  let skippedByRecency = 0;

  for (const [, tc] of traders) {
    if (category !== 'ALL' && tc.category !== category) continue;
    const stats = computeStats(tc.trainPnls, tc.trainEntries, tc.trainDates);
    if (!passesLifetime(stats, cfg)) continue;

    if (cfg.recencyWindow === 0) {
      eligible++;
      testPnls.push(...tc.testPnls);
    } else {
      const running = [...tc.trainPnls];
      let contributed = false;
      let skipped = 0;

      for (const p of tc.testPnls) {
        const recent = running.slice(-cfg.recencyWindow);
        if (recent.length >= cfg.recencyWindow) {
          const wins = recent.filter(x => x > 0).length;
          const wr = wins / recent.length;
          const gw = recent.filter(x => x > 0).reduce((a, b) => a + b, 0);
          const gl = Math.abs(recent.filter(x => x < 0).reduce((a, b) => a + b, 0));
          const pf = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
          if (pf < cfg.recencyMinPF || wr < cfg.recencyMinWR) {
            running.push(p);
            skipped++;
            continue;
          }
        }
        testPnls.push(p);
        contributed = true;
        running.push(p);
      }
      if (contributed) eligible++;
      skippedByRecency += skipped;
    }
  }

  const total = testPnls.reduce((a, b) => a + b, 0);
  const wins = testPnls.filter(p => p > 0).length;
  const gw = testPnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(testPnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
  const pf = gl > 0 ? gw / gl : 99;
  let eq = 0, pk = 0, dd = 0;
  for (const p of testPnls) { eq += p; if (eq > pk) pk = eq; if (eq - pk < dd) dd = eq - pk; }

  return { trades: testPnls.length, eligible, total, wins, winRate: testPnls.length > 0 ? wins / testPnls.length : 0, pf, dd, skippedByRecency };
}

async function main() {
  const pool = new pg.Pool(DB);

  console.log('Loading shadow trades...');
  const { rows } = await pool.query(`
    SELECT s.trader_address, COALESCE(t.category, 'UNKNOWN') as category,
      s.pnl_if_copied::float as pnl, s.our_entry_price::float as entry,
      to_char(to_timestamp(s.trader_timestamp/1000), 'YYYY-MM-DD') as date
    FROM pm_shadow_trades s
    JOIN pm_tracked_traders t ON s.trader_address = t.address
    WHERE s.resolved = true AND s.side = 'BUY' AND s.our_entry_price > 0
    ORDER BY s.trader_timestamp
  `);

  // Group by trader
  const byTrader = new Map<string, { pnls: number[]; entries: number[]; dates: string[]; category: string }>();
  for (const r of rows) {
    let t = byTrader.get(r.trader_address);
    if (!t) { t = { pnls: [], entries: [], dates: [], category: r.category }; byTrader.set(r.trader_address, t); }
    t.pnls.push(r.pnl);
    t.entries.push(r.entry);
    t.dates.push(r.date);
  }

  // THREE-WAY SPLIT: 50% train, 25% validation, 25% test
  const prepared = new Map<string, { trainPnls: number[]; trainEntries: number[]; trainDates: Set<string>; testPnls: number[]; category: string }>();
  const preparedTest = new Map<string, { trainPnls: number[]; trainEntries: number[]; trainDates: Set<string>; testPnls: number[]; category: string }>();

  let totalTrain = 0, totalVal = 0, totalTest = 0;

  for (const [addr, t] of byTrader) {
    if (t.pnls.length < 20) continue;
    const n = t.pnls.length;
    const trainEnd = Math.floor(n * 0.50);
    const valEnd = Math.floor(n * 0.75);

    const trainPnls = t.pnls.slice(0, trainEnd);
    const trainEntries = t.entries.slice(0, trainEnd);
    const trainDates = new Set(t.dates.slice(0, trainEnd));
    const valPnls = t.pnls.slice(trainEnd, valEnd);
    const testPnls = t.pnls.slice(valEnd);

    if (trainPnls.length < 10) continue;

    // For validation: train on first 50%, test on next 25%
    prepared.set(addr, { trainPnls, trainEntries, trainDates, testPnls: valPnls, category: t.category });
    // For test: train on first 75%, test on last 25%
    const fullTrainPnls = t.pnls.slice(0, valEnd);
    const fullTrainEntries = t.entries.slice(0, valEnd);
    const fullTrainDates = new Set(t.dates.slice(0, valEnd));
    preparedTest.set(addr, { trainPnls: fullTrainPnls, trainEntries: fullTrainEntries, trainDates: fullTrainDates, testPnls, category: t.category });

    totalTrain += trainEnd;
    totalVal += valEnd - trainEnd;
    totalTest += n - valEnd;
  }

  console.log(`Traders: ${prepared.size}`);
  console.log(`Split: ${totalTrain} train / ${totalVal} validation / ${totalTest} test\n`);

  const CATEGORIES = ['ALL', 'SPORTS', 'CRYPTO', 'POLITICS'];

  console.log('='.repeat(100));
  console.log('VALIDATION SET (used to pick params — in-sample)');
  console.log('='.repeat(100));
  for (const cat of CATEGORIES) {
    console.log(`\n--- ${cat} ---`);
    for (const cfg of [V1, V2]) {
      const r = simulate(prepared, cfg, cat);
      console.log(`${cfg.name.padEnd(20)} Traders:${String(r.eligible).padStart(4)}  Trades:${String(r.trades).padStart(6)}  PnL:$${r.total.toFixed(0).padStart(7)}  WR:${(r.winRate * 100).toFixed(1).padStart(5)}%  PF:${r.pf.toFixed(2).padStart(5)}  DD:$${r.dd.toFixed(0).padStart(6)}  Skipped:${r.skippedByRecency}`);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('TEST SET (held-out — out-of-sample, never used for tuning)');
  console.log('='.repeat(100));
  for (const cat of CATEGORIES) {
    console.log(`\n--- ${cat} ---`);
    for (const cfg of [V1, V2]) {
      const r = simulate(preparedTest, cfg, cat);
      console.log(`${cfg.name.padEnd(20)} Traders:${String(r.eligible).padStart(4)}  Trades:${String(r.trades).padStart(6)}  PnL:$${r.total.toFixed(0).padStart(7)}  WR:${(r.winRate * 100).toFixed(1).padStart(5)}%  PF:${r.pf.toFixed(2).padStart(5)}  DD:$${r.dd.toFixed(0).padStart(6)}  Skipped:${r.skippedByRecency}`);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('DELTA (v2 - v1)');
  console.log('='.repeat(100));
  for (const cat of CATEGORIES) {
    const v1 = simulate(preparedTest, V1, cat);
    const v2 = simulate(preparedTest, V2, cat);
    const pnlDelta = v2.total - v1.total;
    const ddDelta = v2.dd - v1.dd;
    console.log(`${cat.padEnd(10)} PnL: ${pnlDelta > 0 ? '+' : ''}$${pnlDelta.toFixed(0)}  DD: ${ddDelta > 0 ? '+' : ''}$${ddDelta.toFixed(0)}  Trades: ${v2.trades - v1.trades > 0 ? '+' : ''}${v2.trades - v1.trades}  WR: ${((v2.winRate - v1.winRate) * 100).toFixed(1)}pp`);
  }

  await pool.end();
}

main().catch(console.error);
