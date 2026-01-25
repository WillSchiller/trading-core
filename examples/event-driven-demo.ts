import { ChainProvider, BlockWatcher, buildRpcEndpoints } from '../src/chain/index.js';
import { UniswapV3Connector } from '../src/collectors/dex/uniswap-v3.ts';
import type { Address } from 'viem';
import type { Chain } from '../src/types/index.js';

async function demonstrateEventDriven() {
  console.log('Event-Driven Optimization Demo\n');

  const chain: Chain = 'base';
  const poolAddress: Address = '0xd0b53D9277642d899DF5C87A3966A349A798F224';

  const endpoints = buildRpcEndpoints({
    chainId: 8453,
    httpUrl: process.env.RPC_BASE_HTTP || '',
    wsUrl: process.env.RPC_BASE_WS,
  });

  const provider = new ChainProvider({
    chain,
    endpoints,
  });

  const blockWatcher = new BlockWatcher(
    {
      chain,
      pollIntervalMs: 2000,
      useWebSocket: true,
    },
    provider
  );

  const pools = [
    await UniswapV3Connector.initializePool(
      poolAddress,
      provider,
      500,
      'WETH/USDC'
    ),
  ];

  const connector = new UniswapV3Connector(
    {
      chain,
      pools,
      useEventDriven: true,
      statsIntervalMs: 10000,
    },
    provider,
    blockWatcher
  );

  connector.on('quote', (quote) => {
    console.log(`[QUOTE] ${quote.pair} @ block ${quote.blockNumber}: $${quote.mid.toFixed(2)}`);
  });

  await blockWatcher.start();
  await connector.start();

  console.log('Monitoring pool for 60 seconds...\n');

  let lastStats = Date.now();
  const statsInterval = setInterval(() => {
    const stats = connector.getOptimizationStats();
    if (stats.enabled && stats.stats) {
      console.log('\n--- Optimization Stats ---');
      console.log(`Total Pools: ${stats.stats.totalPools}`);
      console.log(`Dirty Pools: ${stats.stats.dirtyPools}`);
      console.log(`Clean Pools: ${stats.stats.cleanPools}`);
      console.log(`Total Events: ${stats.stats.totalEvents}`);
      console.log(`Total Fetches: ${stats.stats.totalFetches}`);
      console.log(`Saved Fetches: ${stats.stats.totalSavedFetches}`);
      console.log(`Savings Rate: ${stats.stats.savingsRate.toFixed(1)}%`);
      console.log('-------------------------\n');
    }
  }, 10000);

  setTimeout(async () => {
    clearInterval(statsInterval);
    console.log('\nFinal stats:');
    const finalStats = connector.getOptimizationStats();
    if (finalStats.enabled && finalStats.stats) {
      console.log(JSON.stringify(finalStats.stats, null, 2));
    }

    await connector.stop();
    await blockWatcher.stop();
    await provider.close();

    console.log('\nDemo complete.');
    process.exit(0);
  }, 60000);
}

if (process.env.RPC_BASE_HTTP) {
  demonstrateEventDriven().catch((error) => {
    console.error('Demo failed:', error);
    process.exit(1);
  });
} else {
  console.error('RPC_BASE_HTTP environment variable required');
  process.exit(1);
}
