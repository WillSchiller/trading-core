import pg from 'pg';
import { createChildLogger } from '../../utils/logger.js';
import { FundingScanner } from './funding-scanner.js';
import type { FundingArbConfig, FundingArbPosition, FundingOpportunity } from './types.js';

const log = createChildLogger({ component: 'funding-arb' });

const NEGATIVE_EXIT_HOURS = 8; // consecutive hours of negative rate before exit

export class FundingArbManager {
  private config: FundingArbConfig;
  private scanner: FundingScanner;
  private pool: pg.Pool;
  private positions = new Map<string, FundingArbPosition>();
  private negativeStreaks = new Map<string, number>(); // asset → consecutive negative readings
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: FundingArbConfig, pool: pg.Pool) {
    this.config = config;
    this.pool = pool;
    this.scanner = new FundingScanner(config);
  }

  async start(): Promise<void> {
    await this.scanner.start();
    await this.loadPositions();

    this.checkTimer = setInterval(
      () => this.evaluate().catch(e => log.error({ err: e }, 'Evaluate error')),
      this.config.rotationCheckIntervalMs,
    );
    this.persistTimer = setInterval(
      () => this.persistSnapshot().catch(e => log.error({ err: e }, 'Persist error')),
      60_000,
    );
    setTimeout(() => this.evaluate().catch(e => log.error({ err: e }, 'Initial evaluate error')), 10_000);

    log.info({
      paperMode: this.config.paperMode,
      maxPositions: this.config.maxPositions,
      positionSizeUsd: this.config.positionSizeUsd,
      leverage: this.config.perpLeverage,
      targetAssets: this.config.spotAssetWhitelist ?? 'auto',
    }, 'Funding arb manager started (buy-and-hold mode)');
  }

  stop(): void {
    this.scanner.stop();
    if (this.checkTimer) { clearInterval(this.checkTimer); this.checkTimer = null; }
    if (this.persistTimer) { clearInterval(this.persistTimer); this.persistTimer = null; }
  }

  getPositions(): FundingArbPosition[] { return Array.from(this.positions.values()); }
  getScanner(): FundingScanner { return this.scanner; }

  private entryFeesUsd(): number {
    const perpFee = this.config.useMakerOrders ? this.config.makerFeeBps : this.config.takerFeeBps;
    return ((perpFee + this.config.spotFeeBps) / 10000) * this.config.positionSizeUsd;
  }

  private exitFeesUsd(): number {
    return this.entryFeesUsd();
  }

  private async evaluate(): Promise<void> {
    const opps = this.scanner.getOpportunities();
    if (opps.length === 0) return;

    // Check existing positions for persistent negative funding
    for (const [asset, pos] of this.positions) {
      if (pos.status !== 'open') continue;
      pos.hoursHeld = (Date.now() - pos.openedAt) / 3_600_000;

      const opp = this.scanner.getOpportunityForAsset(asset);
      const rate = opp?.currentFundingRate ?? 0;

      if (rate <= 0) {
        const streak = (this.negativeStreaks.get(asset) ?? 0) + 1;
        this.negativeStreaks.set(asset, streak);
        const negativeHours = streak * (this.config.rotationCheckIntervalMs / 3_600_000);

        if (negativeHours >= NEGATIVE_EXIT_HOURS) {
          log.info({ asset, negativeHours: negativeHours.toFixed(1), rate }, 'Persistent negative funding — closing');
          await this.closePosition(asset, 'persistent_negative');
          this.negativeStreaks.delete(asset);
        } else {
          log.debug({ asset, negativeHours: negativeHours.toFixed(1), rate }, 'Negative rate tick');
        }
      } else {
        this.negativeStreaks.set(asset, 0);
      }
    }

    // Fill empty slots — pick highest-rate assets with positive funding
    const openCount = this.countOpenPositions();
    if (openCount >= this.config.maxPositions) return;

    for (const opp of opps) {
      if (this.countOpenPositions() >= this.config.maxPositions) break;
      if (this.positions.has(opp.asset)) continue;
      if (opp.currentFundingRate <= 0) continue;

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
    const spotQty = perpQty;
    const entryFees = this.entryFeesUsd();

    const position: FundingArbPosition = {
      id, asset: opp.asset, binanceSymbol: opp.binanceSymbol, status: 'open',
      perpShortQty: perpQty.toFixed(6), perpEntryPrice: opp.perpMidPrice.toFixed(6),
      spotLongQty: spotQty.toFixed(6), spotEntryPrice: opp.perpMidPrice.toFixed(6),
      notionalUsd: notional, leverage: this.config.perpLeverage,
      entryFundingRate: opp.currentFundingRate, accumulatedFunding: 0,
      entryFeesUsd: entryFees, exitFeesUsd: 0, realizedPnl: -entryFees,
      spotPnl: 0, perpPnl: 0, hoursHeld: 0,
      openedAt: Date.now(), closedAt: null,
    };

    this.positions.set(opp.asset, position);

    const capitalRequired = notional + (notional / this.config.perpLeverage);
    const annualFunding = opp.currentFundingRate * 8760 * notional;
    const netAnnual = annualFunding - (entryFees * 2);
    const roic = (netAnnual / capitalRequired) * 100;

    log.info({
      asset: opp.asset, binance: opp.binanceSymbol, notional,
      rate: opp.currentFundingRate.toFixed(8),
      apy: `${opp.annualizedPct.toFixed(1)}%`,
      roic: `${roic.toFixed(1)}%`,
      entryFees: entryFees.toFixed(2),
    }, 'PAPER: Opened buy-and-hold funding arb');

    await this.persistPosition(position);
  }

  private async closePosition(asset: string, reason: string): Promise<void> {
    const pos = this.positions.get(asset);
    if (!pos) return;

    const opp = this.scanner.getOpportunityForAsset(asset);
    const currentPrice = opp?.perpMidPrice ?? parseFloat(pos.perpEntryPrice);
    const perpEntry = parseFloat(pos.perpEntryPrice);
    const spotEntry = parseFloat(pos.spotEntryPrice);
    const perpQty = parseFloat(pos.perpShortQty);
    const spotQty = parseFloat(pos.spotLongQty);

    pos.perpPnl = (perpEntry - currentPrice) * perpQty;
    pos.spotPnl = (currentPrice - spotEntry) * spotQty;
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
      pos.hoursHeld = (Date.now() - pos.openedAt) / 3_600_000;

      const totalFees = pos.entryFeesUsd + this.exitFeesUsd();
      log.info({
        asset, fundingPayment: fundingPayment.toFixed(6),
        totalFunding: pos.accumulatedFunding.toFixed(4),
        totalFees: totalFees.toFixed(4),
        net: (pos.accumulatedFunding - totalFees).toFixed(4),
        rate: opp.currentFundingRate.toFixed(6),
        hoursHeld: pos.hoursHeld.toFixed(1),
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

    // Persist cross-venue spreads (top 20 widest)
    const spreads = this.scanner.getSpreads().slice(0, 20);
    if (spreads.length > 0) {
      try {
        const sValues: string[] = [];
        const sParams: unknown[] = [];
        let sIdx = 1;
        for (const s of spreads) {
          sValues.push(`($${sIdx++},$${sIdx++},$${sIdx++},$${sIdx++},$${sIdx++},$${sIdx++},$${sIdx++})`);
          sParams.push(new Date(s.timestamp), s.asset, s.binanceSymbol, s.hlMid, s.binanceMid, s.spreadBps, s.absSpreadBps);
        }
        await this.pool.query(`
          INSERT INTO cross_venue_spreads (timestamp, asset, binance_symbol, hl_mid, binance_mid, spread_bps, abs_spread_bps)
          VALUES ${sValues.join(',')}
        `, sParams);
      } catch (err) {
        log.error({ err }, 'Failed to persist spreads');
      }
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
