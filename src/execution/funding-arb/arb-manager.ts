import pg from 'pg';
import { createChildLogger } from '../../utils/logger.js';
import { FundingScanner } from './funding-scanner.js';
import type { FundingArbConfig, FundingArbPosition, FundingOpportunity } from './types.js';

const log = createChildLogger({ component: 'funding-arb' });

export class FundingArbManager {
  private config: FundingArbConfig;
  private scanner: FundingScanner;
  private pool: pg.Pool;
  private positions = new Map<string, FundingArbPosition>(); // asset → position
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: FundingArbConfig, pool: pg.Pool) {
    this.config = config;
    this.pool = pool;
    this.scanner = new FundingScanner(config);
  }

  async start(): Promise<void> {
    await this.scanner.start();
    await this.loadPositions();

    this.rotationTimer = setInterval(
      () => this.evaluateRotations().catch(e => log.error({ err: e }, 'Rotation check error')),
      this.config.rotationCheckIntervalMs,
    );

    this.persistTimer = setInterval(
      () => this.persistSnapshot().catch(e => log.error({ err: e }, 'Persist error')),
      60_000,
    );

    // Initial evaluation after 10s to let scanner populate
    setTimeout(() => this.evaluateRotations().catch(e => log.error({ err: e }, 'Initial rotation error')), 10_000);

    log.info({
      paperMode: this.config.paperMode,
      maxPositions: this.config.maxPositions,
      positionSizeUsd: this.config.positionSizeUsd,
      minApy: this.config.minAnnualizedPct,
    }, 'Funding arb manager started');
  }

  stop(): void {
    this.scanner.stop();
    if (this.rotationTimer) { clearInterval(this.rotationTimer); this.rotationTimer = null; }
    if (this.persistTimer) { clearInterval(this.persistTimer); this.persistTimer = null; }
  }

  getPositions(): FundingArbPosition[] {
    return Array.from(this.positions.values());
  }

  getScanner(): FundingScanner {
    return this.scanner;
  }

  private async evaluateRotations(): Promise<void> {
    const opps = this.scanner.getOpportunities();
    if (opps.length === 0) return;

    // Check existing positions for exit
    for (const [asset, pos] of this.positions) {
      if (pos.status !== 'open') continue;
      const currentOpp = this.scanner.getOpportunityForAsset(asset);
      const currentApy = currentOpp?.annualizedPct ?? 0;
      pos.hoursHeld = (Date.now() - pos.openedAt) / 3_600_000;

      // Exit if funding dropped below threshold
      if (currentApy < this.config.exitBelowAnnualizedPct) {
        log.info({ asset, currentApy: currentApy.toFixed(1), threshold: this.config.exitBelowAnnualizedPct }, 'Funding dropped — closing position');
        await this.closePosition(asset, 'funding_dropped');
        continue;
      }

      // Check rotation: is there a better asset?
      for (const opp of opps) {
        if (opp.asset === asset) continue;
        if (this.positions.has(opp.asset)) continue;
        const apyGain = opp.annualizedPct - currentApy;
        if (apyGain >= this.config.rotationThresholdPct) {
          log.info({
            from: asset,
            to: opp.asset,
            fromApy: currentApy.toFixed(1),
            toApy: opp.annualizedPct.toFixed(1),
            gain: apyGain.toFixed(1),
          }, 'Rotation opportunity found');
          await this.closePosition(asset, 'rotation');
          await this.openPosition(opp);
          break;
        }
      }
    }

    // Fill empty slots
    const openSlots = this.config.maxPositions - this.countOpenPositions();
    if (openSlots <= 0) return;

    for (const opp of opps) {
      if (this.countOpenPositions() >= this.config.maxPositions) break;
      if (this.positions.has(opp.asset)) continue;
      if (opp.annualizedPct < this.config.minAnnualizedPct) break; // sorted desc, so stop
      if (opp.breakEvenHours > 72) continue; // skip if break-even > 3 days
      await this.openPosition(opp);
    }
  }

  private countOpenPositions(): number {
    let count = 0;
    for (const pos of this.positions.values()) {
      if (pos.status === 'open' || pos.status === 'opening') count++;
    }
    return count;
  }

  private async openPosition(opp: FundingOpportunity): Promise<void> {
    const id = `farb_${Date.now()}_${opp.asset}`;
    const notional = this.config.positionSizeUsd;
    const perpQty = notional / opp.perpMidPrice;
    const spotPrice = opp.spotMidPrice > 0 ? opp.spotMidPrice : 0;
    const spotQty = spotPrice > 0 ? notional / spotPrice : 0;

    const perpFeeBps = this.config.useMakerOrders ? this.config.makerFeeBps : this.config.takerFeeBps;
    const entryFees = (perpFeeBps / 10000) * notional; // perp entry only

    const position: FundingArbPosition = {
      id,
      asset: opp.asset,
      status: 'open',
      perpShortQty: perpQty.toFixed(6),
      perpEntryPrice: opp.perpMidPrice.toFixed(6),
      spotLongQty: spotQty.toFixed(6),
      spotEntryPrice: spotPrice.toFixed(6),
      notionalUsd: notional,
      leverage: this.config.perpLeverage,
      entryFundingRate: opp.currentFundingRate,
      accumulatedFunding: 0,
      entryFeesUsd: entryFees,
      exitFeesUsd: 0,
      realizedPnl: -entryFees, // start negative by entry fees
      spotPnl: 0,
      perpPnl: 0,
      hoursHeld: 0,
      openedAt: Date.now(),
      closedAt: null,
    };

    this.positions.set(opp.asset, position);

    if (this.config.paperMode) {
      log.info({
        asset: opp.asset,
        notional,
        apy: `${opp.annualizedPct.toFixed(1)}%`,
        breakEven: `${opp.breakEvenHours.toFixed(1)}h`,
        entryFees: entryFees.toFixed(2),
        perpPrice: opp.perpMidPrice,
        spotPrice: opp.spotMidPrice,
      }, 'PAPER: Opened funding arb position');
    } else {
      // TODO: implement live execution — place spot buy + perp short
      log.warn({ asset: opp.asset }, 'Live execution not yet implemented');
    }

    await this.persistPosition(position);
  }

  private async closePosition(asset: string, reason: string): Promise<void> {
    const pos = this.positions.get(asset);
    if (!pos) return;

    const opp = this.scanner.getOpportunityForAsset(asset);
    const currentPerpPrice = opp?.perpMidPrice ?? parseFloat(pos.perpEntryPrice);
    const currentSpotPrice = opp?.spotMidPrice ?? parseFloat(pos.spotEntryPrice);

    // Calculate PnL
    const perpEntry = parseFloat(pos.perpEntryPrice);
    const spotEntry = parseFloat(pos.spotEntryPrice);
    const perpQty = parseFloat(pos.perpShortQty);
    const spotQty = parseFloat(pos.spotLongQty);

    // Short perp PnL: (entry - current) * qty
    pos.perpPnl = (perpEntry - currentPerpPrice) * perpQty;
    // Long spot PnL: (current - entry) * qty
    pos.spotPnl = (currentSpotPrice - spotEntry) * spotQty;

    const perpFeeBps = this.config.useMakerOrders ? this.config.makerFeeBps : this.config.takerFeeBps;
    pos.exitFeesUsd = (perpFeeBps / 10000) * pos.notionalUsd;

    pos.realizedPnl = pos.perpPnl + pos.spotPnl + pos.accumulatedFunding - pos.entryFeesUsd - pos.exitFeesUsd;
    pos.status = 'closed';
    pos.closedAt = Date.now();
    pos.hoursHeld = (pos.closedAt - pos.openedAt) / 3_600_000;

    log.info({
      asset,
      reason,
      hoursHeld: pos.hoursHeld.toFixed(1),
      perpPnl: pos.perpPnl.toFixed(4),
      spotPnl: pos.spotPnl.toFixed(4),
      funding: pos.accumulatedFunding.toFixed(4),
      fees: (pos.entryFeesUsd + pos.exitFeesUsd).toFixed(4),
      realizedPnl: pos.realizedPnl.toFixed(4),
    }, 'Closed funding arb position');

    await this.persistPosition(pos);
    this.positions.delete(asset);
  }

  // Simulate funding accrual for paper positions
  async accrueHourlyFunding(): Promise<void> {
    for (const [asset, pos] of this.positions) {
      if (pos.status !== 'open') continue;
      const opp = this.scanner.getOpportunityForAsset(asset);
      if (!opp) continue;

      // Funding accrual: rate * notional (positive rate = we receive as shorts)
      const fundingPayment = opp.currentFundingRate * pos.notionalUsd;
      pos.accumulatedFunding += fundingPayment;

      // Update mark-to-market
      const perpEntry = parseFloat(pos.perpEntryPrice);
      const spotEntry = parseFloat(pos.spotEntryPrice);
      const perpQty = parseFloat(pos.perpShortQty);
      const spotQty = parseFloat(pos.spotLongQty);
      pos.perpPnl = (perpEntry - opp.perpMidPrice) * perpQty;
      pos.spotPnl = (opp.spotMidPrice - spotEntry) * spotQty;

      log.debug({
        asset,
        fundingPayment: fundingPayment.toFixed(6),
        totalFunding: pos.accumulatedFunding.toFixed(4),
        mtmPnl: (pos.perpPnl + pos.spotPnl).toFixed(4),
        rate: opp.currentFundingRate.toFixed(6),
      }, 'Funding accrued');
    }
  }

  private async persistPosition(pos: FundingArbPosition): Promise<void> {
    try {
      await this.pool.query(`
        INSERT INTO funding_arb_positions (
          id, asset, status, perp_short_qty, perp_entry_price,
          spot_long_qty, spot_entry_price, notional_usd, leverage,
          entry_funding_rate, accumulated_funding, entry_fees_usd,
          exit_fees_usd, realized_pnl, spot_pnl, perp_pnl,
          hours_held, opened_at, closed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (id) DO UPDATE SET
          status = $3, accumulated_funding = $11,
          exit_fees_usd = $13, realized_pnl = $14,
          spot_pnl = $15, perp_pnl = $16,
          hours_held = $17, closed_at = $19
      `, [
        pos.id, pos.asset, pos.status, pos.perpShortQty, pos.perpEntryPrice,
        pos.spotLongQty, pos.spotEntryPrice, pos.notionalUsd, pos.leverage,
        pos.entryFundingRate, pos.accumulatedFunding, pos.entryFeesUsd,
        pos.exitFeesUsd, pos.realizedPnl, pos.spotPnl, pos.perpPnl,
        pos.hoursHeld, new Date(pos.openedAt), pos.closedAt ? new Date(pos.closedAt) : null,
      ]);
    } catch (err) {
      log.error({ err, posId: pos.id }, 'Failed to persist position');
    }
  }

  private async persistSnapshot(): Promise<void> {
    const opps = this.scanner.getOpportunities().slice(0, 20);
    if (opps.length === 0) return;

    try {
      const values: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      for (const opp of opps) {
        values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
        params.push(
          new Date(opp.timestamp), opp.asset, opp.currentFundingRate,
          opp.predictedFundingRate, opp.annualizedPct, opp.breakEvenHours,
          opp.spotMidPrice, opp.perpMidPrice, opp.basisBps,
        );
      }

      await this.pool.query(`
        INSERT INTO funding_arb_scans (
          timestamp, asset, current_funding_rate, predicted_funding_rate,
          annualized_pct, break_even_hours, spot_mid_price, perp_mid_price, basis_bps
        ) VALUES ${values.join(',')}
      `, params);
    } catch (err) {
      log.error({ err }, 'Failed to persist scan snapshot');
    }

    // Persist open position snapshots
    for (const pos of this.positions.values()) {
      if (pos.status === 'open') await this.persistPosition(pos);
    }
  }

  private async loadPositions(): Promise<void> {
    try {
      const result = await this.pool.query(`
        SELECT * FROM funding_arb_positions WHERE status = 'open'
      `);
      for (const row of result.rows) {
        const pos: FundingArbPosition = {
          id: row.id,
          asset: row.asset,
          status: row.status,
          perpShortQty: row.perp_short_qty,
          perpEntryPrice: row.perp_entry_price,
          spotLongQty: row.spot_long_qty,
          spotEntryPrice: row.spot_entry_price,
          notionalUsd: parseFloat(row.notional_usd),
          leverage: parseFloat(row.leverage),
          entryFundingRate: parseFloat(row.entry_funding_rate),
          accumulatedFunding: parseFloat(row.accumulated_funding),
          entryFeesUsd: parseFloat(row.entry_fees_usd),
          exitFeesUsd: parseFloat(row.exit_fees_usd),
          realizedPnl: parseFloat(row.realized_pnl),
          spotPnl: parseFloat(row.spot_pnl),
          perpPnl: parseFloat(row.perp_pnl),
          hoursHeld: parseFloat(row.hours_held),
          openedAt: new Date(row.opened_at).getTime(),
          closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null,
        };
        this.positions.set(pos.asset, pos);
      }
      if (this.positions.size > 0) {
        log.info({ count: this.positions.size }, 'Loaded existing positions');
      }
    } catch (err) {
      log.warn({ err }, 'Could not load positions (table may not exist yet)');
    }
  }
}
