import { FundingScanner } from '../src/execution/funding-arb/funding-scanner.js';

async function main() {
  const scanner = new FundingScanner({
    enabled: true,
    paperMode: true,
    scanIntervalMs: 60000,
    rotationCheckIntervalMs: 300000,
    maxPositions: 3,
    positionSizeUsd: 150,
    perpLeverage: 3,
    minAnnualizedPct: 20,
    rotationThresholdPct: 10,
    exitBelowAnnualizedPct: 5,
    takerFeeBps: 4.5,
    makerFeeBps: 1.5,
    spotFeeBps: 7.5,
    useMakerOrders: false,
  });

  await scanner.start();
  const opps = scanner.getOpportunities();

  console.log('\nTotal delta-neutral opportunities (HL perp + Binance spot):', opps.length);
  console.log('\nTop 20 by APY:');
  console.log('  ' + 'Asset'.padEnd(10) + 'APY'.padStart(8) + '  ' + 'Rate/hr'.padStart(12) + '  ' + 'BreakEven'.padStart(10) + '  ' + 'Price'.padStart(10) + '  Binance');
  console.log('  ' + '-'.repeat(70));
  for (const o of opps.slice(0, 20)) {
    console.log(
      '  ' + o.asset.padEnd(10) +
      (o.annualizedPct.toFixed(1) + '%').padStart(8) + '  ' +
      o.currentFundingRate.toFixed(8).padStart(12) + '  ' +
      (o.breakEvenHours.toFixed(1) + 'h').padStart(10) + '  ' +
      ('$' + o.perpMidPrice.toFixed(2)).padStart(10) + '  ' +
      o.binanceSymbol
    );
  }

  console.log('\n--- Summary ---');
  console.log('  >20% APY:', opps.filter(o => o.annualizedPct >= 20).length);
  console.log('  >50% APY:', opps.filter(o => o.annualizedPct >= 50).length);
  console.log('  >100% APY:', opps.filter(o => o.annualizedPct >= 100).length);
  console.log('  At baseline (~10.9%):', opps.filter(o => Math.abs(o.annualizedPct - 10.95) < 0.5).length);

  scanner.stop();
}

main().catch(console.error);
