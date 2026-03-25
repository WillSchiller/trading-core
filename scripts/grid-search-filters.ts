import pg from 'pg';

const DB = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'dislocation_trader',
  user: process.env.POSTGRES_USER || 'trader',
  password: process.env.POSTGRES_PASSWORD || 'devpassword',
};

interface Trade {
  traderAddress: string;
  traderAlias: string;
  category: string;
  pnl: number;
  entryPrice: number;
  timestamp: number;
  date: string;
}

interface TraderStats {
  trades: number;
  wins: number;
  pnl: number;
  activeDays: number;
  sharpe: number;
  profitFactor: number;
  maxDdRatio: number;
  coinflipWR: number;
}

interface FilterConfig {
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

interface Result {
  config: FilterConfig;
  category: string;
  traders: number;
  testTrades: number;
  testPnl: number;
  testWinRate: number;
  testPF: number;
  testAvgPnl: number;
  testMaxDD: number;
}

function computeStats(pnls: number[], entryPrices: number[], dates: Set<string>): TraderStats {
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
  for (const p of pnls) {
    equity += p;
    if (equity > peak) peak = equity;
    if (equity - peak < maxDD) maxDD = equity - peak;
  }
  const maxDdRatio = totalPnl > 0 ? Math.abs(maxDD) / totalPnl : 1;

  let cfWins = 0, cfTotal = 0;
  for (let i = 0; i < n; i++) {
    if (entryPrices[i] >= 0.30 && entryPrices[i] <= 0.70) {
      cfTotal++;
      if (pnls[i] > 0) cfWins++;
    }
  }

  return {
    trades: n, wins, pnl: totalPnl, activeDays: dates.size, sharpe, profitFactor,
    maxDdRatio, coinflipWR: cfTotal >= 10 ? cfWins / cfTotal : 0,
  };
}

function passesLifetime(stats: TraderStats, cfg: FilterConfig): boolean {
  return stats.trades >= cfg.minTrades
    && stats.sharpe >= cfg.minSharpe
    && stats.profitFactor >= cfg.minPF
    && stats.coinflipWR >= cfg.minCoinflipWR
    && stats.maxDdRatio <= cfg.maxDdRatio
    && stats.activeDays >= cfg.minActiveDays;
}

function passesRecency(pnls: number[], cfg: FilterConfig): boolean {
  if (cfg.recencyWindow <= 0) return true;
  const recent = pnls.slice(-cfg.recencyWindow);
  if (recent.length < cfg.recencyWindow) return false;
  const wins = recent.filter(p => p > 0).length;
  const wr = wins / recent.length;
  const grossWins = recent.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(recent.filter(p => p < 0).reduce((a, b) => a + b, 0));
  const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 0;
  return pf >= cfg.recencyMinPF && wr >= cfg.recencyMinWR;
}

async function main() {
  const pool = new pg.Pool(DB);

  console.log('Loading shadow trades from DB...');
  const { rows } = await pool.query(`
    SELECT s.trader_address as "traderAddress", s.trader_alias as "traderAlias",
      COALESCE(t.category, 'UNKNOWN') as category,
      s.pnl_if_copied::float as pnl, s.our_entry_price::float as "entryPrice",
      s.trader_timestamp as timestamp,
      to_char(to_timestamp(s.trader_timestamp/1000), 'YYYY-MM-DD') as date
    FROM pm_shadow_trades s
    JOIN pm_tracked_traders t ON s.trader_address = t.address
    WHERE s.resolved = true AND s.side = 'BUY' AND s.our_entry_price > 0
    ORDER BY s.trader_timestamp
  `);
  console.log(`Loaded ${rows.length} resolved trades`);

  const trades = rows as Trade[];

  // Group by trader
  const byTrader = new Map<string, Trade[]>();
  for (const t of trades) {
    const list = byTrader.get(t.traderAddress) || [];
    list.push(t);
    byTrader.set(t.traderAddress, list);
  }
  // Filter to traders with >= 20 trades to reduce noise
  for (const [addr, tt] of byTrader) {
    if (tt.length < 20) byTrader.delete(addr);
  }
  console.log(`${byTrader.size} traders (with 20+ trades)\n`);

  // Pre-compute: split into train/test AND compute train stats + recency for each trader
  interface TraderPrecompute {
    address: string;
    category: string;
    trainStats: TraderStats;
    trainPnls: number[];
    testPnls: number[];
  }

  const precomputed: TraderPrecompute[] = [];

  for (const [addr, traderTrades] of byTrader) {
    const splitIdx = Math.floor(traderTrades.length * 0.7);
    const train = traderTrades.slice(0, splitIdx);
    const test = traderTrades.slice(splitIdx);
    if (train.length < 10 || test.length < 3) continue;

    const pnls = train.map(t => t.pnl);
    const entries = train.map(t => t.entryPrice);
    const dates = new Set(train.map(t => t.date));
    const stats = computeStats(pnls, entries, dates);

    precomputed.push({
      address: addr,
      category: traderTrades[0].category,
      trainStats: stats,
      trainPnls: pnls,
      testPnls: test.map(t => t.pnl),
    });
  }
  console.log(`Pre-computed ${precomputed.length} traders\n`);

  // Two-pass: fix lifetime to known-good values, vary recency
  const LIFETIME = {
    minTrades: [20, 50],
    minSharpe: [0.01, 0.05],
    minPF: [1.0, 1.3],
    minCoinflipWR: [0.50, 0.55],
    maxDdRatio: [0.3, 0.5, 0.7],
    minActiveDays: [7, 14],
  };

  const RECENCY = {
    recencyWindow: [0, 20, 30, 50, 100],
    recencyMinPF: [0.7, 0.8, 0.9, 1.0],
    recencyMinWR: [0.40, 0.45, 0.50],
  };

  const CATEGORIES = ['ALL', 'SPORTS', 'CRYPTO', 'POLITICS'];
  const results: Result[] = [];
  let combos = 0;

  for (const category of CATEGORIES) {
    for (const minTrades of LIFETIME.minTrades) {
      for (const minSharpe of LIFETIME.minSharpe) {
        for (const minPF of LIFETIME.minPF) {
          for (const minCoinflipWR of LIFETIME.minCoinflipWR) {
            for (const maxDdRatio of LIFETIME.maxDdRatio) {
              for (const minActiveDays of LIFETIME.minActiveDays) {
                for (const recencyWindow of RECENCY.recencyWindow) {
                  for (const recencyMinPF of RECENCY.recencyMinPF) {
                    for (const recencyMinWR of RECENCY.recencyMinWR) {
                      combos++;
                      const cfg: FilterConfig = { minTrades, minSharpe, minPF, minCoinflipWR, maxDdRatio, minActiveDays, recencyWindow, recencyMinPF, recencyMinWR };

                      let testPnls: number[] = [];
                      let eligibleTraders = 0;

                      if (recencyWindow === 0) {
                        // No recency — static filter, use all test trades
                        for (const tc of precomputed) {
                          if (category !== 'ALL' && tc.category !== category) continue;
                          if (!passesLifetime(tc.trainStats, cfg)) continue;
                          eligibleTraders++;
                          for (const p of tc.testPnls) testPnls.push(p);
                        }
                      } else {
                        // Dynamic recency — walk forward through test trades
                        // Trader starts with their train pnls as history, then each test trade appends
                        // Re-check recency before each test trade
                        for (const tc of precomputed) {
                          if (category !== 'ALL' && tc.category !== category) continue;
                          if (!passesLifetime(tc.trainStats, cfg)) continue;

                          const runningPnls = [...tc.trainPnls];
                          let contributed = false;

                          for (const p of tc.testPnls) {
                            // Check recency on current running history
                            const recent = runningPnls.slice(-recencyWindow);
                            if (recent.length >= recencyWindow) {
                              const wins = recent.filter(x => x > 0).length;
                              const wr = wins / recent.length;
                              const gw = recent.filter(x => x > 0).reduce((a, b) => a + b, 0);
                              const gl = Math.abs(recent.filter(x => x < 0).reduce((a, b) => a + b, 0));
                              const pf = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;

                              if (pf < recencyMinPF || wr < recencyMinWR) {
                                // Trader disabled — skip this trade but keep updating history
                                runningPnls.push(p);
                                continue;
                              }
                            }
                            // Trader passes — take the trade
                            testPnls.push(p);
                            contributed = true;
                            runningPnls.push(p);
                          }
                          if (contributed) eligibleTraders++;
                        }
                      }

                      if (eligibleTraders === 0 || testPnls.length < 10) continue;

                      const testTotal = testPnls.reduce((a, b) => a + b, 0);
                      const testWins = testPnls.filter(p => p > 0).length;
                      const testGrossWins = testPnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
                      const testGrossLosses = Math.abs(testPnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
                      const testPF = testGrossLosses > 0 ? testGrossWins / testGrossLosses : 99;

                      let eq = 0, pk = 0, dd = 0;
                      for (const p of testPnls) { eq += p; if (eq > pk) pk = eq; if (eq - pk < dd) dd = eq - pk; }

                      results.push({
                        config: cfg, category, traders: eligibleTraders,
                        testTrades: testPnls.length, testPnl: testTotal,
                        testWinRate: testWins / testPnls.length,
                        testPF, testAvgPnl: testTotal / testPnls.length,
                        testMaxDD: dd,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  console.log(`Evaluated ${combos} combos, ${results.length} with enough data\n`);

  // Find max test trades per category (baseline — loosest possible)
  const maxTestTrades = new Map<string, number>();
  for (const category of CATEGORIES) {
    const maxResult = results.filter(r => r.category === category).reduce((a, b) => a.testTrades > b.testTrades ? a : b, { testTrades: 0 } as Result);
    maxTestTrades.set(category, maxResult.testTrades);
  }

  // Top 10 by test PnL per category
  for (const category of CATEGORIES) {
    const catResults = results.filter(r => r.category === category && r.testPnl > 0);
    catResults.sort((a, b) => b.testPnl - a.testPnl);
    const top = catResults.slice(0, 10);

    if (top.length === 0) {
      console.log(`=== ${category}: No profitable configs ===\n`);
      continue;
    }

    console.log(`=== ${category} — TOP 10 BY TEST PNL ===`);
    const maxN = maxTestTrades.get(category) || 1;
    console.log('Rank  Traders  TestN  Take%  TestPnl    WR%   PF    AvgPnl  MaxDD    | minT  Shp   PF    cfWR  ddR   days  recW  rPF   rWR');
    console.log('-'.repeat(140));

    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const c = r.config;
      const takeRate = ((r.testTrades / maxN) * 100).toFixed(0);
      console.log(
        `${String(i + 1).padStart(2)})  ` +
        `${String(r.traders).padStart(5)}  ` +
        `${String(r.testTrades).padStart(5)}  ` +
        `${takeRate.padStart(4)}%  ` +
        `$${r.testPnl.toFixed(0).padStart(7)}  ` +
        `${(r.testWinRate * 100).toFixed(1).padStart(5)}  ` +
        `${r.testPF.toFixed(2).padStart(5)}  ` +
        `${r.testAvgPnl.toFixed(2).padStart(6)}  ` +
        `$${r.testMaxDD.toFixed(0).padStart(6)}  ` +
        `|  ${String(c.minTrades).padStart(3)}  ` +
        `${c.minSharpe.toFixed(2).padStart(4)}  ` +
        `${c.minPF.toFixed(1).padStart(4)}  ` +
        `${c.minCoinflipWR.toFixed(2).padStart(4)}  ` +
        `${c.maxDdRatio.toFixed(1).padStart(4)}  ` +
        `${String(c.minActiveDays).padStart(3)}  ` +
        `${String(c.recencyWindow).padStart(4)}  ` +
        `${c.recencyMinPF.toFixed(1).padStart(4)}  ` +
        `${c.recencyMinWR.toFixed(2).padStart(4)}`
      );
    }
    console.log('');
  }

  // Best overall by Sharpe-like metric (PnL / |maxDD|)
  console.log('=== BEST RISK-ADJUSTED (PnL / |MaxDD|) PER CATEGORY ===\n');
  for (const category of CATEGORIES) {
    const catResults = results.filter(r => r.category === category && r.testPnl > 0 && r.testMaxDD < -10);
    catResults.sort((a, b) => (b.testPnl / Math.abs(b.testMaxDD)) - (a.testPnl / Math.abs(a.testMaxDD)));
    const best = catResults[0];
    if (!best) { console.log(`${category}: No qualifying configs\n`); continue; }
    const c = best.config;
    console.log(`${category}:`);
    console.log(`  PnL/DD ratio: ${(best.testPnl / Math.abs(best.testMaxDD)).toFixed(2)}`);
    console.log(`  Test PnL: $${best.testPnl.toFixed(2)}, MaxDD: $${best.testMaxDD.toFixed(2)}, WR: ${(best.testWinRate * 100).toFixed(1)}%, PF: ${best.testPF.toFixed(2)}`);
    console.log(`  Traders: ${best.traders}, Test trades: ${best.testTrades}`);
    console.log(`  Config: minTrades=${c.minTrades} sharpe=${c.minSharpe} pf=${c.minPF} cfwr=${c.minCoinflipWR} dd=${c.maxDdRatio} days=${c.minActiveDays}`);
    console.log(`  Recency: window=${c.recencyWindow} minPF=${c.recencyMinPF} minWR=${c.recencyMinWR}`);
    console.log('');
  }

  // Current config comparison
  console.log('=== CURRENT CONFIG PERFORMANCE ===\n');
  const currentCfg: FilterConfig = {
    minTrades: 50, minSharpe: 0.05, minPF: 1.3, minCoinflipWR: 0.55,
    maxDdRatio: 0.5, minActiveDays: 14, recencyWindow: 0, recencyMinPF: 1.0, recencyMinWR: 0.50,
  };
  for (const category of CATEGORIES) {
    const match = results.find(r => r.category === category &&
      r.config.minTrades === currentCfg.minTrades && r.config.minSharpe === currentCfg.minSharpe &&
      r.config.minPF === currentCfg.minPF && r.config.minCoinflipWR === currentCfg.minCoinflipWR &&
      r.config.maxDdRatio === currentCfg.maxDdRatio && r.config.minActiveDays === currentCfg.minActiveDays &&
      r.config.recencyWindow === currentCfg.recencyWindow);
    if (match) {
      console.log(`${category}: PnL=$${match.testPnl.toFixed(2)} WR=${(match.testWinRate * 100).toFixed(1)}% PF=${match.testPF.toFixed(2)} Traders=${match.traders} Trades=${match.testTrades} DD=$${match.testMaxDD.toFixed(2)}`);
    } else {
      console.log(`${category}: No results (filters too tight)`);
    }
  }

  await pool.end();
}

main().catch(console.error);
