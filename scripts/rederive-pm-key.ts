import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const pk = process.env.POLYMARKET_PRIVATE_KEY || process.env.METAMASK_PK;
if (!pk) { console.error('No PK'); process.exit(1); }

const account = privateKeyToAccount(pk as `0x${string}`);
const wallet = createWalletClient({ account, chain: polygon, transport: http() });

console.log('Wallet:', account.address);

const { ClobClient } = await import('@polymarket/clob-client');
const client = new ClobClient('https://clob.polymarket.com', 137, wallet);

console.log('Deriving...');
const creds = await client.deriveApiKey();
console.log('API Key:', creds.key);
console.log('Secret:', creds.secret);
console.log('Passphrase:', creds.passphrase);

// Now test placing an order with derived creds
const fullClient = new ClobClient(
  'https://clob.polymarket.com', 137, wallet,
  creds, 1, '0x6A5cAc3e4B85D546B24278fCbf98D26C33C8444C',
);

const openOrders = await fullClient.getOpenOrders();
console.log('\nOpen orders:', openOrders.length || 0);
console.log('Auth works!');
