import pg from 'pg';
import { createChildLogger } from '../../utils/logger.js';
import { FundingScanner } from './funding-scanner.js';
import type { FundingArbConfig, FundingArbPosition, FundingOpportunity } from './types.js';

const log = createChildLogger({ component: 'funding-arb' });

const HOURS_PER_YEAR = 8760;
const MIN_SAMPLES_TO_ENTER = 10;

export class FundingArbManager {
  private config: FundingArbConfig;
  private scanner: FundingScanner;
  private pool: pg.Pool;
  private positions = new Map<string, FundingArbPosition>();
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

  getPositions(): FundingArbPosition[] { return Array.from(this.positions.values()); }
  getScanner(): FundingScanner { return this.scanner; }

  private roundTripFeeBps(): number {
    const perpFee = this.config.useMakerOrders ? this.config.makerFeeBps : this.config.takerFeeBps;
    return (perpFee + this.config.spotFeeBps) * 2;
  }

  private breakEvenHours(rate: number): number {
    if (rate <= 0) return 99999;
    return (this.roundTripFeeBps() / 10000) / rate;
  }

  private shouldEnter(opp: FundingOpportunity): { enter: boolean; reason: string } {
    // Gate 1: Need enough samples to trust the rate isn't a momentary spike
    if (opp.rateSamples < MIN_SAMPLES_TO_ENTER) {
      return { enter: false, reason: `insufficient_samples (${opp.rateSamples}/${MIN_SAMPLES_TO_ENTER})` };
    }

    // Gate 2: Conservative (median) APY must exceed minimum
    if (opp.conservativeApy < this.config.minAnnualizedPct) {
      return { enter: false, reason: `conservative_apy_too_low (${opp.conservativeApy.toFixed(1)}%)` };
    }

    // Gate 3: Even the MIN rate in lookback must be positive (no flip-flopping)
    if (opp.minRateLookback <= 0) {
      return { enter: false, reason: 'rate_went_negative_in_lookback' };
    }

    // Gate 4: Break-even using conservative rate must be < max allowed
    const conservativeBreakEven = this.breakEvenHours(opp.minRateLookback);
    if (conservativeBreakEven > this.config.maxBreakEvenHours) {
      return { enter: false, reason: `break_even_too_long (${conservativeBreakEven.toFixed(0)}h)` };
    }

    return { enter: true, reason: 'passed_all_gates' };
  }

  private shouldRotate(currentPos: FundingArbPosition, newOpp: FundingOpportunity): { rotate: boolean; reason: string } {
    const currentOpp = this.scanner.getOpportunityForAsset(currentPos.asset);
    const currentRate = currentOpp?.currentFundingRate ?? 0;

    // Never rotate before we've broken even on current position
    const totalFees = currentPos.entryFeesUsd + this.exitFeesUsd();
    if (currentPos.accumulatedFunding < totalFees) {
      return { rotate: false, reason: 'not_broken_even_yet' };
    }

    // Rotation costs: close current (exit fees) + open new (entry fees) = 2x one-side fees
    const rotationCostBps = this.roundTripFeeBps(); // full round trip on both sides
    const rateGain = newOpp.conservativeApy / 100 / HOURS_PER_YEAR - currentRate;
    if (rateGain <= 0) {
      return { rotate: false, reason: 'no_rate_improvement' };
    }

    // How many hours to recoup rotation cost from the extra rate?
    const hoursToRecoup = (rotationCostBps / 10000) / rateGain;
    // Only rotate if we recoup within reasonable time
    if (hoursToRecoup > this.config.maxBreakEvenHours) {
      return { rotate: false, reason: `rotation_recoup_too_slow (${hoursToRecoup.toFixed(0)}h)` };
    }

    // New opportunity must also pass entry gates
    const entryCheck = this.shouldEnter(newOpp);
    if (!entryCheck.enter) {
      return { rotate: false, reason: `new_opp_fails: ${entryCheck.reason}` };
    }

    return { rotate: true, reason: `rate_gain +${(rateGain * HOURS_PER_YEAR * 100).toFixed(1)}% APY, recoup in ${hoursToRecoup.toFixed(0)}h` };
  }

  private exitFeesUsd(): number {
    const perpFee = this.config.useMakerOrders ? this.config.makerFeeBps : this.config.takerFeeBps;
    return ((perpFee + this.config.spotFeeBps) / 10000) * this.config.positionSizeUsd;
  }

  private async evaluateRotations(): Promise<void> {
    const opps = this.scanner.getOpportunities();
    if (opps.length === 0) return;

    // Check existing positions
    for (const [asset, pos] of this.positions) {
      if (pos.status !== 'open') continue;
      pos.hoursHeld = (Date.now() - pos.openedAt) / 3_600_000;
      const currentOpp = this.scanner.getOpportunityForAsset(asset);
      const currentApy = currentOpp?.conservativeApy ?? 0;

      // Only exit if: rate dropped AND we've already broken even on fees
      const totalFees = pos.entryFeesUsd + this.exitFeesUsd();
      const brokenEven = pos.accumulatedFunding >= totalFees;

      if (currentApy < this.config.exitBelowAnnualizedPct && brokenEven) {
        log.info({ asset, currentApy: currentApy.toFixed(1), funding: pos.accumulatedFunding.toFixed(4), fees: totalFees.toFixed(4) }, 'Funding dropped + broken even — closing');
        await this.closePosition(asset, 'funding_dropped');
        continue;
      }

      // Check rotation only if we've broken even
      if (!brokenEven) continue;

      for (const opp of opps) {
        if (opp.asset === asset || this.positions.has(opp.asset)) continue;
        const check = this.shouldRotate(pos, opp);
        if (check.rotate) {
          log.info({ from: asset, to: opp.asset, reason: check.reason }, 'Rotation');
          await this.closePosition(asset, 'rotation');
          await this.openPosition(opp);
          break;
        }
      }
    }

    // Fill empty slots
    for (const opp of opps) {
      if (this.countOpenPositions() >= this.config.maxPositions) break;
      if (this.positions.has(opp.asset)) continue;

      const check = this.shouldEnter(opp);
      if (check.enter) {
        await this.openPosition(opp);
      } else if (opp.conservativeApy >= this.config.minAnnualizedPct) {
        log.debug({ asset: opp.asset, reason: check.reason, apy: opp.conservativeApy.toFixed(1) }, 'Skipped entry');
      }
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
    const spotPrice = opp.perpMidPrice;
    const spotQty = notional / spotPrice;

    const perpFeeBps = this.config.useMakerOrders ? this.config.makerFeeBps : this.config.takerFeeBps;
    const entryFees = ((perpFeeBps + this.config.spotFeeBps) / 10000) * notional;

    const position: FundingArbPosition = {
      id, asset: opp.asset, binanceSymbol: opp.binanceSymbol, status: 'open',
      perpShortQty: perpQty.toFixed(6), perpEntryPrice: opp.perpMidPrice.toFixed(6),
      spotLongQty: spotQty.toFixed(6), spotEntryPrice: spotPrice.toFixed(6),
      notionalUsd: notional, leverage: this.config.perpLeverage,
      entryFundingRate: opp.currentFundingRate, accumulatedFunding: 0,
      entryFeesUsd: entryFees, exitFeesUsd: 0, realizedPnl: -entryFees,
      spotPnl: 0, perpPnl: 0, hoursHeld: 0,
      openedAt: Date.now(), closedAt: null,
    };

    this.positions.set(opp.asset, position);

    const expectedBreakEven = this.breakEvenHours(opp.minRateLookback);
    log.info({
      asset: opp.asset, binance: opp.binanceSymbol, notional,
      conservApy: `${opp.conservativeApy.toFixed(1)}%`,
      currentApy: `${opp.annualizedPct.toFixed(1)}%`,
      breakEven: `${expectedBreakEven.toFixed(1)}h`,
      entryFees: entryFees.toFixed(2),
      samples: opp.rateSamples,
      minRate: opp.minRateLookback.toFixed(8),
    }, 'PAPER: Opened funding arb (HL short + Binance spot long)');

    await this.persistPosition(position);
  }

  private async closePosition(asset: string, reason: string): Promise<void> {
    const pos = this.positions.get(asset);
    if (!pos) return;

    const opp = this.scanner.getOpportunityForAsset(asset);
    const currentPerpPrice = opp?.perpMidPrice ?? parseFloat(pos.perpEntryPrice);
    const currentSpotPrice = currentPerpPrice;
    const perpEntry = parseFloat(pos.perpEntryPrice);
    const spotEntry = parseFloat(pos.spotEntryPrice);
    const perpQty = parseFloat(pos.perpShortQty);
    const spotQty = parseFloat(pos.spotLongQty);

    pos.perpPnl = (perpEntry - currentPerpPrice) * perpQty;
    pos.spotPnl = (currentSpotPrice - spotEntry) * spotQty;
    pos.exitFeesUsd = this.exitFeesUsd();
    pos.realizedPnl = pos.perpPnl + pos.spotPnl + pos.accumulatedFunding - pos.entryFeesUsd - pos.exitFeesUsd;
    pos.status = 'closed';
    pos.closedAt = Date.now();
    pos.hoursHeld = (pos.closedAt - pos.openedAt) / 3_600_000;

    log.info({
      asset, reason, hoursHeld: pos.hoursHeld.toFixed(1),
      funding: pos.accumulatedFunding.toFixed(4),
      fees: (pos.entryFeesUsd + pos.exitFeesUsd).toFixed(4),
      realizedPnl: pos.realizedPnl.toFixed(4),
    }, 'Closed funding arb position');

    await this.persistPosition(pos);
    this.positions.delete(asset);
  }

  async accrueHourlyFunding(): Promise<void> {
    for (const [asset, pos] of this.positions) {
      if (pos.status !== 'open') continue;
      const opp = this.scanner.getOpportunityForAsset(asset);
      if (!opp) continue;

      const fundingPayment = opp.currentFundingRate * pos.notionalUsd;
      pos.accumulatedFunding += fundingPayment;
      const perpEntry = parseFloat(pos.perpEntryPrice);
      const perpQty = parseFloat(pos.perpShortQty);
      pos.perpPnl = (perpEntry - opp.perpMidPrice) * perpQty;
      pos.spotPnl = -pos.perpPnl;

      const totalFees = pos.entryFeesUsd + this.exitFeesUsd();
      const netAfterFees = pos.accumulatedFunding - totalFees;
      log.info({
        asset, fundingPayment: fundingPayment.toFixed(6),
        totalFunding: pos.accumulatedFunding.toFixed(4),
        totalFees: totalFees.toFixed(4),
        netAfterFees: netAfterFees.toFixed(4),
        brokenEven: netAfterFees >= 0,
        rate: opp.currentFundingRate.toFixed(6),
        hoursHeld: ((Date.now() - pos.openedAt) / 3_600_000).toFixed(1),
      }, 'Funding accrued');
    }
  }

  private async persistPosition(pos: FundingArbPosition): Promise<void> {
    try {
      await this.pool.query(`
        INSERT INTO funding_arb_positions (
          id, asset, binance_symbol, status, perp_short_qty, perp_entry_price,
          spot_long_qty, spot_entry_price, notional_usd, leverage,
          entry_funding_rate, accumulated_funding, entry_fees_usd,
          exit_fees_usd, realized_pnl, spot_pnl, perp_pnl,
          hours_held, opened_at, closed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT (id) DO UPDATE SET
          status = $4, accumulated_funding = $12,
          exit_fees_usd = $14, realized_pnl = $15,
          spot_pnl = $16, perp_pnl = $17,
          hours_held = $18, closed_at = $20
      `, [
        pos.id, pos.asset, pos.binanceSymbol, pos.status,
        pos.perpShortQty, pos.perpEntryPrice,
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
        values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
        params.push(
          new Date(opp.timestamp), opp.asset, opp.currentFundingRate,
          opp.predictedFundingRate, opp.conservativeApy, opp.breakEvenHours,
          opp.perpMidPrice, opp.binanceSymbol,
        );
      }
      await this.pool.query(`
        INSERT INTO funding_arb_scans (
          timestamp, asset, current_funding_rate, predicted_funding_rate,
          annualized_pct, break_even_hours, perp_mid_price, binance_symbol
        ) VALUES ${values.join(',')}
      `, params);
    } catch (err) {
      log.error({ err }, 'Failed to persist scan snapshot');
    }
    for (const pos of this.positions.values()) {
      if (pos.status === 'open') await this.persistPosition(pos);
    }
  }

  private async loadPositions(): Promise<void> {
    try {
      const result = await this.pool.query(`SELECT * FROM funding_arb_positions WHERE status = 'open'`);
      for (const row of result.rows) {
        this.positions.set(row.asset, {
          id: row.id, asset: row.asset, binanceSymbol: row.binance_symbol ?? '',
          status: row.status,
          perpShortQty: row.perp_short_qty, perpEntryPrice: row.perp_entry_price,
          spotLongQty: row.spot_long_qty, spotEntryPrice: row.spot_entry_price,
          notionalUsd: parseFloat(row.notional_usd), leverage: parseFloat(row.leverage),
          entryFundingRate: parseFloat(row.entry_funding_rate),
          accumulatedFunding: parseFloat(row.accumulated_funding),
          entryFeesUsd: parseFloat(row.entry_fees_usd), exitFeesUsd: parseFloat(row.exit_fees_usd),
          realizedPnl: parseFloat(row.realized_pnl),
          spotPnl: parseFloat(row.spot_pnl), perpPnl: parseFloat(row.perp_pnl),
          hoursHeld: parseFloat(row.hours_held),
          openedAt: new Date(row.opened_at).getTime(),
          closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null,
        });
      }
      if (this.positions.size > 0) log.info({ count: this.positions.size }, 'Loaded existing positions');
    } catch (err) {
      log.warn({ err }, 'Could not load positions (table may not exist yet)');
    }
  }
}
