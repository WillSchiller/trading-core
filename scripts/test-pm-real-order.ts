import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const pk = process.env.POLYMARKET_PRIVATE_KEY || process.env.METAMASK_PK;
const apiKey = process.env.POLYMARKET_API_KEY;
const apiSecret = process.env.POLYMARKET_API_SECRET;
const passphrase = process.env.POLYMARKET_PASSPHRASE;

const account = privateKeyToAccount(pk as `0x${string}`);
const wallet = createWalletClient({ account, chain: polygon, transport: http() });

const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client');

const client = new ClobClient(
  'https://clob.polymarket.com', 137, wallet,
  { key: apiKey!, secret: apiSecret!, passphrase: passphrase! },
  2,
  '0x6A5cAc3e4B85D546B24278fCbf98D26C33C8444C',
);

// Find a liquid market with a price we can buy at market
const resp = await fetch('https://gamma-api.polymarket.com/markets?closed=false&limit=20&order=volume&ascending=false');
const markets = await resp.json() as any[];

for (const m of markets) {
  const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
  const tokenIds = JSON.parse(m.clobTokenIds || '[]') as string[];
  if (!tokenIds.length || prices.length !== tokenIds.length) continue;

  const idx = prices.findIndex((p: number) => p >= 0.20 && p <= 0.50);
  if (idx < 0) continue;

  const price = Math.round(prices[idx] * 100) / 100;
  const tokenId = tokenIds[idx];
  const outcome = JSON.parse(m.outcomes || '[]')[idx];

  console.log('Market:', m.question?.slice(0, 80));
  console.log('Outcome:', outcome);
  console.log('Price:', price);
  console.log('negRisk:', m.negRisk);
  console.log('\nPlacing $1 GTC limit buy at MARKET price (', price, ') to fill immediately');

  // Buy at market — use current ask price so it fills
  const size = Math.max(5, Math.ceil(1 / price));

  const result = await client.createAndPostOrder(
    { tokenID: tokenId, price, side: Side.BUY, size },
    { tickSize: '0.01', negRisk: m.negRisk || false },
    OrderType.GTC,
  );

  console.log('\nResponse:', JSON.stringify(result, null, 2));

  if (result.orderID) {
    console.log('\nOrder live:', result.orderID);
    console.log('Waiting 5s to check fill...');
    await new Promise(r => setTimeout(r, 5000));

    const order = await client.getOrder(result.orderID);
    console.log('Order status:', JSON.stringify(order, null, 2));

    // Check portfolio
    console.log('\nChecking portfolio...');
    const bal = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    console.log('Balance:', JSON.stringify(bal));
  }
  break;
}
