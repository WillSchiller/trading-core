import { EventEmitter } from 'node:events';
import type { Opportunity } from '../types/index.js';
import { createChildLogger, type Logger } from '../utils/logger.js';

export interface OpportunityDetectedEvent {
  opportunity: Opportunity;
}

export interface OpportunityExpiredEvent {
  pairId: number;
  chain: string;
  reason: string;
}

export class OpportunityEmitter extends EventEmitter {
  private logger: Logger;

  constructor() {
    super();
    this.logger = createChildLogger({ component: 'opportunity-emitter' });
  }

  public emitOpportunityDetected(opportunity: Opportunity): void {
    this.logger.info(
      {
        pairId: opportunity.pairId,
        chain: opportunity.chain,
        spreadBps: opportunity.spreadBps,
        direction: opportunity.direction,
        dexBlock: opportunity.dexBlockNumber?.toString(),
        reasonCodes: opportunity.reasonCodes,
      },
      'Opportunity detected'
    );

    this.emit('opportunity:detected', { opportunity });
  }

  public emitOpportunityExpired(pairId: number, chain: string, reason: string): void {
    this.logger.debug(
      {
        pairId,
        chain,
        reason,
      },
      'Opportunity expired'
    );

    this.emit('opportunity:expired', { pairId, chain, reason });
  }

  public onOpportunityDetected(
    handler: (event: OpportunityDetectedEvent) => void | Promise<void>
  ): void {
    this.on('opportunity:detected', handler);
  }

  public onOpportunityExpired(
    handler: (event: OpportunityExpiredEvent) => void | Promise<void>
  ): void {
    this.on('opportunity:expired', handler);
  }
}
