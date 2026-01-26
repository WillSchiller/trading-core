import { createChildLogger, type Logger } from '../utils/logger.js';
import { updateOpportunityStatus } from '../persistence/opportunities.js';
import type { OpportunityStatus } from '../types/index.js';

interface StatusUpdate {
  opportunityId: bigint;
  status: OpportunityStatus;
  reason?: string;
  estimatedProfitUsd?: number;
  enqueuedAt: number;
}

const RING_BUFFER_SIZE = 100;
const FLUSH_INTERVAL_MS = 100;

export class StatusQueue {
  private logger: Logger;
  private queue: StatusUpdate[] = [];
  private recentStatuses: StatusUpdate[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;

  constructor() {
    this.logger = createChildLogger({ component: 'status-queue' });
  }

  enqueue(
    opportunityId: bigint,
    status: OpportunityStatus,
    reason?: string,
    estimatedProfitUsd?: number
  ): void {
    const update: StatusUpdate = {
      opportunityId,
      status,
      reason,
      estimatedProfitUsd,
      enqueuedAt: Date.now(),
    };
    this.queue.push(update);
    this.addToRingBuffer(update);
  }

  start(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.logger.info('Status queue started');
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.logger.info('Status queue stopped');
  }

  getRecentStatuses(): StatusUpdate[] {
    return [...this.recentStatuses];
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  private addToRingBuffer(update: StatusUpdate): void {
    this.recentStatuses.push(update);
    if (this.recentStatuses.length > RING_BUFFER_SIZE) {
      this.recentStatuses.shift();
    }
  }

  private async flush(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const batch = this.queue.splice(0, this.queue.length);

    const results = await Promise.allSettled(
      batch.map((update) =>
        updateOpportunityStatus(
          update.opportunityId,
          update.status,
          update.reason,
          update.estimatedProfitUsd
        )
      )
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      this.logger.warn(
        { failureCount: failures.length, batchSize: batch.length },
        'Some status updates failed'
      );
    }

    this.isProcessing = false;
  }
}
