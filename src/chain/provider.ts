import { createWalletClient, http, type PublicClient, type WalletClient, type Chain as ViemChain, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';
import { ProviderPool, type RpcEndpoint } from './provider-pool.js';

export interface ChainProviderConfig {
  chain: Chain;
  endpoints: RpcEndpoint[];
  privateKey?: string;
}

export class ChainProvider {
  private logger: Logger;
  private providerPool: ProviderPool;
  private walletClient?: WalletClient;
  private viemChain: ViemChain;

  constructor(config: ChainProviderConfig) {
    this.logger = createChildLogger({ chain: config.chain, component: 'chain-provider' });

    this.providerPool = new ProviderPool({
      chain: config.chain,
      endpoints: config.endpoints,
    });

    this.viemChain = this.providerPool.getViemChainObject();

    if (config.privateKey) {
      const account = privateKeyToAccount(config.privateKey as `0x${string}`);
      const primaryEndpoint = config.endpoints.sort((a, b) => a.priority - b.priority)[0];
      this.walletClient = createWalletClient({
        account,
        chain: this.viemChain,
        transport: http(primaryEndpoint.httpUrl),
      });
      this.logger.info({ address: account.address }, 'Wallet client initialized');
    }

    this.logger.info({ endpointCount: config.endpoints.length }, 'Chain provider initialized');
  }

  public getPublicClient(): PublicClient {
    return this.providerPool.getPublicClient();
  }

  public getWsPublicClient(): PublicClient | undefined {
    return this.providerPool.getWsPublicClient();
  }

  public getWalletClient(): WalletClient | undefined {
    return this.walletClient;
  }

  public getViemChain(): ViemChain {
    return this.viemChain;
  }

  public getProviderPool(): ProviderPool {
    return this.providerPool;
  }

  public async getCurrentBlock(): Promise<bigint> {
    try {
      const client = this.getPublicClient();
      const blockNumber = await client.getBlockNumber();
      return blockNumber;
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Failed to get current block');
      throw error;
    }
  }

  public async getBalance(address: Address): Promise<bigint> {
    try {
      const client = this.getPublicClient();
      const balance = await client.getBalance({ address });
      return balance;
    } catch (error) {
      this.logger.error({ error: (error as Error).message, address }, 'Failed to get balance');
      throw error;
    }
  }

  public async waitForTransactionReceipt(hash: `0x${string}`) {
    try {
      const client = this.getPublicClient();
      const receipt = await client.waitForTransactionReceipt({ hash });
      return receipt;
    } catch (error) {
      this.logger.error({ error: (error as Error).message, hash }, 'Failed to wait for transaction receipt');
      throw error;
    }
  }

  public async estimateGas(params: {
    to: Address;
    data?: `0x${string}`;
    value?: bigint;
    account?: Address;
  }): Promise<bigint> {
    try {
      const client = this.getPublicClient();
      const gas = await client.estimateGas(params);
      return gas;
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Failed to estimate gas');
      throw error;
    }
  }

  public getChainId(): number {
    return this.viemChain.id;
  }

  public getChainName(): string {
    return this.viemChain.name;
  }

  public async close(): Promise<void> {
    this.logger.info('Closing chain provider');
    await this.providerPool.close();
  }

  public getHealthStatus() {
    return this.providerPool.getHealthStatus();
  }
}
