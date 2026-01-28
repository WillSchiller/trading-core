import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PublicClient, Hash, TransactionReceipt } from 'viem';
import {
  DirectRpcSubmission,
  FlashbotsProtectSubmission,
  FlashbotsSubmissionError,
  getSubmissionStrategy,
} from '../../src/execution/submission.js';

const mockPublicClient = {
  sendRawTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  getTransactionReceipt: vi.fn(),
} as unknown as PublicClient;

const mockReceipt: TransactionReceipt = {
  transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as Hash,
  blockNumber: 12345n,
  blockHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as `0x${string}`,
  transactionIndex: 0,
  from: '0x1234567890123456789012345678901234567890' as `0x${string}`,
  to: '0x0987654321098765432109876543210987654321' as `0x${string}`,
  cumulativeGasUsed: 100000n,
  gasUsed: 50000n,
  effectiveGasPrice: 1000000000n,
  status: 'success',
  type: 'eip1559',
  logs: [],
  logsBloom: '0x00' as `0x${string}`,
  contractAddress: null,
  root: undefined,
  blobGasPrice: undefined,
  blobGasUsed: undefined,
};

const mockSignedTx = '0xf86c0a8500000000008252089400000000000000000000000000000000000000008080820a95a0...' as `0x${string}`;
const mockTxHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as Hash;

describe('DirectRpcSubmission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns correct strategy name', () => {
    const strategy = new DirectRpcSubmission({ chain: 'base', publicClient: mockPublicClient });
    expect(strategy.getName()).toBe('direct-rpc');
  });

  it('submits transaction via publicClient.sendRawTransaction', async () => {
    (mockPublicClient.sendRawTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(mockTxHash);

    const strategy = new DirectRpcSubmission({ chain: 'base', publicClient: mockPublicClient });
    const hash = await strategy.submit(mockSignedTx);

    expect(hash).toBe(mockTxHash);
    expect(mockPublicClient.sendRawTransaction).toHaveBeenCalledWith({
      serializedTransaction: mockSignedTx,
    });
  });

  it('waits for transaction receipt', async () => {
    (mockPublicClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockResolvedValue(mockReceipt);

    const strategy = new DirectRpcSubmission({ chain: 'base', publicClient: mockPublicClient });
    const receipt = await strategy.waitForInclusion(mockTxHash, 120000);

    expect(receipt).toEqual(mockReceipt);
    expect(mockPublicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: mockTxHash,
      timeout: 120000,
    });
  });

  it('returns null on timeout', async () => {
    (mockPublicClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('timeout')
    );

    const strategy = new DirectRpcSubmission({ chain: 'base', publicClient: mockPublicClient });
    const receipt = await strategy.waitForInclusion(mockTxHash, 1);

    expect(receipt).toBeNull();
  });
});

describe('FlashbotsProtectSubmission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('returns correct strategy name', () => {
    const strategy = new FlashbotsProtectSubmission({ chain: 'mainnet', publicClient: mockPublicClient });
    expect(strategy.getName()).toBe('flashbots-protect');
  });

  it('submits transaction to Flashbots RPC', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: mockTxHash }),
    });

    const strategy = new FlashbotsProtectSubmission({ chain: 'mainnet', publicClient: mockPublicClient });
    const hash = await strategy.submit(mockSignedTx);

    expect(hash).toBe(mockTxHash);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://rpc.flashbots.net',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_sendRawTransaction',
          params: [mockSignedTx],
        }),
      })
    );
  });

  it('throws FlashbotsSubmissionError on RPC error response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'insufficient funds' },
      }),
    });

    const strategy = new FlashbotsProtectSubmission({ chain: 'mainnet', publicClient: mockPublicClient });

    await expect(strategy.submit(mockSignedTx)).rejects.toThrow(FlashbotsSubmissionError);
  });

  it('throws FlashbotsSubmissionError on HTTP error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const strategy = new FlashbotsProtectSubmission({ chain: 'mainnet', publicClient: mockPublicClient });

    await expect(strategy.submit(mockSignedTx)).rejects.toThrow(FlashbotsSubmissionError);
  });

  it('uses custom flashbots RPC URL if provided', async () => {
    const customUrl = 'https://custom-flashbots.example.com';
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: mockTxHash }),
    });

    const strategy = new FlashbotsProtectSubmission({
      chain: 'mainnet',
      publicClient: mockPublicClient,
      flashbotsRpcUrl: customUrl,
    });
    await strategy.submit(mockSignedTx);

    expect(global.fetch).toHaveBeenCalledWith(customUrl, expect.anything());
  });
});

describe('getSubmissionStrategy', () => {
  it('returns FlashbotsProtectSubmission for mainnet', () => {
    const strategy = getSubmissionStrategy('mainnet', mockPublicClient);
    expect(strategy.getName()).toBe('flashbots-protect');
  });

  it('returns DirectRpcSubmission for base', () => {
    const strategy = getSubmissionStrategy('base', mockPublicClient);
    expect(strategy.getName()).toBe('direct-rpc');
  });

  it('returns DirectRpcSubmission for arbitrum', () => {
    const strategy = getSubmissionStrategy('arbitrum', mockPublicClient);
    expect(strategy.getName()).toBe('direct-rpc');
  });
});
