/**
 * Deep dive into top Solana wallets using Helius parsed transaction API.
 * Check if top traders are insiders/deployers or real skilled traders.
 */

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_URL = `https://api-mainnet.helius-rpc.com/v0`;

if (!HELIUS_API_KEY) {
  console.error('Set HELIUS_API_KEY env var (free at helius.dev)');
  process.exit(1);
}

interface SwapTx {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  tokenInputs: Array<{ mint: string; amount: number; symbol?: string }>;
  tokenOutputs: Array<{ mint: string; amount: number; symbol?: string }>;
}

async function getSwapHistory(address: string, limit = 50): Promise<SwapTx[]> {
  const url = `${HELIUS_URL}/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&limit=${limit}&type=SWAP`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`${resp.status}: ${body.slice(0, 200)}`);
  }
  const txs = await resp.json() as any[];
  return txs.map(tx => ({
    signature: tx.signature,
    timestamp: tx.timestamp,
    type: tx.type,
    source: tx.source || 'unknown',
    tokenInputs: tx.events?.swap?.tokenInputs || tx.tokenTransfers?.filter((t: any) => t.fromUserAccount === address) || [],
    tokenOutputs: tx.events?.swap?.tokenOutputs || tx.tokenTransfers?.filter((t: any) => t.toUserAccount === address) || [],
  }));
}

async function getAllTxTypes(address: string, limit = 100): Promise<any[]> {
  const url = `${HELIUS_URL}/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status}`);
  return resp.json() as Promise<any[]>;
}

async function analyzeWallet(address: string, label: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${label}`);
  console.log(`Address: ${address}`);
  console.log('='.repeat(70));

  // Get all tx types first
  console.log('\nFetching all transactions...');
  const allTxs = await getAllTxTypes(address, 100);
  console.log(`Total txs (last 100): ${allTxs.length}`);

  // Count by type
  const typeCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  for (const tx of allTxs) {
    typeCounts[tx.type] = (typeCounts[tx.type] || 0) + 1;
    const src = tx.source || 'unknown';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  }
  console.log('\nTransaction types:');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(25)} ${count}`);
  }
  console.log('\nDEX sources:');
  for (const [src, count] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`  ${src.padEnd(25)} ${count}`);
  }

  // Check for token creation (deployer signal)
  const createTxs = allTxs.filter((tx: any) => tx.type === 'CREATE' || tx.type === 'TOKEN_MINT' || tx.type === 'INIT_MINT');
  if (createTxs.length > 0) {
    console.log(`\n⚠️  DEPLOYER SIGNAL: ${createTxs.length} token creation transactions found!`);
  }

  await new Promise(r => setTimeout(r, 1000));

  // Get swap history
  console.log('\nFetching swap history...');
  const swaps = await getSwapHistory(address, 50);
  console.log(`Swaps: ${swaps.length}`);

  if (swaps.length === 0) return;

  // Analyze swap patterns
  const uniqueTokens = new Set<string>();
  const dexes = new Set<string>();
  let buyCount = 0;
  let sellCount = 0;

  for (const swap of swaps) {
    dexes.add(swap.source);
    for (const input of swap.tokenInputs) {
      if (input.mint) uniqueTokens.add(input.mint);
    }
    for (const output of swap.tokenOutputs) {
      if (output.mint) uniqueTokens.add(output.mint);
    }
    // SOL/USDC in = buying token, token in = selling
    const solIn = swap.tokenInputs.some((t: any) =>
      t.mint === 'So11111111111111111111111111111111111111112' || t.symbol === 'SOL' || t.symbol === 'USDC'
    );
    if (solIn) buyCount++;
    else sellCount++;
  }

  console.log(`\nSwap analysis (last ${swaps.length} swaps):`);
  console.log(`  Unique tokens traded: ${uniqueTokens.size}`);
  console.log(`  DEXes used: ${[...dexes].join(', ')}`);
  console.log(`  Buys: ${buyCount}, Sells: ${sellCount}`);
  console.log(`  Buy ratio: ${(buyCount / swaps.length * 100).toFixed(0)}%`);

  // Time analysis
  const timestamps = swaps.map(s => s.timestamp).sort();
  if (timestamps.length >= 2) {
    const first = new Date(timestamps[0] * 1000);
    const last = new Date(timestamps[timestamps.length - 1] * 1000);
    const spanHours = (timestamps[timestamps.length - 1] - timestamps[0]) / 3600;
    const avgGapMin = spanHours * 60 / swaps.length;
    console.log(`  Time span: ${first.toISOString().slice(0, 10)} to ${last.toISOString().slice(0, 10)}`);
    console.log(`  Avg gap between trades: ${avgGapMin.toFixed(0)} min`);
  }

  // Show last 5 swaps
  console.log('\nRecent swaps:');
  for (const swap of swaps.slice(0, 5)) {
    const time = new Date(swap.timestamp * 1000).toISOString().slice(0, 16);
    const inSyms = swap.tokenInputs.map((t: any) => t.symbol || t.mint?.slice(0, 6) || '?').join('+');
    const outSyms = swap.tokenOutputs.map((t: any) => t.symbol || t.mint?.slice(0, 6) || '?').join('+');
    console.log(`  ${time} | ${swap.source.padEnd(12)} | ${inSyms} → ${outSyms}`);
  }

  // Verdict
  console.log('\nVerdict:');
  if (createTxs.length > 0) {
    console.log('  🔴 LIKELY INSIDER/DEPLOYER — creates tokens');
  } else if (uniqueTokens.size < 5 && buyCount > sellCount * 3) {
    console.log('  🟡 SUSPICIOUS — few tokens, mostly buys (possible pump scheme)');
  } else if (uniqueTokens.size > 10 && Math.abs(buyCount - sellCount) < swaps.length * 0.3) {
    console.log('  🟢 LIKELY REAL TRADER — diversified across many tokens, balanced buy/sell');
  } else {
    console.log('  🟡 UNCLEAR — need more data');
  }
}

async function main() {
  const wallets = [
    ['HkFGQsW8mr8DTC2AE2WcC7MzwSnynfEryGMQSht271nf', 'Top #2: 2,631 trades, $2.8M PnL, $1,078/trade'],
    ['ApAKzJEqfnP7F74Za5xdTQxZMK4nD8dFTVBQ9bksTtGM', 'Top #3: 2,660 trades, $2.8M PnL, $1,060/trade'],
    ['tUitCs7qQVxmJx5x9C4eKz5UEdonFFmsU2ufeLCFS7f', 'Top #4: 935 trades, $2.2M PnL, $2,300/trade'],
    ['GFHMc9BegxJXLdHJrABxNVoPRdnmVxXiNeoUCEpgXVHw', 'Top #1: 69 trades, $10.3M PnL — SUSPECTED INSIDER'],
  ];

  for (const [addr, label] of wallets) {
    await analyzeWallet(addr, label);
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log('If most top wallets are deployers/insiders → no copyable edge');
  console.log('If most are real traders → our PM model pipeline could work on Solana');
}

main().catch(console.error);
