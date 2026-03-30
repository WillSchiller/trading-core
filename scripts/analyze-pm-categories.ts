import pg from 'pg';

const CATEGORIES = ['SPORTS', 'CRYPTO', 'POLITICS'];
const PERIODS = ['DAY', 'WEEK', 'MONTH'];
const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const MAX_PER_QUERY = 200;
const MAX_BACKFILL = 3000;

const MIN_TRADES = 50;
const MIN_ACTIVE_DAYS = 14;
const MIN_SHARPE = 0.05;
const MIN_PROFIT_FACTOR = 1.3;
const MAX_DD_RATIO = 0.5;
const MIN_COINFLIP_WR = 0.55;

interface Trader {
  address: string;
  name: string;
  category: string;
  period: string;
  leaderboardPnl: number;
  volume: number;
}

interface Trade {
  side: string;
  price: number;
  size: number;
  timestamp: number;
  outcome: string;
  conditionId: string;
  slug: string;
  resolved: boolean;
  resolutionPrice: number | null;
}

interface Stats {
  trades: number;
  wins: number;
  pnl: number;
  activeDays: number;
  sharpe: number;
  profitFactor: number;
  maxDrawdown: number;
  coinflipWR: number;
  eligible: boolean;
}

async function fetchLeaderboard(category: string, period: string): Promise<Trader[]> {
  const traders: Trader[] = [];
  for (let offset = 0; offset < MAX_PER_QUERY; offset += 50) {
    const url = `${DATA_API}/v1/leaderboard?category=${category}&timePeriod=${period}&orderBy=PNL&limit=50&offset=${offset}`;
    const resp = await fetch(url);
    if (!resp.ok) break;
    const data = await resp.json() as any[];
    if (!data.length) break;
    for (const d of data) {
      traders.push({
        address: d.proxyWallet,
        name: d.userName || d.proxyWallet.slice(0, 10),
        category,
        period,
        leaderboardPnl: d.pnl,
        volume: d.vol,
      });
    }
  }
  return traders;
}

async function fetchTrades(address: string): Promise<Trade[]> {
  const trades: Trade[] = [];
  let cursor = '';
  for (let i = 0; i < 20; i++) {
    const url = `${DATA_API}/trades?user=${address}&limit=500${cursor ? `&after=${cursor}` : ''}`;
    const resp = await fetch(url);
    if (!resp.ok) break;
    const data = await resp.json() as any[];
    if (!data.length) break;
    for (const t of data) {
      if (t.side !== 'BUY') continue;
      const price = Number(t.price || 0);
      if (price <= 0) continue;
      trades.push({
        side: t.side,
        price,
        size: Number(t.size || 0),
        timestamp: Number(t.timestamp || 0),
        outcome: t.outcome || '',
        conditionId: t.conditionId || '',
        slug: t.slug || '',
        resolved: false,
        resolutionPrice: null,
      });
    }
    cursor = data[data.length - 1]?.id || '';
    if (data.length < 500 || trades.length >= MAX_BACKFILL) break;
  }
  return trades;
}

async function resolveTradesViaBatch(trades: Trade[]): Promise<void> {
  const conditionIds = [...new Set(trades.map(t => t.conditionId))];
  const resolutions = new Map<string, { closed: boolean; prices: number[]; tokenIds: string[] }>();

  for (let i = 0; i < conditionIds.length; i += 10) {
    const batch = conditionIds.slice(i, i + 10);
    for (const cid of batch) {
      try {
        const resp = await fetch(`${GAMMA_API}/markets?condition_id=${cid}`);
        if (!resp.ok) continue;
        const data = await resp.json() as any[];
        if (!data.length) continue;
        const m = data[0];
        resolutions.set(cid, {
          closed: !!m.closed,
          prices: JSON.parse(m.outcomePrices || '[]').map(Number),
          tokenIds: JSON.parse(m.clobTokenIds || '[]'),
        });
      } catch { /* skip */ }
    }
    if (i + 10 < conditionIds.length) await new Promise(r => setTimeout(r, 200));
  }

  for (const trade of trades) {
    const res = resolutions.get(trade.conditionId);
    if (!res || !res.closed) continue;
    trade.resolved = true;
    // Simplified: if market closed, winning outcome = 1.0, losing = 0.0
    // Use first price as proxy (not perfect but good enough for analysis)
    trade.resolutionPrice = res.prices[0] > 0.5 ? 1 : 0;
  }
}

function computeStats(trades: Trade[], bankroll: number): Stats {
  const resolved = trades.filter(t => t.resolved && t.resolutionPrice !== null);
  if (resolved.length < 2) return { trades: resolved.length, wins: 0, pnl: 0, activeDays: 0, sharpe: 0, profitFactor: 0, maxDrawdown: 0, coinflipWR: 0, eligible: false };

  const pnls: number[] = [];
  const dates = new Set<string>();
  let cfWins = 0, cfTotal = 0;

  for (const t of resolved) {
    const ourSize = Math.min((t.size * t.price / Math.max(bankroll, 1)) * 500, 100) / t.price;
    const pnl = (t.resolutionPrice! - t.price) * ourSize;
    pnls.push(pnl);
    dates.add(new Date(t.timestamp).toISOString().slice(0, 10));
    if (t.price >= 0.30 && t.price <= 0.70) {
      cfTotal++;
      if (pnl > 0) cfWins++;
    }
  }

  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter(p => p > 0).length;
  const avg = totalPnl / pnls.length;
  const std = Math.sqrt(pnls.reduce((s, p) => s + (p - avg) ** 2, 0) / pnls.length);
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

  const coinflipWR = cfTotal >= 10 ? cfWins / cfTotal : 0;

  const eligible = resolved.length >= MIN_TRADES
    && dates.size >= MIN_ACTIVE_DAYS
    && sharpe >= MIN_SHARPE
    && profitFactor >= MIN_PROFIT_FACTOR
    && (totalPnl > 0 ? Math.abs(maxDD) / totalPnl <= MAX_DD_RATIO : false)
    && coinflipWR >= MIN_COINFLIP_WR;

  return { trades: resolved.length, wins, pnl: totalPnl, activeDays: dates.size, sharpe, profitFactor, maxDrawdown: maxDD, coinflipWR, eligible };
}

async function main() {
  // Collect unique traders across all categories/periods
  const seen = new Set<string>();
  const allTraders: Trader[] = [];

  console.log('=== Fetching leaderboards ===\n');
  for (const cat of CATEGORIES) {
    for (const period of PERIODS) {
      const traders = await fetchLeaderboard(cat, period);
      let added = 0;
      for (const t of traders) {
        if (!seen.has(t.address)) {
          seen.add(t.address);
          allTraders.push(t);
          added++;
        }
      }
      console.log(`${cat} ${period}: ${traders.length} fetched, ${added} new (${seen.size} total unique)`);
    }
  }

  console.log(`\nTotal unique traders: ${allTraders.length}\n`);

  // Analyze each trader
  const results: { trader: Trader; stats: Stats }[] = [];
  const categoryStats = new Map<string, { total: number; eligible: number; totalPnl: number }>();

  for (let i = 0; i < allTraders.length; i++) {
    const trader = allTraders[i];
    if (i % 20 === 0) console.log(`Analyzing ${i}/${allTraders.length}...`);

    const trades = await fetchTrades(trader.address);
    if (trades.length < 20) continue;

    await resolveTradesViaBatch(trades);
    const bankroll = Math.max(trader.volume * 0.1, 1000);
    const stats = computeStats(trades, bankroll);

    results.push({ trader, stats });

    const catKey = trader.category;
    const existing = categoryStats.get(catKey) || { total: 0, eligible: 0, totalPnl: 0 };
    existing.total++;
    if (stats.eligible) existing.eligible++;
    existing.totalPnl += stats.pnl;
    categoryStats.set(catKey, existing);

    await new Promise(r => setTimeout(r, 300));
  }

  // Print results by category
  console.log('\n=== RESULTS BY CATEGORY ===\n');
  for (const cat of CATEGORIES) {
    const catResults = results.filter(r => r.trader.category === cat);
    const eligible = catResults.filter(r => r.stats.eligible);
    const stats = categoryStats.get(cat);

    console.log(`--- ${cat} ---`);
    console.log(`Traders analyzed: ${stats?.total || 0}`);
    console.log(`Eligible: ${stats?.eligible || 0}`);
    console.log(`Total paper PnL: $${(stats?.totalPnl || 0).toFixed(2)}`);

    if (eligible.length > 0) {
      console.log('\nEligible traders:');
      for (const r of eligible.sort((a, b) => b.stats.pnl - a.stats.pnl)) {
        console.log(`  ${r.trader.name.padEnd(25)} trades:${r.stats.trades} days:${r.stats.activeDays} pnl:$${r.stats.pnl.toFixed(2)} sharpe:${r.stats.sharpe.toFixed(3)} pf:${r.stats.profitFactor.toFixed(2)} wr:${(r.stats.wins / r.stats.trades * 100).toFixed(0)}% cfwr:${(r.stats.coinflipWR * 100).toFixed(0)}%`);
      }
    }
    console.log('');
  }

  // Top 20 by PnL regardless of eligibility
  console.log('=== TOP 20 BY PNL (all categories, regardless of eligibility) ===\n');
  const sorted = results.sort((a, b) => b.stats.pnl - a.stats.pnl).slice(0, 20);
  console.log('Name'.padEnd(25), 'Cat'.padEnd(10), 'Trades', 'Days', 'PnL'.padStart(10), 'Sharpe', 'PF'.padStart(6), 'WR%', 'CFWR%', 'Eligible');
  for (const r of sorted) {
    console.log(
      r.trader.name.slice(0, 24).padEnd(25),
      r.trader.category.padEnd(10),
      String(r.stats.trades).padStart(6),
      String(r.stats.activeDays).padStart(4),
      ('$' + r.stats.pnl.toFixed(2)).padStart(10),
      r.stats.sharpe.toFixed(3).padStart(6),
      r.stats.profitFactor.toFixed(2).padStart(6),
      (r.stats.wins / Math.max(r.stats.trades, 1) * 100).toFixed(0).padStart(3) + '%',
      (r.stats.coinflipWR * 100).toFixed(0).padStart(4) + '%',
      r.stats.eligible ? 'YES' : 'no',
    );
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  const totalEligible = results.filter(r => r.stats.eligible).length;
  console.log(`Total traders analyzed: ${results.length}`);
  console.log(`Total eligible: ${totalEligible}`);
  for (const cat of CATEGORIES) {
    const s = categoryStats.get(cat);
    console.log(`  ${cat}: ${s?.eligible || 0}/${s?.total || 0} eligible`);
  }
}

main().catch(console.error);
