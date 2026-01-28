import {
  type PublicClient,
  type Address,
  type Chain as ViemChain,
  type TransactionRequest,
  type Hash,
  type TransactionSerializable,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base, mainnet } from 'viem/chains';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';
import { type SubmissionStrategy, getSubmissionStrategy } from './submission.js';

class Mutex {
  private locked = false;
  private queue: { resolve: () => void; startTime: number }[] = [];

  async acquire(): Promise<{ waitMs: number }> {
    const startTime = Date.now();
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve({ waitMs: Date.now() - startTime });
      } else {
        this.queue.push({ resolve: () => resolve({ waitMs: Date.now() - startTime }), startTime });
      }
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next.resolve();
    } else {
      this.locked = false;
    }
  }
}

export interface SignerConfig {
  chain: Chain;
  httpUrl: string;
  privateKey: string;
  useFlashbotsProtect?: boolean;
}

export class TransactionSigner {
  private logger: Logger;
  private publicClient: PublicClient;
  private account: PrivateKeyAccount;
  private viemChain: ViemChain;
  private currentNonce: number | null;
  private pendingNonces: Set<number>;
  private nonceMutex: Mutex;
  private submissionStrategy: SubmissionStrategy;
  private static readonly MUTEX_WARN_THRESHOLD_MS = 200;

  constructor(publicClient: PublicClient, config: SignerConfig) {
    this.logger = createChildLogger({ component: 'signer', chain: config.chain });
    this.publicClient = publicClient;
    this.viemChain = this.getViemChain(config.chain);
    this.currentNonce = null;
    this.pendingNonces = new Set();
    this.nonceMutex = new Mutex();

    this.account = privateKeyToAccount(config.privateKey as `0x${string}`);

    const useFlashbots = config.useFlashbotsProtect ?? (config.chain === 'mainnet');
    if (useFlashbots && config.chain === 'mainnet') {
      this.submissionStrategy = getSubmissionStrategy('mainnet', publicClient);
    } else {
      this.submissionStrategy = getSubmissionStrategy(config.chain, publicClient);
    }

    this.logger.info(
      {
        address: this.account.address,
        submissionStrategy: this.submissionStrategy.getName(),
      },
      'Signer initialized'
    );
  }

  private getViemChain(chain: Chain): ViemChain {
    switch (chain) {
      case 'base':
        return base;
      case 'mainnet':
        return mainnet;
      default:
        throw new Error(`Unsupported chain: ${chain}`);
    }
  }

  getAddress(): Address {
    return this.account.address;
  }

  async getBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  async getNonce(): Promise<number> {
    if (this.currentNonce === null) {
      this.currentNonce = await this.fetchNonceFromChain();
    }
    return this.currentNonce;
  }

  private async fetchNonceFromChain(): Promise<number> {
    const nonce = await this.publicClient.getTransactionCount({
      address: this.account.address,
      blockTag: 'pending',
    });
    this.logger.debug({ nonce }, 'Fetched nonce from chain');
    return nonce;
  }

  async reserveNonce(): Promise<number> {
    const { waitMs } = await this.nonceMutex.acquire();
    if (waitMs > TransactionSigner.MUTEX_WARN_THRESHOLD_MS) {
      this.logger.warn(
        { component: 'TransactionSigner', waitMs, threshold: TransactionSigner.MUTEX_WARN_THRESHOLD_MS },
        'Mutex wait exceeded threshold'
      );
    } else {
      this.logger.debug({ component: 'TransactionSigner', waitMs }, 'Mutex acquired');
    }
    try {
      const nonce = await this.getNonce();
      this.pendingNonces.add(nonce);
      this.currentNonce = nonce + 1;
      this.logger.debug({ reservedNonce: nonce }, 'Nonce reserved');
      return nonce;
    } finally {
      this.nonceMutex.release();
    }
  }

  releaseNonce(nonce: number): void {
    this.pendingNonces.delete(nonce);
    this.logger.debug({ releasedNonce: nonce }, 'Nonce released');
  }

  async resetNonce(): Promise<void> {
    this.currentNonce = await this.fetchNonceFromChain();
    this.pendingNonces.clear();
    this.logger.info({ nonce: this.currentNonce }, 'Nonce reset');
  }

  async signTransaction(request: TransactionRequest): Promise<{ signedTx: `0x${string}`; nonce: number }> {
    const nonce = await this.reserveNonce();

    try {
      const txToSign: TransactionSerializable = {
        to: request.to,
        data: request.data,
        value: request.value ?? 0n,
        gas: request.gas,
        maxFeePerGas: request.maxFeePerGas,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas,
        nonce,
        chainId: this.viemChain.id,
        type: 'eip1559',
      };

      const signature = await this.account.signTransaction(txToSign);

      this.logger.debug(
        {
          nonce,
          to: request.to,
          chainId: this.viemChain.id,
        },
        'Transaction signed'
      );

      return { signedTx: signature, nonce };
    } catch (error) {
      this.releaseNonce(nonce);
      throw error;
    }
  }

  async signAndSendTransaction(request: TransactionRequest): Promise<Hash> {
    const { signedTx, nonce } = await this.signTransaction(request);

    try {
      const hash = await this.submissionStrategy.submit(signedTx);

      this.logger.info(
        {
          hash,
          nonce,
          to: request.to,
          value: request.value?.toString(),
          strategy: this.submissionStrategy.getName(),
        },
        'Transaction sent'
      );

      return hash;
    } catch (error) {
      this.releaseNonce(nonce);
      const err = error as Error;

      if (err.message.toLowerCase().includes('nonce too low')) {
        this.logger.warn({ nonce }, 'Nonce too low, resetting');
        await this.resetNonce();
        throw new NonceError('Nonce too low', nonce);
      }

      throw error;
    }
  }

  async simulateTransaction(request: TransactionRequest): Promise<void> {
    try {
      await this.publicClient.call({
        account: this.account.address,
        to: request.to,
        data: request.data,
        value: request.value,
        gas: request.gas,
        maxFeePerGas: request.maxFeePerGas,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      });
      this.logger.debug({ to: request.to }, 'Transaction simulation successful');
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        { error: err.message, to: request.to },
        'Transaction simulation failed'
      );
      throw new SimulationError('Simulation failed', err.message);
    }
  }

  async waitForReceipt(hash: Hash, timeoutMs: number = 120000) {
    const startTime = Date.now();

    try {
      const receipt = await this.submissionStrategy.waitForInclusion(hash, timeoutMs);

      if (!receipt) {
        this.logger.warn({ hash, elapsedMs: Date.now() - startTime }, 'Transaction receipt timeout');
        throw new ReceiptTimeoutError('Receipt timeout', hash);
      }

      const elapsed = Date.now() - startTime;
      this.logger.info(
        {
          hash,
          status: receipt.status,
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          elapsedMs: elapsed,
          strategy: this.submissionStrategy.getName(),
        },
        'Transaction receipt received'
      );

      return receipt;
    } catch (error) {
      if (error instanceof ReceiptTimeoutError) {
        throw error;
      }
      const elapsed = Date.now() - startTime;
      this.logger.warn({ hash, elapsedMs: elapsed, error: (error as Error).message }, 'Error waiting for receipt');
      throw error;
    }
  }

  getSubmissionStrategyName(): string {
    return this.submissionStrategy.getName();
  }
}

export class NonceError extends Error {
  public readonly nonce: number;

  constructor(message: string, nonce: number) {
    super(message);
    this.name = 'NonceError';
    this.nonce = nonce;
  }
}

export class SimulationError extends Error {
  public readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = 'SimulationError';
    this.reason = reason;
  }
}

export class ReceiptTimeoutError extends Error {
  public readonly hash: Hash;

  constructor(message: string, hash: Hash) {
    super(message);
    this.name = 'ReceiptTimeoutError';
    this.hash = hash;
  }
}
