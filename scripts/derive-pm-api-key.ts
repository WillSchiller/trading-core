import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const pk = process.env.METAMASK_PK;
if (!pk) {
  console.error('Set METAMASK_PK env var');
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
const wallet = createWalletClient({ account, chain: polygon, transport: http() });

console.log('Wallet address:', account.address);
console.log('Deriving API key from Polymarket...\n');

const { ClobClient } = await import('@polymarket/clob-client');
const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
const creds = await client.createOrDeriveApiKey();

console.log('Add these to your .env:\n');
console.log(`POLYMARKET_API_KEY=${creds.key}`);
console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
console.log(`POLYMARKET_PASSPHRASE=${creds.passphrase}`);
console.log(`\nFunder address: ${account.address}`);
console.log('Signature type: 1 (POLY_PROXY)');
