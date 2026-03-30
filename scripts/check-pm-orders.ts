import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const pk = process.env.POLYMARKET_PRIVATE_KEY || process.env.METAMASK_PK;
const account = privateKeyToAccount(pk as `0x${string}`);
const wallet = createWalletClient({ account, chain: polygon, transport: http() });

const { ClobClient } = await import('@polymarket/clob-client');
const client = new ClobClient('https://clob.polymarket.com', 137, wallet,
  { key: process.env.POLYMARKET_API_KEY!, secret: process.env.POLYMARKET_API_SECRET!, passphrase: process.env.POLYMARKET_PASSPHRASE! },
  2, '0x6A5cAc3e4B85D546B24278fCbf98D26C33C8444C');

const orders = await client.getOpenOrders();
console.log('Open orders:', orders.length);
for (const o of orders as any[]) {
  console.log(o.id, o.side, 'price:', o.price, 'size:', o.original_size, 'matched:', o.size_matched, o.status);
}

const trades = await client.getTrades();
console.log('\nTrades:', (trades as any[]).length);
for (const t of (trades as any[]).slice(0, 5)) {
  console.log(t.id, t.side, 'price:', t.price, 'size:', t.size, t.status);
}
