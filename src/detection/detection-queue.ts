import { createChildLogger, type Logger } from '../utils/logger.js';
import {
  updateOpportunityLastSeen,
  closeOpportunity,
} from '../persistence/opportunities.js';

interface LastSeenUpdate {
  opportunityId: bigint;
  lastSeenAt: Date;
  maxSpreadBps: number;
  enqueuedAt: number;
}

interface CloseUpdate {
  opportunityId: bigint;
  closedAt: Date;
  closeReason: string;
  enqueuedAt: number;
}

const RING_BUFFER_SIZE = 100;
const FLUSH_INTERVAL_MS = 100;

export class DetectionQueue {
  private logger: Logger;
  private lastSeenQueue: LastSeenUpdate[] = [];
  private closeQueue: CloseUpdate[] = [];
  private recentLastSeen: LastSeenUpdate[] = [];
  private recentCloses: CloseUpdate[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;

  constructor() {
    this.logger = createChildLogger({ component: 'detection-queue' });
  }

  enqueueLastSeen(opportunityId: bigint, lastSeenAt: Date, maxSpreadBps: number): void {
    const update: LastSeenUpdate = {
      opportunityId,
      lastSeenAt,
      maxSpreadBps,
      enqueuedAt: Date.now(),
    };
    this.lastSeenQueue.push(update);
    this.addToRingBuffer(this.recentLastSeen, update);
  }

  enqueueClose(opportunityId: bigint, closedAt: Date, closeReason: string): void {
    const update: CloseUpdate = {
      opportunityId,
      closedAt,
      closeReason,
      enqueuedAt: Date.now(),
    };
    this.closeQueue.push(update);
    this.addToRingBuffer(this.recentCloses, update);
  }

  start(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.logger.info('Detection queue started');
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.logger.info('Detection queue stopped');
  }

  getRecentLastSeen(): LastSeenUpdate[] {
    return [...this.recentLastSeen];
  }

  getRecentCloses(): CloseUpdate[] {
    return [...this.recentCloses];
  }

  getQueueLengths(): { lastSeen: number; close: number } {
    return {
      lastSeen: this.lastSeenQueue.length,
      close: this.closeQueue.length,
    };
  }

  private addToRingBuffer<T>(buffer: T[], update: T): void {
    buffer.push(update);
    if (buffer.length > RING_BUFFER_SIZE) {
      buffer.shift();
    }
  }

  private async flush(): Promise<void> {
    if (this.isProcessing || (this.lastSeenQueue.length === 0 && this.closeQueue.length === 0)) {
      return;
    }

    this.isProcessing = true;

    const lastSeenBatch = this.lastSeenQueue.splice(0, this.lastSeenQueue.length);
    const closeBatch = this.closeQueue.splice(0, this.closeQueue.length);

    const lastSeenResults = await Promise.allSettled(
      lastSeenBatch.map((update) =>
        updateOpportunityLastSeen(update.opportunityId, update.lastSeenAt, update.maxSpreadBps)
      )
    );

    const closeResults = await Promise.allSettled(
      closeBatch.map((update) =>
        closeOpportunity(update.opportunityId, update.closedAt, update.closeReason)
      )
    );

    const lastSeenFailures = lastSeenResults.filter((r) => r.status === 'rejected');
    const closeFailures = closeResults.filter((r) => r.status === 'rejected');

    if (lastSeenFailures.length > 0) {
      this.logger.warn(
        { failureCount: lastSeenFailures.length, batchSize: lastSeenBatch.length },
        'Some last_seen updates failed'
      );
    }

    if (closeFailures.length > 0) {
      this.logger.warn(
        { failureCount: closeFailures.length, batchSize: closeBatch.length },
        'Some close updates failed'
      );
    }

    this.isProcessing = false;
  }
}
