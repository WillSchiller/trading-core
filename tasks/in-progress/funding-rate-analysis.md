# DEF-19: Funding Rate Filter Analysis

## Status: Analysis Complete, Awaiting Data (DEF-20)

## Finding
Counter-trend (PC1 >= 25bps) + negative funding is the strongest signal combo:
- 107 signals, +11.8 avg PnL, +24.8 avg residual, 59.8% win rate
- Consistent across Feb 9-14 (+12.8 avg) and post-Mar5 (+8.8 avg)
- Only combo with positive residual PnL in both periods

## Next Steps
1. Wait for DEF-20 (100+ post-Mar5 counter+neg_fund signals, ~Mar 25)
2. If confirmed: implement `maxFundingRate` config gate in shouldEnterShort()
3. Deploy in shadow mode first

## Backfill
`scripts/backfill-funding.ts` — 1,707 signals backfilled from Hyperliquid fundingHistory API
