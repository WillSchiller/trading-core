import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const pk = process.env.POLYMARKET_PRIVATE_KEY || process.env.METAMASK_PK;
const account = privateKeyToAccount(pk as `0x${string}`);
const wallet = createWalletClient({ account, chain: polygon, transport: http() });

const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client');
const client = new ClobClient('https://clob.polymarket.com', 137, wallet,
  { key: process.env.POLYMARKET_API_KEY!, secret: process.env.POLYMARKET_API_SECRET!, passphrase: process.env.POLYMARKET_PASSPHRASE! },
  2, '0x6A5cAc3e4B85D546B24278fCbf98D26C33C8444C');

// Cancel any existing orders
await client.cancelAll();
console.log('Cancelled all existing orders');

// Find liquid market
const resp = await fetch('https://gamma-api.polymarket.com/markets?closed=false&limit=20&order=volume&ascending=false');
const markets = await resp.json() as any[];

for (const m of markets) {
  const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
  const tokenIds = JSON.parse(m.clobTokenIds || '[]') as string[];
  if (!tokenIds.length || prices.length !== tokenIds.length) continue;

  const idx = prices.findIndex((p: number) => p >= 0.20 && p <= 0.80);
  if (idx < 0) continue;

  const tokenId = tokenIds[idx];
  const outcome = JSON.parse(m.outcomes || '[]')[idx];

  // Get the order book to find the actual ask
  const book = await client.getOrderBook(tokenId);
  if (!book.asks || book.asks.length === 0) continue;

  const bestAsk = parseFloat(book.asks[0].price);
  console.log('Market:', m.question?.slice(0, 80));
  console.log('Outcome:', outcome);
  console.log('Mid:', prices[idx].toFixed(2), '| Best ask:', bestAsk);

  // Buy AT the ask to fill immediately
  const size = Math.max(5, Math.ceil(2 / bestAsk));
  console.log('Buying', size, 'shares at', bestAsk, '= $' + (size * bestAsk).toFixed(2));

  const result = await client.createAndPostOrder(
    { tokenID: tokenId, price: bestAsk, side: Side.BUY, size },
    { tickSize: '0.01', negRisk: m.negRisk || false },
    OrderType.GTC,
  );

  console.log('\nResponse:', JSON.stringify(result, null, 2));

  if (result.success) {
    await new Promise(r => setTimeout(r, 3000));
    if (result.orderID) {
      const order = await client.getOrder(result.orderID);
      console.log('Matched:', (order as any).size_matched, '/', (order as any).original_size);
    }
    console.log('\nCheck your Polymarket portfolio now.');
  }
  break;
}
