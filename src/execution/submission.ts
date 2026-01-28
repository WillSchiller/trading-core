import type { Hash, TransactionReceipt, PublicClient } from 'viem';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';

export interface SubmissionStrategy {
  submit(signedTx: `0x${string}`): Promise<Hash>;
  waitForInclusion(txHash: Hash, timeoutMs: number): Promise<TransactionReceipt | null>;
  getName(): string;
}

export interface DirectRpcSubmissionConfig {
  chain: Chain;
  publicClient: PublicClient;
}

export class DirectRpcSubmission implements SubmissionStrategy {
  private logger: Logger;
  private publicClient: PublicClient;

  constructor(config: DirectRpcSubmissionConfig) {
    this.logger = createChildLogger({ component: 'direct-rpc-submission', chain: config.chain });
    this.publicClient = config.publicClient;
  }

  getName(): string {
    return 'direct-rpc';
  }

  async submit(signedTx: `0x${string}`): Promise<Hash> {
    this.logger.debug({ txLength: signedTx.length }, 'Submitting transaction via direct RPC');

    const hash = await this.publicClient.sendRawTransaction({ serializedTransaction: signedTx });

    this.logger.info({ hash }, 'Transaction submitted via direct RPC');
    return hash;
  }

  async waitForInclusion(txHash: Hash, timeoutMs: number): Promise<TransactionReceipt | null> {
    const startTime = Date.now();

    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: timeoutMs,
      });

      const elapsed = Date.now() - startTime;
      this.logger.info(
        {
          hash: txHash,
          status: receipt.status,
          blockNumber: receipt.blockNumber.toString(),
          elapsedMs: elapsed,
        },
        'Transaction receipt received'
      );

      return receipt;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const err = error as Error;

      if (elapsed >= timeoutMs || err.message.includes('timeout')) {
        this.logger.warn({ hash: txHash, elapsedMs: elapsed }, 'Transaction receipt timeout');
        return null;
      }

      throw error;
    }
  }
}

export interface FlashbotsProtectSubmissionConfig {
  chain: Chain;
  publicClient: PublicClient;
  flashbotsRpcUrl?: string;
}

const FLASHBOTS_PROTECT_RPC = 'https://rpc.flashbots.net';
const FLASHBOTS_STATUS_API = 'https://protect.flashbots.net';
const FETCH_TIMEOUT_MS = 10000;

export class FlashbotsProtectSubmission implements SubmissionStrategy {
  private logger: Logger;
  private publicClient: PublicClient;
  private flashbotsRpcUrl: string;

  constructor(config: FlashbotsProtectSubmissionConfig) {
    this.logger = createChildLogger({ component: 'flashbots-protect-submission', chain: config.chain });
    this.publicClient = config.publicClient;
    this.flashbotsRpcUrl = config.flashbotsRpcUrl ?? FLASHBOTS_PROTECT_RPC;
  }

  getName(): string {
    return 'flashbots-protect';
  }

  async submit(signedTx: `0x${string}`): Promise<Hash> {
    this.logger.debug({ txLength: signedTx.length }, 'Submitting transaction via Flashbots Protect');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(this.flashbotsRpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_sendRawTransaction',
          params: [signedTx],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const text = await response.text();
      this.logger.error({ status: response.status, body: text }, 'Flashbots RPC request failed');
      throw new FlashbotsSubmissionError(`Flashbots RPC error: ${response.status}`, text);
    }

    const result = await response.json() as FlashbotsRpcResponse;

    if (result.error) {
      this.logger.error({ error: result.error }, 'Flashbots RPC returned error');
      throw new FlashbotsSubmissionError(
        `Flashbots error: ${result.error.message}`,
        JSON.stringify(result.error)
      );
    }

    const hash = result.result as Hash;
    this.logger.info({ hash }, 'Transaction submitted via Flashbots Protect');
    return hash;
  }

  async waitForInclusion(txHash: Hash, timeoutMs: number): Promise<TransactionReceipt | null> {
    const startTime = Date.now();
    const pollIntervalMs = 1000;

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getTransactionStatus(txHash);

      if (status === 'INCLUDED') {
        try {
          const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
          const elapsed = Date.now() - startTime;
          this.logger.info(
            {
              hash: txHash,
              status: receipt.status,
              blockNumber: receipt.blockNumber.toString(),
              elapsedMs: elapsed,
            },
            'Flashbots transaction included'
          );
          return receipt;
        } catch {
          this.logger.debug({ hash: txHash }, 'Receipt not yet available, continuing to poll');
        }
      } else if (status === 'FAILED' || status === 'CANCELLED') {
        const elapsed = Date.now() - startTime;
        this.logger.warn({ hash: txHash, status, elapsedMs: elapsed }, 'Flashbots transaction failed/cancelled');
        throw new FlashbotsSubmissionError(`Transaction ${status.toLowerCase()}`, status);
      }

      await sleep(pollIntervalMs);
    }

    const elapsed = Date.now() - startTime;
    this.logger.warn({ hash: txHash, elapsedMs: elapsed }, 'Flashbots transaction receipt timeout');
    return null;
  }

  private async getTransactionStatus(txHash: Hash): Promise<FlashbotsTransactionStatus> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(`${FLASHBOTS_STATUS_API}/tx/${txHash}`, {
        signal: controller.signal,
      });

      if (response.status === 404) {
        return 'PENDING';
      }

      if (!response.ok) {
        this.logger.warn(
          { hash: txHash, status: response.status },
          'Failed to get Flashbots transaction status'
        );
        return 'UNKNOWN';
      }

      const result = await response.json() as FlashbotsStatusResponse;
      return result.status ?? 'UNKNOWN';
    } catch (error) {
      const err = error as Error;
      this.logger.warn({ hash: txHash, error: err.message }, 'Error checking Flashbots status');
      return 'UNKNOWN';
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

type FlashbotsTransactionStatus = 'PENDING' | 'INCLUDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

interface FlashbotsRpcResponse {
  jsonrpc: string;
  id: number;
  result?: string;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface FlashbotsStatusResponse {
  status?: FlashbotsTransactionStatus;
  hash?: string;
  maxBlockNumber?: number;
  receivedAt?: string;
}

export class FlashbotsSubmissionError extends Error {
  public readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = 'FlashbotsSubmissionError';
    this.detail = detail;
  }
}

export function getSubmissionStrategy(
  chain: Chain,
  publicClient: PublicClient,
  options?: { flashbotsRpcUrl?: string }
): SubmissionStrategy {
  if (chain === 'mainnet') {
    return new FlashbotsProtectSubmission({
      chain,
      publicClient,
      flashbotsRpcUrl: options?.flashbotsRpcUrl,
    });
  }

  return new DirectRpcSubmission({
    chain,
    publicClient,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
