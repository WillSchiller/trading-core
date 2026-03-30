const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const BASE_URL = 'https://public-api.birdeye.so';

if (!BIRDEYE_API_KEY) { console.error('Set BIRDEYE_API_KEY'); process.exit(1); }

const headers: Record<string, string> = { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana', 'Accept': 'application/json' };

async function fetchJson(url: string) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`${resp.status}: ${url} - ${body.slice(0, 200)}`);
  }
  return resp.json();
}

async function getGainersLosers(timeFrame: string, sortType: string, limit: number) {
  const data = await fetchJson(`${BASE_URL}/trader/gainers-losers?time_frame=${timeFrame}&sort_type=${sortType}&limit=${limit}`) as any;
  return data?.data?.items || [];
}

async function main() {
  console.log('=== Solana Memecoin Trader Edge Analysis ===\n');

  const periods = [
    { label: 'today', tf: 'today' },
    { label: 'yesterday', tf: 'yesterday' },
    { label: 'this_week', tf: 'this_week' },
  ];

  const allGainers: Record<string, any[]> = {};
  const allLosers: Record<string, any[]> = {};

  for (const p of periods) {
    console.log(`Fetching ${p.label} gainers...`);
    const gainers = await getGainersLosers(p.tf, 'desc', 10);
    allGainers[p.label] = gainers.filter((t: any) => t.trade_count >= 50);
    console.log(`  ${gainers.length} total, ${allGainers[p.label].length} with 50+ trades`);
    await new Promise(r => setTimeout(r, 2000));

    console.log(`Fetching ${p.label} losers...`);
    const losers = await getGainersLosers(p.tf, 'asc', 10);
    allLosers[p.label] = losers.filter((t: any) => t.trade_count >= 50);
    console.log(`  ${losers.length} total, ${allLosers[p.label].length} with 50+ trades`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // Persistence: do this_week winners appear in today's winners?
  const weekAddrs = new Set(allGainers['this_week'].map((t: any) => t.address));
  const yestAddrs = new Set(allGainers['yesterday'].map((t: any) => t.address));
  const todayTraders = allGainers['today'];

  const weekToToday = todayTraders.filter((t: any) => weekAddrs.has(t.address));
  const yestToToday = todayTraders.filter((t: any) => yestAddrs.has(t.address));

  console.log('\n=== PERSISTENCE CHECK ===');
  console.log(`This week winners also in today top: ${weekToToday.length}/${todayTraders.length}`);
  console.log(`Yesterday winners also in today top: ${yestToToday.length}/${todayTraders.length}`);

  // Cross-check: are week losers in today's losers?
  const weekLoserAddrs = new Set(allLosers['this_week'].map((t: any) => t.address));
  const todayLosers = allLosers['today'];
  const weekLoserToTodayLoser = todayLosers.filter((t: any) => weekLoserAddrs.has(t.address));
  console.log(`This week losers also in today losers: ${weekLoserToTodayLoser.length}/${todayLosers.length}`);

  // Show top traders
  for (const p of periods) {
    const data = allGainers[p.label];
    console.log(`\n=== TOP 10 GAINERS (${p.label}, 50+ trades) ===`);
    console.log('Address          PnL              Volume           Trades   PnL/Trade');
    console.log('-'.repeat(75));
    for (const t of data.slice(0, 10)) {
      const ppt = t.pnl / Math.max(t.trade_count, 1);
      console.log(
        `${t.address.slice(0, 8)}...  ` +
        `$${(t.pnl / 1000).toFixed(0).padStart(8)}k  ` +
        `$${(t.volume / 1000).toFixed(0).padStart(8)}k  ` +
        `${String(t.trade_count).padStart(8)}   ` +
        `$${ppt.toFixed(0).padStart(8)}`
      );
    }
  }

  // Losers
  console.log('\n=== TOP 10 LOSERS (this_week, 50+ trades) ===');
  console.log('Address          PnL              Volume           Trades   PnL/Trade');
  console.log('-'.repeat(75));
  for (const t of allLosers['this_week'].slice(0, 10)) {
    const ppt = t.pnl / Math.max(t.trade_count, 1);
    console.log(
      `${t.address.slice(0, 8)}...  ` +
      `$${(t.pnl / 1000).toFixed(0).padStart(8)}k  ` +
      `$${(t.volume / 1000).toFixed(0).padStart(8)}k  ` +
      `${String(t.trade_count).padStart(8)}   ` +
      `$${ppt.toFixed(0).padStart(8)}`
    );
  }

  // Edge distribution
  console.log('\n=== EDGE DISTRIBUTION (this_week) ===');
  const allWeek = [...allGainers['this_week'], ...allLosers['this_week']];
  const prof = allWeek.filter((t: any) => t.pnl > 0);
  const unprof = allWeek.filter((t: any) => t.pnl <= 0);
  console.log(`Sample: ${allWeek.length} traders (top 50 gainers + top 50 losers with 50+ trades)`);
  console.log(`Winners: ${prof.length}, Losers: ${unprof.length}`);
  console.log(`Avg winner PnL: $${(prof.reduce((s: number, t: any) => s + t.pnl, 0) / Math.max(prof.length, 1) / 1000).toFixed(0)}k`);
  console.log(`Avg loser PnL: $${(unprof.reduce((s: number, t: any) => s + t.pnl, 0) / Math.max(unprof.length, 1) / 1000).toFixed(0)}k`);

  const highFreq = allWeek.filter((t: any) => t.trade_count >= 500);
  const lowFreq = allWeek.filter((t: any) => t.trade_count < 500);
  console.log(`\nHigh freq (500+): ${highFreq.length} traders, ${highFreq.filter((t: any) => t.pnl > 0).length} profitable`);
  console.log(`Low freq (<500): ${lowFreq.length} traders, ${lowFreq.filter((t: any) => t.pnl > 0).length} profitable`);

  console.log('\n=== CONCLUSION ===');
  const persistenceRate = todayTraders.length > 0 ? weekToToday.length / todayTraders.length : 0;
  if (persistenceRate > 0.2) {
    console.log(`Persistence rate: ${(persistenceRate * 100).toFixed(0)}% — EDGE LIKELY EXISTS`);
    console.log('Week winners keep winning today → persistent skill, not luck');
  } else if (persistenceRate > 0.1) {
    console.log(`Persistence rate: ${(persistenceRate * 100).toFixed(0)}% — WEAK EDGE, might be noise`);
  } else {
    console.log(`Persistence rate: ${(persistenceRate * 100).toFixed(0)}% — NO EDGE, likely survivorship bias`);
  }
}

main().catch(console.error);
