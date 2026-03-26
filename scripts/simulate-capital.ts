import pg from 'pg';

const DB = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 15432),
  database: process.env.POSTGRES_DB || 'dislocation_trader',
  user: process.env.POSTGRES_USER || 'trader',
  password: process.env.POSTGRES_PASSWORD || '',
};

interface Trade {
  traderAddress: string;
  pnl: number;
  shadowCost: number; // our_size * our_entry_price in shadow
  buyTs: number;
  resolveTs: number;
}

interface SimConfig {
  name: string;
  bankroll: number;
  maxPosition: number;
  minPF: number;
  recencyWindow: number;
  recencyMinPF: number;
  recencyMinWR: number;
}

const CONFIGS: SimConfig[] = [
  // Scale test: how does bankroll affect APY?
  { name: '$100, $10pos, PF>2',          bankroll: 100,   maxPosition: 10,  minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$500, $25pos, PF>2',          bankroll: 500,   maxPosition: 25,  minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$1k, $25pos, PF>2',           bankroll: 1000,  maxPosition: 25,  minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$5k, $50pos, PF>2',           bankroll: 5000,  maxPosition: 50,  minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$10k, $100pos, PF>2',         bankroll: 10000, maxPosition: 100, minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$50k, $500pos, PF>2',         bankroll: 50000, maxPosition: 500, minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  // Best combos at $1k
  { name: '$1k, $25pos, PF>3',           bankroll: 1000,  maxPosition: 25,  minPF: 3.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$1k, $10pos, PF>2',           bankroll: 1000,  maxPosition: 10,  minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$1k, $10pos, PF>3',           bankroll: 1000,  maxPosition: 10,  minPF: 3.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$1k, $10pos, loose',          bankroll: 1000,  maxPosition: 10,  minPF: 1.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  // Small positions on bigger bankroll
  { name: '$500, $10pos, PF>2',          bankroll: 500,   maxPosition: 10,  minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$1k, $10pos, PF>2 (dup)',     bankroll: 1000,  maxPosition: 10,  minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$5k, $10pos, PF>2',          bankroll: 5000,  maxPosition: 10,  minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$500, $10pos, PF>3',          bankroll: 500,   maxPosition: 10,  minPF: 3.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  { name: '$500, $5pos, PF>2',           bankroll: 500,   maxPosition: 5,   minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
  // Unlimited (what backtest was doing)
  { name: '$1M, $100pos, PF>2',          bankroll: 1000000, maxPosition: 100, minPF: 2.0, recencyWindow: 20, recencyMinPF: 0.8, recencyMinWR: 0.40 },
];

function simulate(trades: Trade[], trainerPFs: Map<string, number>, cfg: SimConfig) {
  const eligible = new Set<string>();
  for (const [addr, pf] of trainerPFs) {
    if (pf >= cfg.minPF) eligible.add(addr);
  }

  const traderHistory = new Map<string, number[]>();
  let cash = cfg.bankroll;
  const positions: Array<{ cost: number; pnl: number; resolveTs: number }> = [];
  let totalPnl = 0;
  let tradeCount = 0;
  let wins = 0;
  let skipped = 0;
  let equity = cfg.bankroll;
  let peak = cfg.bankroll;
  let maxDD = 0;

  for (const trade of trades) {
    // Resolve positions
    for (let i = positions.length - 1; i >= 0; i--) {
      if (positions[i].resolveTs <= trade.buyTs) {
        const pos = positions.splice(i, 1)[0];
        const returned = pos.cost + pos.pnl;
        cash += Math.max(0, returned); // can't go below 0 on a position
        totalPnl += pos.pnl;
        if (pos.pnl > 0) wins++;
        tradeCount++;

        equity = cash + positions.reduce((s, p) => s + p.cost + p.pnl, 0);
        if (equity > peak) peak = equity;
        if (equity - peak < maxDD) maxDD = equity - peak;
      }
    }

    if (!eligible.has(trade.traderAddress)) continue;

    // Recency
    if (cfg.recencyWindow > 0) {
      const history = traderHistory.get(trade.traderAddress) || [];
      traderHistory.set(trade.traderAddress, history);

      if (history.length >= cfg.recencyWindow) {
        const recent = history.slice(-cfg.recencyWindow);
        const w = recent.filter(p => p > 0).length;
        const wr = w / recent.length;
        const gw = recent.filter(p => p > 0).reduce((a, b) => a + b, 0);
        const gl = Math.abs(recent.filter(p => p < 0).reduce((a, b) => a + b, 0));
        const pf = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
        if (pf < cfg.recencyMinPF || wr < cfg.recencyMinWR) {
          history.push(trade.pnl > 0 ? 1 : -1);
          continue;
        }
      }
      history.push(trade.pnl > 0 ? 1 : -1);
    }

    const posSize = Math.min(cfg.maxPosition, cash);
    if (posSize < 1) { skipped++; continue; }

    // Scale PnL: shadow trade had cost=shadowCost, we're betting posSize
    const scale = trade.shadowCost > 0 ? posSize / trade.shadowCost : 1;
    const scaledPnl = trade.pnl * scale;
    // Cap loss at position size
    const cappedPnl = Math.max(scaledPnl, -posSize);

    cash -= posSize;
    positions.push({ cost: posSize, pnl: cappedPnl, resolveTs: trade.resolveTs });
  }

  // Resolve remaining
  for (const pos of positions) {
    totalPnl += pos.pnl;
    if (pos.pnl > 0) wins++;
    tradeCount++;
    equity = cash + pos.cost + pos.pnl;
    if (equity > peak) peak = equity;
    if (equity - peak < maxDD) maxDD = equity - peak;
  }

  return { totalPnl, trades: tradeCount, wins, skipped, maxDD };
}

async function main() {
  const pool = new pg.Pool(DB);

  console.log('Loading trades...');
  const { rows } = await pool.query(`
    SELECT s.trader_address as "traderAddress",
      s.pnl_if_copied::float as pnl,
      (s.our_size * s.our_entry_price)::float as "shadowCost",
      s.trader_timestamp as "buyTs",
      (EXTRACT(EPOCH FROM s.resolved_at) * 1000)::bigint as "resolveTs"
    FROM pm_shadow_trades s
    JOIN pm_tracked_traders t ON s.trader_address = t.address
    WHERE s.resolved = true AND s.side = 'BUY' AND s.our_entry_price > 0
      AND s.resolved_at IS NOT NULL AND t.copy_eligible = true
    ORDER BY s.trader_timestamp
  `);

  console.log(`Loaded ${rows.length} trades\n`);

  // Split 50/50 train/test per trader
  const byTrader = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byTrader.get(r.traderAddress) || [];
    list.push(r);
    byTrader.set(r.traderAddress, list);
  }

  const trainerPFs = new Map<string, number>();
  let testTrades: Trade[] = [];

  for (const [addr, trades] of byTrader) {
    const splitIdx = Math.floor(trades.length * 0.5);
    const train = trades.slice(0, splitIdx);
    const test = trades.slice(splitIdx);
    if (train.length < 10) continue;

    const pnls = train.map(t => t.pnl);
    const gw = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const gl = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
    trainerPFs.set(addr, gl > 0 ? gw / gl : gw > 0 ? 99 : 0);

    for (const t of test) {
      if (t.resolveTs && t.resolveTs > 0 && t.shadowCost > 0) {
        testTrades.push(t as Trade);
      }
    }
  }

  testTrades.sort((a, b) => a.buyTs - b.buyTs);
  const totalDays = testTrades.length > 1
    ? (testTrades[testTrades.length - 1].buyTs - testTrades[0].buyTs) / (1000 * 60 * 60 * 24)
    : 1;

  console.log(`Test: ${testTrades.length} trades over ${totalDays.toFixed(0)} days`);
  console.log(`Traders: ${trainerPFs.size}\n`);

  console.log(
    'Config'.padEnd(32),
    'Trades'.padStart(7),
    'Wins'.padStart(6),
    'WR%'.padStart(6),
    'PnL'.padStart(10),
    '$/trade'.padStart(8),
    '$/day'.padStart(8),
    'APY%'.padStart(8),
    'MaxDD'.padStart(8),
    'Skip'.padStart(7),
    'Skip%'.padStart(6),
  );
  console.log('-'.repeat(120));

  for (const cfg of CONFIGS) {
    const r = simulate(testTrades, trainerPFs, cfg);
    const dailyPnl = totalDays > 0 ? r.totalPnl / totalDays : 0;
    const apy = (dailyPnl / cfg.bankroll) * 365 * 100;
    const totalPossible = r.trades + r.skipped;
    const skipPct = totalPossible > 0 ? (r.skipped / totalPossible * 100) : 0;
    const wr = r.trades > 0 ? (r.wins / r.trades * 100) : 0;

    console.log(
      cfg.name.padEnd(32),
      String(r.trades).padStart(7),
      String(r.wins).padStart(6),
      wr.toFixed(1).padStart(6),
      ('$' + r.totalPnl.toFixed(0)).padStart(10),
      ('$' + (r.trades > 0 ? r.totalPnl / r.trades : 0).toFixed(2)).padStart(8),
      ('$' + dailyPnl.toFixed(2)).padStart(8),
      (apy.toFixed(0) + '%').padStart(8),
      ('$' + r.maxDD.toFixed(0)).padStart(8),
      String(r.skipped).padStart(7),
      (skipPct.toFixed(0) + '%').padStart(6),
    );
  }

  await pool.end();
}

main().catch(console.error);
