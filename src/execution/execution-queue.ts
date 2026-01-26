import { randomUUID } from 'crypto';
import { createChildLogger, type Logger } from '../utils/logger.js';
import { insertExecution, updateExecutionStatus, type Execution } from '../persistence/executions.js';
import { updateOpportunityStatus } from '../persistence/opportunities.js';
import type { OpportunityStatus } from '../types/index.js';

interface ExecutionInsert {
  type: 'insert';
  clientId: string;
  execution: Execution;
  enqueuedAt: number;
}

interface ExecutionStatusUpdate {
  type: 'status';
  clientId: string;
  update: ExecutionStatusPayload;
  enqueuedAt: number;
}

interface OpportunityStatusUpdate {
  type: 'opportunity';
  opportunityId: bigint;
  status: OpportunityStatus;
  reason?: string;
  estimatedProfitUsd?: number;
  enqueuedAt: number;
}

export interface ExecutionStatusPayload {
  status: string;
  confirmedAt?: Date;
  gasUsed?: number;
  gasCostUsd?: number;
  actualOutput?: bigint;
  actualOutputHuman?: number;
  realizedPrice?: number;
  realizedSlippageBps?: number;
  realizedPnlUsd?: number;
  revertReason?: string;
  errorMessage?: string;
}

type QueueItem = ExecutionInsert | ExecutionStatusUpdate | OpportunityStatusUpdate;

const FLUSH_INTERVAL_MS = 100;

export class ExecutionQueue {
  private logger: Logger;
  private queue: QueueItem[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;
  private clientIdToDbId = new Map<string, bigint>();
  private pendingStatusUpdates = new Map<string, ExecutionStatusUpdate[]>();

  constructor() {
    this.logger = createChildLogger({ component: 'execution-queue' });
  }

  generateClientId(): string {
    return randomUUID();
  }

  enqueueExecution(clientId: string, execution: Execution): void {
    const item: ExecutionInsert = {
      type: 'insert',
      clientId,
      execution,
      enqueuedAt: Date.now(),
    };
    this.queue.push(item);
  }

  enqueueExecutionStatus(clientId: string, update: ExecutionStatusPayload): void {
    const dbId = this.clientIdToDbId.get(clientId);
    if (dbId) {
      const item: ExecutionStatusUpdate = {
        type: 'status',
        clientId,
        update,
        enqueuedAt: Date.now(),
      };
      this.queue.push(item);
    } else {
      const pending = this.pendingStatusUpdates.get(clientId) || [];
      pending.push({
        type: 'status',
        clientId,
        update,
        enqueuedAt: Date.now(),
      });
      this.pendingStatusUpdates.set(clientId, pending);
    }
  }

  enqueueOpportunityStatus(
    opportunityId: bigint,
    status: OpportunityStatus,
    reason?: string,
    estimatedProfitUsd?: number
  ): void {
    const item: OpportunityStatusUpdate = {
      type: 'opportunity',
      opportunityId,
      status,
      reason,
      estimatedProfitUsd,
      enqueuedAt: Date.now(),
    };
    this.queue.push(item);
  }

  start(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.logger.info('Execution queue started');
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.logger.info('Execution queue stopped');
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getPendingCount(): number {
    let count = 0;
    for (const updates of this.pendingStatusUpdates.values()) {
      count += updates.length;
    }
    return count;
  }

  private async flush(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const batch = this.queue.splice(0, this.queue.length);

    const inserts = batch.filter((item): item is ExecutionInsert => item.type === 'insert');
    const statusUpdates = batch.filter((item): item is ExecutionStatusUpdate => item.type === 'status');
    const opportunityUpdates = batch.filter((item): item is OpportunityStatusUpdate => item.type === 'opportunity');

    const insertResults = await Promise.allSettled(
      inserts.map(async (item) => {
        const dbId = await insertExecution(item.execution);
        this.clientIdToDbId.set(item.clientId, dbId);
        this.processPendingStatusUpdates(item.clientId);
        return { clientId: item.clientId, dbId };
      })
    );

    const insertFailures = insertResults.filter((r) => r.status === 'rejected');
    if (insertFailures.length > 0) {
      this.logger.warn(
        { failureCount: insertFailures.length, batchSize: inserts.length },
        'Some execution inserts failed'
      );
    }

    const statusResults = await Promise.allSettled(
      statusUpdates.map(async (item) => {
        const dbId = this.clientIdToDbId.get(item.clientId);
        if (!dbId) {
          throw new Error(`No DB ID found for client ID: ${item.clientId}`);
        }
        await updateExecutionStatus(dbId, item.update);
      })
    );

    const statusFailures = statusResults.filter((r) => r.status === 'rejected');
    if (statusFailures.length > 0) {
      this.logger.warn(
        { failureCount: statusFailures.length, batchSize: statusUpdates.length },
        'Some execution status updates failed'
      );
    }

    const opportunityResults = await Promise.allSettled(
      opportunityUpdates.map((item) =>
        updateOpportunityStatus(item.opportunityId, item.status, item.reason, item.estimatedProfitUsd)
      )
    );

    const opportunityFailures = opportunityResults.filter((r) => r.status === 'rejected');
    if (opportunityFailures.length > 0) {
      this.logger.warn(
        { failureCount: opportunityFailures.length, batchSize: opportunityUpdates.length },
        'Some opportunity status updates failed'
      );
    }

    this.isProcessing = false;
  }

  private processPendingStatusUpdates(clientId: string): void {
    const pending = this.pendingStatusUpdates.get(clientId);
    if (pending && pending.length > 0) {
      this.queue.push(...pending);
      this.pendingStatusUpdates.delete(clientId);
    }
  }
}
