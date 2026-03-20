import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const pk = process.env.POLYMARKET_PRIVATE_KEY || process.env.METAMASK_PK;
if (!pk) {
  console.error('Set POLYMARKET_PRIVATE_KEY or METAMASK_PK');
  process.exit(1);
}

const apiKey = process.env.POLYMARKET_API_KEY;
const apiSecret = process.env.POLYMARKET_API_SECRET;
const passphrase = process.env.POLYMARKET_PASSPHRASE;
if (!apiKey || !apiSecret || !passphrase) {
  console.error('Set POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE');
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
const wallet = createWalletClient({ account, chain: polygon, transport: http() });

console.log('Signer:', account.address);

const { ClobClient } = await import('@polymarket/clob-client');

const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || account.address;
const sigType = Number(process.env.POLYMARKET_SIGNATURE_TYPE || '0');

const client = new ClobClient(
  'https://clob.polymarket.com',
  137,
  wallet,
  { key: apiKey, secret: apiSecret, passphrase },
  sigType,
  funderAddress,
);

console.log('\n--- Testing API access ---');

try {
  const openOrders = await client.getOpenOrders();
  console.log('Open orders:', openOrders.length || 0);
} catch (e: any) {
  console.error('getOpenOrders failed:', e.message);
}

try {
  const bal = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
  console.log('Balance/allowance:', JSON.stringify(bal));
} catch (e: any) {
  console.error('getBalanceAllowance failed:', e.message);
}

// Fetch a live market to test price reading
try {
  const resp = await fetch('https://gamma-api.polymarket.com/markets?closed=false&limit=1');
  const markets = await resp.json() as any[];
  if (markets.length) {
    const m = markets[0];
    console.log('\nSample market:', m.question?.slice(0, 80));
    console.log('Condition:', m.conditionId);
    console.log('Prices:', m.outcomePrices);
    console.log('Token IDs:', m.clobTokenIds);
  }
} catch (e: any) {
  console.error('Gamma fetch failed:', e.message);
}

console.log('\n--- Done ---');
