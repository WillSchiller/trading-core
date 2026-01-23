import { createPublicClient, createWalletClient, http, webSocket, type PublicClient, type WalletClient, type Chain as ViemChain, type Address } from 'viem';
import { base, mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';

export interface ChainProviderConfig {
  chain: Chain;
  httpUrl: string;
  wsUrl?: string;
  privateKey?: string;
}

export class ChainProvider {
  private logger: Logger;
  private publicClient: PublicClient;
  private wsPublicClient?: PublicClient;
  private walletClient?: WalletClient;
  private viemChain: ViemChain;

  constructor(config: ChainProviderConfig) {
    this.logger = createChildLogger({ chain: config.chain, component: 'chain-provider' });

    this.viemChain = this.getViemChain(config.chain);

    this.publicClient = createPublicClient({
      chain: this.viemChain,
      transport: http(config.httpUrl, {
        retryCount: 3,
        retryDelay: 1000,
      }),
    });

    if (config.wsUrl) {
      this.wsPublicClient = createPublicClient({
        chain: this.viemChain,
        transport: webSocket(config.wsUrl, {
          retryCount: 5,
          retryDelay: 1000,
        }),
      });
    }

    if (config.privateKey) {
      const account = privateKeyToAccount(config.privateKey as `0x${string}`);
      this.walletClient = createWalletClient({
        account,
        chain: this.viemChain,
        transport: http(config.httpUrl),
      });
      this.logger.info({ address: account.address }, 'Wallet client initialized');
    }

    this.logger.info('Chain provider initialized');
  }

  public getPublicClient(): PublicClient {
    return this.publicClient;
  }

  public getWsPublicClient(): PublicClient | undefined {
    return this.wsPublicClient;
  }

  public getWalletClient(): WalletClient | undefined {
    return this.walletClient;
  }

  public getViemChain(chain: Chain): ViemChain {
    switch (chain) {
      case 'base':
        return base;
      case 'mainnet':
        return mainnet;
      default:
        throw new Error(`Unsupported chain: ${chain}`);
    }
  }

  public async getCurrentBlock(): Promise<bigint> {
    try {
      const blockNumber = await this.publicClient.getBlockNumber();
      return blockNumber;
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Failed to get current block');
      throw error;
    }
  }

  public async getBalance(address: Address): Promise<bigint> {
    try {
      const balance = await this.publicClient.getBalance({ address });
      return balance;
    } catch (error) {
      this.logger.error({ error: (error as Error).message, address }, 'Failed to get balance');
      throw error;
    }
  }

  public async waitForTransactionReceipt(hash: `0x${string}`) {
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
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
      const gas = await this.publicClient.estimateGas(params);
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
  }
}
