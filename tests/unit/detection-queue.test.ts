import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DetectionQueue } from '../../src/detection/detection-queue.js';

vi.mock('../../src/persistence/opportunities.js', () => ({
  updateOpportunityLastSeen: vi.fn().mockResolvedValue(undefined),
  closeOpportunity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('DetectionQueue', () => {
  let queue: DetectionQueue;

  beforeEach(() => {
    queue = new DetectionQueue();
  });

  afterEach(async () => {
    await queue.stop();
  });

  it('should enqueue last seen updates', () => {
    const opportunityId = BigInt(1);
    const lastSeenAt = new Date();
    const maxSpreadBps = 25.5;

    queue.enqueueLastSeen(opportunityId, lastSeenAt, maxSpreadBps);

    const queueLengths = queue.getQueueLengths();
    expect(queueLengths.lastSeen).toBe(1);
    expect(queueLengths.close).toBe(0);
  });

  it('should enqueue close updates', () => {
    const opportunityId = BigInt(1);
    const closedAt = new Date();
    const closeReason = 'spread_below_threshold';

    queue.enqueueClose(opportunityId, closedAt, closeReason);

    const queueLengths = queue.getQueueLengths();
    expect(queueLengths.lastSeen).toBe(0);
    expect(queueLengths.close).toBe(1);
  });

  it('should track recent updates in ring buffer', () => {
    const opportunityId = BigInt(1);
    const lastSeenAt = new Date();
    const maxSpreadBps = 25.5;

    queue.enqueueLastSeen(opportunityId, lastSeenAt, maxSpreadBps);

    const recentLastSeen = queue.getRecentLastSeen();
    expect(recentLastSeen).toHaveLength(1);
    expect(recentLastSeen[0].opportunityId).toBe(opportunityId);
    expect(recentLastSeen[0].maxSpreadBps).toBe(maxSpreadBps);
  });

  it('should flush updates in background', async () => {
    const opportunityId = BigInt(1);
    const lastSeenAt = new Date();
    const maxSpreadBps = 25.5;

    queue.start();
    queue.enqueueLastSeen(opportunityId, lastSeenAt, maxSpreadBps);

    expect(queue.getQueueLengths().lastSeen).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(queue.getQueueLengths().lastSeen).toBe(0);
  });

  it('should handle mixed update types', () => {
    queue.enqueueLastSeen(BigInt(1), new Date(), 25.5);
    queue.enqueueClose(BigInt(2), new Date(), 'spread_below_threshold');
    queue.enqueueLastSeen(BigInt(3), new Date(), 30.0);

    const queueLengths = queue.getQueueLengths();
    expect(queueLengths.lastSeen).toBe(2);
    expect(queueLengths.close).toBe(1);
  });

  it('should clear queue on stop', async () => {
    queue.enqueueLastSeen(BigInt(1), new Date(), 25.5);
    queue.enqueueClose(BigInt(2), new Date(), 'spread_below_threshold');

    expect(queue.getQueueLengths().lastSeen).toBe(1);
    expect(queue.getQueueLengths().close).toBe(1);

    await queue.stop();

    expect(queue.getQueueLengths().lastSeen).toBe(0);
    expect(queue.getQueueLengths().close).toBe(0);
  });
});
