import type { RpcEndpoint } from './provider-pool.js';
import type { EnvConfig } from '../config/types.js';
import type { Chain } from '../types/index.js';

export function buildRpcEndpoints(chain: Chain, envConfig: EnvConfig): RpcEndpoint[] {
  const endpoints: RpcEndpoint[] = [];

  const chainRpcConfig = chain === 'base' ? envConfig.rpc.base : envConfig.rpc.mainnet;

  if (chainRpcConfig.drpc.http) {
    endpoints.push({
      name: 'drpc',
      httpUrl: chainRpcConfig.drpc.http,
      wsUrl: chainRpcConfig.drpc.ws,
      priority: 1,
      maxRetriesBeforeFallback: 3,
    });
  }

  if (chainRpcConfig.alchemy.http) {
    endpoints.push({
      name: 'alchemy',
      httpUrl: chainRpcConfig.alchemy.http,
      wsUrl: chainRpcConfig.alchemy.ws,
      priority: 2,
      maxRetriesBeforeFallback: 3,
    });
  }

  if (endpoints.length === 0) {
    throw new Error(`No RPC endpoints configured for chain: ${chain}`);
  }

  return endpoints;
}
