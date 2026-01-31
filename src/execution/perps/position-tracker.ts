import { createChildLogger } from '../../utils/logger.js';
import { BinanceFuturesClient } from './binance-client.js';
import { PerpsPersistence } from './perps-persistence.js';
import { symbolToAsset, closingSide } from './types.js';
import type { PerpsPosition } from './types.js';

const log = createChildLogger({ component: 'position-tracker' });

export class PositionTracker {
  private positions = new Map<string, PerpsPosition>();
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private mutex = false;

  constructor(
    private readonly client: BinanceFuturesClient,
    private readonly persistence: PerpsPersistence,
  ) {}

  async reconcileOnStartup(): Promise<void> {
    await this.acquireMutex();
    try {
      // C1: getOpenExecutions now returns pending_open, open, and closing
      const dbOpen = await this.persistence.getOpenExecutions();
      const exchangePositions = await this.client.getPositionRisk();
      const exchangeMap = new Map<string, typeof exchangePositions[0]>();
      for (const ep of exchangePositions) {
        const amt = parseFloat(ep.positionAmt);
        if (amt !== 0) {
          exchangeMap.set(ep.symbol, ep);
        }
      }

      for (const exec of dbOpen) {
        const ep = exchangeMap.get(exec.symbol);

        // C3: Handle pending_open — check if order actually filled on exchange
        if (exec.status === 'pending_open') {
          if (ep && !this.client.isPaperMode()) {
            log.info({ asset: exec.asset, clientOrderId: exec.clientOrderId }, 'Adopting pending_open position (exchange confirms)');
            const markPrice = parseFloat(ep.markPrice);
            const amt = Math.abs(parseFloat(ep.positionAmt));
            await this.persistence.updateExecutionEntry(exec.clientOrderId, {
              status: 'open',
              entryPrice: ep.entryPrice,
              quantity: String(amt),
              notionalUsd: String(markPrice * amt),
              entryOrderId: exec.entryOrderId ?? 'reconciled',
            });
            this.positions.set(exec.asset, {
              symbol: exec.symbol,
              asset: exec.asset,
              direction: exec.direction,
              side: exec.side,
              quantity: amt,
              entryPrice: parseFloat(ep.entryPrice),
              markPrice,
              unrealizedPnl: parseFloat(ep.unRealizedProfit),
              notionalUsd: markPrice * amt,
              leverage: exec.leverage,
              marginType: exec.marginType,
              clientOrderId: exec.clientOrderId,
              openedAt: exec.signalTimestamp,
            });
            exchangeMap.delete(exec.symbol);
          } else if (this.client.isPaperMode()) {
            await this.persistence.updateExecution(exec.clientOrderId, { status: 'open' });
            this.positions.set(exec.asset, {
              symbol: exec.symbol,
              asset: exec.asset,
              direction: exec.direction,
              side: exec.side,
              quantity: Number(exec.quantity),
              entryPrice: Number(exec.entryPrice),
              markPrice: Number(exec.entryPrice),
              unrealizedPnl: 0,
              notionalUsd: Number(exec.entryPrice) * Number(exec.quantity),
              leverage: exec.leverage,
              marginType: exec.marginType,
              clientOrderId: exec.clientOrderId,
              openedAt: exec.signalTimestamp,
            });
          } else {
            log.warn({ asset: exec.asset, clientOrderId: exec.clientOrderId }, 'pending_open with no exchange position, marking failed');
            await this.persistence.updateExecution(exec.clientOrderId, { status: 'failed', exitReason: 'no_fill_on_reconcile' });
          }
          continue;
        }

        // C1: Handle closing status — needs to finish closing
        if (exec.status === 'closing') {
          if (ep && parseFloat(ep.positionAmt) !== 0 && !this.client.isPaperMode()) {
            log.warn({ asset: exec.asset, clientOrderId: exec.clientOrderId }, 'Closing position still has exchange size, retrying close');
            this.positions.set(exec.asset, {
              symbol: exec.symbol,
              asset: exec.asset,
              direction: exec.direction,
              side: exec.side,
              quantity: Math.abs(parseFloat(ep.positionAmt)),
              entryPrice: Number(exec.entryPrice),
              markPrice: parseFloat(ep.markPrice),
              unrealizedPnl: parseFloat(ep.unRealizedProfit),
              notionalUsd: Math.abs(parseFloat(ep.notional)),
              leverage: exec.leverage,
              marginType: exec.marginType,
              clientOrderId: exec.clientOrderId,
              openedAt: exec.signalTimestamp,
            });
            exchangeMap.delete(exec.symbol);
            // Revert to open so the executor or kill switch can re-attempt close
            await this.persistence.updateExecution(exec.clientOrderId, { status: 'open' });
          } else {
            log.info({ asset: exec.asset, clientOrderId: exec.clientOrderId }, 'Closing position gone from exchange, marking closed');
            await this.persistence.updateExecution(exec.clientOrderId, {
              status: 'closed',
              exitReason: 'reconciliation',
              realizedPnl: '0',
            });
          }
          continue;
        }

        // Normal open status
        if (!ep && !this.client.isPaperMode()) {
          log.warn({ asset: exec.asset, clientOrderId: exec.clientOrderId }, 'DB open but no exchange position, marking closed');
          await this.persistence.updateExecution(exec.clientOrderId, {
            status: 'closed',
            exitReason: 'reconciliation',
            realizedPnl: '0',
          });
        } else {
          const markPrice = ep ? parseFloat(ep.markPrice) : Number(exec.entryPrice);
          const amt = ep ? Math.abs(parseFloat(ep.positionAmt)) : Number(exec.quantity);

          // H1: Verify direction matches exchange
          if (ep && !this.client.isPaperMode()) {
            const exchangeAmt = parseFloat(ep.positionAmt);
            const exchangeIsLong = exchangeAmt > 0;
            const dbIsLong = exec.direction === 'long';
            if (exchangeIsLong !== dbIsLong) {
              log.error({
                asset: exec.asset,
                dbDirection: exec.direction,
                exchangeAmt: ep.positionAmt,
              }, 'RECONCILIATION ANOMALY: direction mismatch — flattening position');
              // Flatten: close the exchange position, mark DB as closed
              try {
                const side = closingSide(exchangeIsLong ? 'long' : 'short');
                await this.client.placeOrder({
                  symbol: exec.symbol,
                  side,
                  quantity: Math.abs(exchangeAmt),
                  clientOrderId: `recon_${Date.now()}_${exec.asset}`,
                  reduceOnly: true,
                });
              } catch (err) {
                log.error({ error: (err as Error).message }, 'Failed to flatten mismatched position');
              }
              await this.persistence.updateExecution(exec.clientOrderId, {
                status: 'closed',
                exitReason: 'reconciliation_mismatch',
              });
              exchangeMap.delete(exec.symbol);
              continue;
            }

            // H1: Verify leverage matches
            const exchangeLeverage = parseInt(ep.leverage, 10);
            if (exchangeLeverage !== exec.leverage) {
              log.warn({
                asset: exec.asset,
                dbLeverage: exec.leverage,
                exchangeLeverage,
              }, 'Leverage mismatch, adopting exchange value');
            }
          }

          this.positions.set(exec.asset, {
            symbol: exec.symbol,
            asset: exec.asset,
            direction: exec.direction,
            side: exec.side,
            quantity: amt,
            entryPrice: Number(exec.entryPrice),
            markPrice,
            unrealizedPnl: ep ? parseFloat(ep.unRealizedProfit) : 0,
            notionalUsd: markPrice * amt,
            leverage: exec.leverage,
            marginType: exec.marginType,
            clientOrderId: exec.clientOrderId,
            openedAt: exec.signalTimestamp,
          });
          exchangeMap.delete(exec.symbol);
        }
      }

      // Warn about external positions but filter to managed symbols only
      for (const [symbol, ep] of exchangeMap) {
        const asset = symbolToAsset(symbol);
        if (asset) {
          log.warn({ symbol, asset, positionAmt: ep.positionAmt }, 'Exchange position not in DB (external/unmanaged)');
        }
      }

      log.info({ trackedCount: this.positions.size, dbOpen: dbOpen.length }, 'Startup reconciliation complete');
    } finally {
      this.releaseMutex();
    }
  }

  startPeriodicSync(intervalMs: number): void {
    this.syncInterval = setInterval(() => {
      this.sync().catch(err => log.error({ error: (err as Error).message }, 'Position sync failed'));
    }, intervalMs);
  }

  stopPeriodicSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  async sync(): Promise<void> {
    if (this.client.isPaperMode()) return;
    await this.acquireMutex();
    try {
      const exchangePositions = await this.client.getPositionRisk();
      for (const [asset, pos] of this.positions) {
        const ep = exchangePositions.find(p => p.symbol === pos.symbol);
        if (!ep || parseFloat(ep.positionAmt) === 0) {
          log.warn({ asset, symbol: pos.symbol }, 'Tracked position no longer on exchange');
          this.positions.delete(asset);
          await this.persistence.updateExecution(pos.clientOrderId, {
            status: 'closed',
            exitReason: 'reconciliation',
          });
          continue;
        }

        // H1: Check direction hasn't flipped
        const exchangeAmt = parseFloat(ep.positionAmt);
        const exchangeIsLong = exchangeAmt > 0;
        const trackedIsLong = pos.direction === 'long';
        if (exchangeIsLong !== trackedIsLong) {
          log.error({ asset, trackedDirection: pos.direction, exchangeAmt: ep.positionAmt }, 'Sync direction mismatch — removing from tracker');
          this.positions.delete(asset);
          await this.persistence.updateExecution(pos.clientOrderId, {
            status: 'closed',
            exitReason: 'reconciliation_mismatch',
          });
          continue;
        }

        pos.markPrice = parseFloat(ep.markPrice);
        pos.unrealizedPnl = parseFloat(ep.unRealizedProfit);
        pos.notionalUsd = Math.abs(parseFloat(ep.notional));
        pos.quantity = Math.abs(exchangeAmt);
      }
    } finally {
      this.releaseMutex();
    }
  }

  async openPosition(pos: PerpsPosition): Promise<void> {
    await this.acquireMutex();
    try {
      this.positions.set(pos.asset, pos);
    } finally {
      this.releaseMutex();
    }
  }

  async closePosition(asset: string): Promise<PerpsPosition | undefined> {
    await this.acquireMutex();
    try {
      const pos = this.positions.get(asset);
      if (pos) this.positions.delete(asset);
      return pos;
    } finally {
      this.releaseMutex();
    }
  }

  getPosition(asset: string): PerpsPosition | undefined {
    return this.positions.get(asset);
  }

  getOpenPositions(): PerpsPosition[] {
    return Array.from(this.positions.values());
  }

  getOpenCount(): number {
    return this.positions.size;
  }

  getTotalExposureUsd(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.notionalUsd;
    }
    return total;
  }

  hasPosition(asset: string): boolean {
    return this.positions.has(asset);
  }

  updateMarkPrice(asset: string, markPrice: number): void {
    const pos = this.positions.get(asset);
    if (!pos) return;
    pos.markPrice = markPrice;
    const priceDiff = pos.direction === 'long'
      ? markPrice - pos.entryPrice
      : pos.entryPrice - markPrice;
    pos.unrealizedPnl = priceDiff * pos.quantity;
    pos.notionalUsd = markPrice * pos.quantity;
  }

  private async acquireMutex(): Promise<void> {
    while (this.mutex) {
      await new Promise(r => setTimeout(r, 10));
    }
    this.mutex = true;
  }

  private releaseMutex(): void {
    this.mutex = false;
  }
}
