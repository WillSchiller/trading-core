import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const pk = process.env.POLYMARKET_PRIVATE_KEY || process.env.METAMASK_PK;
const apiKey = process.env.POLYMARKET_API_KEY;
const apiSecret = process.env.POLYMARKET_API_SECRET;
const passphrase = process.env.POLYMARKET_PASSPHRASE;
const funder = process.env.POLYMARKET_FUNDER_ADDRESS;

if (!pk || !apiKey || !apiSecret || !passphrase) {
  console.error('Missing env vars');
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
const wallet = createWalletClient({ account, chain: polygon, transport: http() });

const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client');

const client = new ClobClient(
  'https://clob.polymarket.com',
  137,
  wallet,
  { key: apiKey, secret: apiSecret, passphrase },
  Number(process.env.POLYMARKET_SIGNATURE_TYPE || '0'),
  funder,
);

console.log('Signer:', account.address);
console.log('Funder:', funder);

// Find a cheap market to test with
const resp = await fetch('https://gamma-api.polymarket.com/markets?closed=false&limit=5&order=volume&ascending=false');
const markets = await resp.json() as any[];
const market = markets.find((m: any) => {
  const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
  return prices.some((p: number) => p > 0.1 && p < 0.5);
});

if (!market) {
  console.error('No suitable test market found');
  process.exit(1);
}

const prices = JSON.parse(market.outcomePrices || '[]').map(Number);
const tokenIds = JSON.parse(market.clobTokenIds || '[]') as string[];
const idx = prices.findIndex((p: number) => p > 0.1 && p < 0.5);
const tokenId = tokenIds[idx];
const price = Math.round(prices[idx] * 100) / 100;

console.log('\nTest market:', market.question?.slice(0, 80));
console.log('Token:', tokenId?.slice(0, 20) + '...');
console.log('Price:', price);
console.log('Placing $1 FOK order...\n');

try {
  const result = await client.createAndPostMarketOrder(
    {
      tokenID: tokenId,
      amount: 1,
      side: Side.BUY,
      price,
    },
    { tickSize: '0.01', negRisk: market.negRisk || false },
    OrderType.GTC,
  );
  console.log('Response:', JSON.stringify(result, null, 2));
} catch (err: any) {
  console.error('Error:', err.message);
  if (err.response?.data) console.error('Data:', JSON.stringify(err.response.data));
}
