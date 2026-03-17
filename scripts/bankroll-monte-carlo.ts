import pg from 'pg';

const BANKROLL = 500;
const N_PATHS = 10_000;
const N_TRADES = 200;

async function main() {
  const connStr = process.argv[2] || 'postgresql://trader:trader@localhost:5432/dislocation_trader';
  const pool = new pg.Pool({ connectionString: connStr });

  const result = await pool.query(`
    SELECT pnl_if_copied::float as pnl
    FROM pm_shadow_trades s
    JOIN pm_tracked_traders t ON s.trader_address = t.address AND t.copy_eligible = true
    WHERE s.resolved = true AND s.side = 'BUY' AND s.our_entry_price > 0
    ORDER BY trader_timestamp
  `);

  const historicalPnls = result.rows.map((r: { pnl: number }) => r.pnl);
  await pool.end();

  if (historicalPnls.length < 10) {
    console.error('Not enough resolved trades to simulate');
    process.exit(1);
  }

  console.log(`\n=== Bankroll Monte Carlo Simulation ===`);
  console.log(`Historical trades: ${historicalPnls.length}`);
  console.log(`Bankroll: $${BANKROLL}`);
  console.log(`Simulating: ${N_TRADES} trades x ${N_PATHS.toLocaleString()} paths`);
  console.log(`Method: Bootstrap resampling from actual trade PnLs\n`);

  const wins = historicalPnls.filter(p => p > 0);
  const losses = historicalPnls.filter(p => p <= 0);
  const winRate = wins.length / historicalPnls.length;
  const avgWin = wins.reduce((s, v) => s + v, 0) / wins.length;
  const avgLoss = losses.reduce((s, v) => s + v, 0) / losses.length;

  console.log(`Win rate: ${(winRate * 100).toFixed(1)}%`);
  console.log(`Avg win:  $${avgWin.toFixed(2)}`);
  console.log(`Avg loss: $${avgLoss.toFixed(2)}`);
  console.log(`Expected per trade: $${(winRate * avgWin + (1 - winRate) * avgLoss).toFixed(2)}\n`);

  const finalEquities: number[] = [];
  const maxDrawdowns: number[] = [];
  let ruinCount = 0;
  let negativeCount = 0;
  const equityAt50: number[] = [];
  const equityAt100: number[] = [];

  for (let path = 0; path < N_PATHS; path++) {
    let equity = BANKROLL;
    let peak = equity;
    let maxDD = 0;

    for (let t = 0; t < N_TRADES; t++) {
      const idx = Math.floor(Math.random() * historicalPnls.length);
      const pnl = historicalPnls[idx];

      equity += pnl;

      if (equity > peak) peak = equity;
      const dd = equity - peak;
      if (dd < maxDD) maxDD = dd;

      if (equity <= 0) {
        ruinCount++;
        break;
      }

      if (t === 49) equityAt50.push(equity);
      if (t === 99) equityAt100.push(equity);
    }

    finalEquities.push(equity);
    maxDrawdowns.push(maxDD);
    if (equity < BANKROLL) negativeCount++;
  }

  finalEquities.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  const percentile = (arr: number[], p: number) => {
    const idx = Math.floor(arr.length * p);
    return arr[Math.min(idx, arr.length - 1)];
  };

  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

  console.log('--- Final Equity After ' + N_TRADES + ' Trades ---');
  console.log(`Mean:       $${mean(finalEquities).toFixed(2)}`);
  console.log(`Median:     $${percentile(finalEquities, 0.5).toFixed(2)}`);
  console.log(`5th pctile: $${percentile(finalEquities, 0.05).toFixed(2)}`);
  console.log(`25th:       $${percentile(finalEquities, 0.25).toFixed(2)}`);
  console.log(`75th:       $${percentile(finalEquities, 0.75).toFixed(2)}`);
  console.log(`95th:       $${percentile(finalEquities, 0.95).toFixed(2)}`);
  console.log(`Best:       $${percentile(finalEquities, 1.0).toFixed(2)}`);
  console.log(`Worst:      $${percentile(finalEquities, 0.0).toFixed(2)}`);

  console.log('\n--- Risk Metrics ---');
  console.log(`P(ruin / equity <= 0):   ${(ruinCount / N_PATHS * 100).toFixed(2)}%`);
  console.log(`P(net loss after ${N_TRADES}):   ${(negativeCount / N_PATHS * 100).toFixed(1)}%`);
  console.log(`P(lose > 50%):           ${(finalEquities.filter(e => e < BANKROLL * 0.5).length / N_PATHS * 100).toFixed(1)}%`);
  console.log(`P(double bankroll):      ${(finalEquities.filter(e => e >= BANKROLL * 2).length / N_PATHS * 100).toFixed(1)}%`);

  console.log('\n--- Max Drawdown Distribution ---');
  console.log(`Mean DD:    $${mean(maxDrawdowns).toFixed(2)}`);
  console.log(`Median DD:  $${percentile(maxDrawdowns, 0.5).toFixed(2)}`);
  console.log(`5th pctile: $${percentile(maxDrawdowns, 0.05).toFixed(2)} (worst 5%)`);
  console.log(`95th:       $${percentile(maxDrawdowns, 0.95).toFixed(2)} (best 5%)`);

  if (equityAt50.length > 0) {
    equityAt50.sort((a, b) => a - b);
    console.log('\n--- Equity at Trade 50 ---');
    console.log(`Mean:   $${mean(equityAt50).toFixed(2)}`);
    console.log(`5th:    $${percentile(equityAt50, 0.05).toFixed(2)}`);
    console.log(`95th:   $${percentile(equityAt50, 0.95).toFixed(2)}`);
  }

  if (equityAt100.length > 0) {
    equityAt100.sort((a, b) => a - b);
    console.log('\n--- Equity at Trade 100 ---');
    console.log(`Mean:   $${mean(equityAt100).toFixed(2)}`);
    console.log(`5th:    $${percentile(equityAt100, 0.05).toFixed(2)}`);
    console.log(`95th:   $${percentile(equityAt100, 0.95).toFixed(2)}`);
  }

  console.log('\n--- Expected Value ---');
  const ev = mean(finalEquities) - BANKROLL;
  console.log(`Expected profit (${N_TRADES} trades): $${ev.toFixed(2)}`);
  console.log(`Expected ROI: ${(ev / BANKROLL * 100).toFixed(1)}%`);
  console.log(`Sharpe (rough): ${(ev / Math.sqrt(finalEquities.reduce((s, v) => s + (v - mean(finalEquities)) ** 2, 0) / N_PATHS)).toFixed(2)}`);
}

main().catch(console.error);
