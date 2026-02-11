import { createChildLogger } from '../../utils/logger.js';
import { toMicros, fromMicros, mulDiv } from './money.js';
import { PerpsPersistence } from './perps-persistence.js';
import { symbolToAsset, closingSide } from './types.js';
import type { PerpsPosition, PerpsExchangeClient } from './types.js';

const log = createChildLogger({ component: 'position-tracker' });

export class PositionTracker {
  private positions = new Map<string, PerpsPosition>();
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private lockTail: Promise<void> = Promise.resolve();

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const prev = this.lockTail;
    this.lockTail = gate;
    return prev.then(async () => { try { return await fn(); } finally { release!(); } });
  }

  constructor(
    private readonly client: PerpsExchangeClient,
    private readonly persistence: PerpsPersistence,
  ) {}

  async reconcileOnStartup(): Promise<void> {
    return this.withLock(async () => {
      const dbOpen = await this.persistence.getOpenExecutions();
      const exchangePositions = await this.client.getPositions();
      const exchangeMap = new Map<string, typeof exchangePositions[0]>();
      for (const ep of exchangePositions) {
        exchangeMap.set(ep.symbol, ep);
      }

      for (const exec of dbOpen) {
        const ep = exchangeMap.get(exec.symbol);

        if (exec.status === 'pending_open') {
          if (ep && !this.client.isPaperMode()) {
            log.info({ asset: exec.asset, clientOrderId: exec.clientOrderId }, 'Adopting pending_open position (exchange confirms)');
            const markPriceStr = ep.markPrice ?? exec.entryPrice;
            const notionalUsd = fromMicros(mulDiv(toMicros(markPriceStr), toMicros(ep.qty)));
            await this.persistence.updateExecutionEntry(exec.clientOrderId, {
              status: 'open',
              entryPrice: ep.entryPrice ?? exec.entryPrice,
              quantity: ep.qty,
              notionalUsd,
              entryOrderId: exec.entryOrderId ?? 'reconciled',
            });
            this.positions.set(exec.asset, {
              symbol: exec.symbol,
              asset: exec.asset,
              direction: exec.direction,
              side: exec.side,
              quantity: ep.qty,
              entryPrice: ep.entryPrice ?? exec.entryPrice,
              markPrice: markPriceStr,
              unrealizedPnl: ep.unrealizedPnl ?? '0',
              notionalUsd,
              leverage: exec.leverage,
              marginType: exec.marginType,
              clientOrderId: exec.clientOrderId,
              openedAt: exec.signalTimestamp,
              peakPnlBps: 0,
              trailingActivated: false,
            });
            exchangeMap.delete(exec.symbol);
          } else if (this.client.isPaperMode()) {
            await this.persistence.updateExecution(exec.clientOrderId, { status: 'open' });
            const notionalUsd = fromMicros(mulDiv(toMicros(exec.entryPrice), toMicros(exec.quantity)));
            this.positions.set(exec.asset, {
              symbol: exec.symbol,
              asset: exec.asset,
              direction: exec.direction,
              side: exec.side,
              quantity: exec.quantity,
              entryPrice: exec.entryPrice,
              markPrice: exec.entryPrice,
              unrealizedPnl: '0',
              notionalUsd,
              leverage: exec.leverage,
              marginType: exec.marginType,
              clientOrderId: exec.clientOrderId,
              openedAt: exec.signalTimestamp,
              peakPnlBps: 0,
              trailingActivated: false,
            });
          } else {
            log.warn({ asset: exec.asset, clientOrderId: exec.clientOrderId }, 'pending_open with no exchange position, marking failed');
            await this.persistence.updateExecution(exec.clientOrderId, { status: 'failed', exitReason: 'no_fill_on_reconcile' });
          }
          continue;
        }

        if (exec.status === 'closing') {
          if (ep && !this.client.isPaperMode()) {
            log.warn({ asset: exec.asset, clientOrderId: exec.clientOrderId }, 'Closing position still has exchange size, retrying close');
            const markPriceStr = ep.markPrice ?? exec.entryPrice;
            const notionalUsd = fromMicros(mulDiv(toMicros(markPriceStr), toMicros(ep.qty)));
            this.positions.set(exec.asset, {
              symbol: exec.symbol,
              asset: exec.asset,
              direction: exec.direction,
              side: exec.side,
              quantity: ep.qty,
              entryPrice: exec.entryPrice,
              markPrice: markPriceStr,
              unrealizedPnl: ep.unrealizedPnl ?? '0',
              notionalUsd,
              leverage: exec.leverage,
              marginType: exec.marginType,
              clientOrderId: exec.clientOrderId,
              openedAt: exec.signalTimestamp,
              peakPnlBps: 0,
              trailingActivated: false,
            });
            exchangeMap.delete(exec.symbol);
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

        if (!ep && !this.client.isPaperMode()) {
          log.warn({ asset: exec.asset, clientOrderId: exec.clientOrderId }, 'DB open but no exchange position, marking closed');
          await this.persistence.updateExecution(exec.clientOrderId, {
            status: 'closed',
            exitReason: 'reconciliation',
            realizedPnl: '0',
          });
        } else {
          const markPriceStr = ep?.markPrice ?? exec.entryPrice;
          const qtyStr = ep?.qty ?? exec.quantity;

          if (ep && !this.client.isPaperMode()) {
            const exchangeIsLong = ep.side === 'LONG';
            const dbIsLong = exec.direction === 'long';
            if (exchangeIsLong !== dbIsLong) {
              log.error({
                asset: exec.asset,
                dbDirection: exec.direction,
                exchangeSide: ep.side,
              }, 'RECONCILIATION ANOMALY: direction mismatch — flattening position');
              try {
                const side = closingSide(exchangeIsLong ? 'long' : 'short');
                await this.client.placeOrder({
                  symbol: exec.symbol,
                  side,
                  quantity: ep.qty,
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

            if (ep.leverage !== undefined && ep.leverage !== exec.leverage) {
              log.warn({
                asset: exec.asset,
                dbLeverage: exec.leverage,
                exchangeLeverage: ep.leverage,
              }, 'Leverage mismatch, adopting exchange value');
            }
          }

          const notionalUsd = fromMicros(mulDiv(toMicros(markPriceStr), toMicros(qtyStr)));
          this.positions.set(exec.asset, {
            symbol: exec.symbol,
            asset: exec.asset,
            direction: exec.direction,
            side: exec.side,
            quantity: qtyStr,
            entryPrice: exec.entryPrice,
            markPrice: markPriceStr,
            unrealizedPnl: ep?.unrealizedPnl ?? '0',
            notionalUsd,
            leverage: exec.leverage,
            marginType: exec.marginType,
            clientOrderId: exec.clientOrderId,
            openedAt: exec.signalTimestamp,
            peakPnlBps: 0,
            trailingActivated: false,
          });
          exchangeMap.delete(exec.symbol);
        }
      }

      for (const [symbol, ep] of exchangeMap) {
        const asset = symbolToAsset(symbol);
        if (asset) {
          log.warn({ symbol, asset, qty: ep.qty, side: ep.side }, 'Exchange position not in DB (external/unmanaged)');
        }
      }

      log.info({ trackedCount: this.positions.size, dbOpen: dbOpen.length }, 'Startup reconciliation complete');
    });
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
    return this.withLock(async () => {
      const exchangePositions = await this.client.getPositions();
      for (const [asset, pos] of this.positions) {
        const ep = exchangePositions.find(p => p.symbol === pos.symbol);
        if (!ep) {
          log.warn({ asset, symbol: pos.symbol }, 'Tracked position no longer on exchange');
          this.positions.delete(asset);
          await this.persistence.updateExecution(pos.clientOrderId, {
            status: 'closed',
            exitReason: 'reconciliation',
          });
          continue;
        }

        const exchangeIsLong = ep.side === 'LONG';
        const trackedIsLong = pos.direction === 'long';
        if (exchangeIsLong !== trackedIsLong) {
          log.error({ asset, trackedDirection: pos.direction, exchangeSide: ep.side }, 'Sync direction mismatch — removing from tracker');
          this.positions.delete(asset);
          await this.persistence.updateExecution(pos.clientOrderId, {
            status: 'closed',
            exitReason: 'reconciliation_mismatch',
          });
          continue;
        }

        pos.quantity = ep.qty;
        pos.markPrice = ep.markPrice ?? pos.markPrice;
        pos.unrealizedPnl = ep.unrealizedPnl ?? '0';
        pos.notionalUsd = fromMicros(mulDiv(toMicros(pos.markPrice), toMicros(ep.qty)));
      }
    });
  }

  async openPosition(pos: PerpsPosition): Promise<void> {
    return this.withLock(async () => {
      this.positions.set(pos.asset, pos);
    });
  }

  async closePosition(asset: string): Promise<PerpsPosition | undefined> {
    return this.withLock(async () => {
      const pos = this.positions.get(asset);
      if (pos) this.positions.delete(asset);
      return pos;
    });
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

  getTotalExposureUsd(): string {
    let totalMicros = 0n;
    for (const pos of this.positions.values()) {
      totalMicros += toMicros(pos.notionalUsd);
    }
    return fromMicros(totalMicros);
  }

  hasPosition(asset: string): boolean {
    return this.positions.has(asset);
  }

  updateMarkPrice(asset: string, markPrice: number): void {
    const pos = this.positions.get(asset);
    if (!pos) return;
    const markStr = String(markPrice);
    pos.markPrice = markStr;
    const entryMicros = toMicros(pos.entryPrice);
    const markMicros = toMicros(markStr);
    const qtyMicros = toMicros(pos.quantity);
    const diffMicros = pos.direction === 'long'
      ? markMicros - entryMicros
      : entryMicros - markMicros;
    pos.unrealizedPnl = fromMicros(mulDiv(diffMicros, qtyMicros));
    pos.notionalUsd = fromMicros(mulDiv(markMicros, qtyMicros));
  }
}
