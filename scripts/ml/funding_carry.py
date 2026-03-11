#!/usr/bin/env python3
"""
Funding carry strategy backtest.
Go long assets with negative funding, collect payments.
Also tests: small-cap market making viability (spread capture).

HL funding is hourly. Strategy:
- Each hour, rank assets by funding rate
- Go long the most negative funding assets
- Hold for N hours, collect funding
- Account for price change during hold
"""

import subprocess
import sys
import numpy as np
import pandas as pd
from io import StringIO

DB_CMD = "ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@3.1.140.199"

def query_db(sql: str) -> str:
    cmd = f'{DB_CMD} "docker exec dislocation-postgres psql -U trader -d dislocation_trader -A -t -c \\"{sql}\\""'
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        print(f"DB error: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def query_csv(sql: str) -> pd.DataFrame:
    copy_sql = f"COPY ({sql}) TO STDOUT WITH CSV HEADER"
    raw = query_db(copy_sql)
    return pd.read_csv(StringIO(raw))


def load_funding() -> pd.DataFrame:
    sql = """
    SELECT asset, timestamp, funding_rate, premium
    FROM hl_funding_history
    ORDER BY timestamp, asset
    """
    return query_csv(sql)


def load_prices() -> pd.DataFrame:
    """Load hourly prices from allMids snapshots or market_context."""
    sql = """
    SELECT asset, timestamp,
        (market_context->>'oraclePx')::numeric as price
    FROM pca_signals
    WHERE market_context IS NOT NULL
        AND (market_context->>'oraclePx')::numeric > 0
    ORDER BY timestamp
    """
    try:
        df = query_csv(sql)
        if len(df) > 100:
            return df
    except:
        pass

    # Fallback: use entry/exit prices from signals
    sql = """
    SELECT asset, timestamp, entry_price as price
    FROM pca_signals
    WHERE entry_price > 0
    ORDER BY timestamp
    """
    return query_csv(sql)


def funding_carry_backtest(funding_df: pd.DataFrame):
    print("="*80)
    print("FUNDING CARRY STRATEGY BACKTEST")
    print("="*80)

    # HL funding is hourly, paid every hour
    # Strategy: go long assets where funding < threshold
    # P&L = funding_collected - price_change

    funding_df['timestamp_dt'] = pd.to_datetime(funding_df['timestamp'], unit='ms')
    funding_df['date'] = funding_df['timestamp_dt'].dt.date
    funding_df['hour'] = funding_df['timestamp_dt'].dt.floor('h')

    # Per-asset funding stats
    print("\n--- Per-Asset Funding Distribution ---")
    asset_stats = funding_df.groupby('asset').agg(
        count=('funding_rate', 'count'),
        avg_bps=('funding_rate', lambda x: x.mean() * 10000),
        pct_neg=('funding_rate', lambda x: (x < 0).mean() * 100),
        avg_neg_bps=('funding_rate', lambda x: x[x < 0].mean() * 10000 if (x < 0).any() else 0),
        p10_bps=('funding_rate', lambda x: x.quantile(0.1) * 10000),
    ).round(4)
    asset_stats = asset_stats.sort_values('avg_bps')

    print(f"\n{'Asset':<10} {'Count':>6} {'AvgBps':>8} {'%Neg':>6} {'AvgNegBps':>10} {'P10Bps':>8}")
    print("-"*55)
    for asset, r in asset_stats.head(20).iterrows():
        print(f"{asset:<10} {r['count']:>6.0f} {r['avg_bps']:>8.4f} {r['pct_neg']:>6.1f} {r['avg_neg_bps']:>10.4f} {r['p10_bps']:>8.4f}")

    # Simulate pure funding collection (no price risk hedge)
    print("\n\n--- Funding Carry Simulation ---")
    print("Assume: $200 position, long when funding < threshold, 1-hour hold")
    print("P&L = funding_rate * position_size (ignoring price change for now)\n")

    thresholds = [0, -0.0001, -0.0003, -0.0005, -0.001]

    for thresh in thresholds:
        mask = funding_df['funding_rate'] < thresh
        eligible = funding_df[mask]

        if len(eligible) == 0:
            continue

        # Group by hour, take top 3 most negative
        hourly_trades = []
        for hour, group in eligible.groupby('hour'):
            top3 = group.nsmallest(3, 'funding_rate')
            for _, row in top3.iterrows():
                funding_pnl = abs(row['funding_rate']) * 200  # $200 position
                hourly_trades.append({
                    'hour': hour,
                    'asset': row['asset'],
                    'funding_rate': row['funding_rate'],
                    'funding_pnl': funding_pnl,
                })

        trades_df = pd.DataFrame(hourly_trades)
        total_funding = trades_df['funding_pnl'].sum()
        n_trades = len(trades_df)
        n_hours = trades_df['hour'].nunique()
        daily_avg = total_funding / max(1, (n_hours / 24))

        avg_rate_bps = trades_df['funding_rate'].mean() * 10000

        print(f"Threshold: funding < {thresh*10000:.1f}bps")
        print(f"  Trades: {n_trades:,} across {n_hours:,} hours")
        print(f"  Avg funding rate: {avg_rate_bps:.4f} bps")
        print(f"  Total funding collected: ${total_funding:.2f}")
        print(f"  Daily avg (funding only): ${daily_avg:.2f}")
        print(f"  Annual (funding only): ${daily_avg * 365:.2f}")
        print()

    # Now the key question: what about price risk?
    print("\n--- Price Risk Analysis ---")
    print("Key question: does holding a long position lose more in price than it gains in funding?")

    # For each asset, compute hourly returns
    # We need price data for this
    funding_df_sorted = funding_df.sort_values(['asset', 'timestamp'])

    price_changes = []
    for asset, group in funding_df_sorted.groupby('asset'):
        group = group.sort_values('timestamp')
        if len(group) < 24:
            continue
        # Premium is mark - oracle, so premium change ~ price change
        # Actually we need actual prices. Let's use premium as proxy for now
        # Or compute return from consecutive funding periods
        premiums = group['premium'].values
        funding_rates = group['funding_rate'].values

        # For periods where funding < 0 (we'd be long):
        neg_mask = funding_rates < 0
        if neg_mask.sum() < 10:
            continue

        # Premium change while holding long during neg funding
        # This is imperfect but directionally correct
        neg_premiums = premiums[neg_mask]
        avg_premium_bps = np.mean(neg_premiums) * 10000
        avg_neg_funding_bps = np.mean(funding_rates[neg_mask]) * 10000

        price_changes.append({
            'asset': asset,
            'neg_hours': neg_mask.sum(),
            'avg_funding_bps': avg_neg_funding_bps,
            'avg_premium_bps': avg_premium_bps,
            'net_bps': abs(avg_neg_funding_bps) - abs(avg_premium_bps),
        })

    if price_changes:
        pc_df = pd.DataFrame(price_changes).sort_values('net_bps', ascending=False)
        print(f"\n{'Asset':<10} {'NegHrs':>7} {'FundBps':>9} {'PremBps':>9} {'NetBps':>8}")
        print("-"*50)
        for _, r in pc_df.head(20).iterrows():
            print(f"{r['asset']:<10} {r['neg_hours']:>7.0f} {r['avg_funding_bps']:>9.4f} {r['avg_premium_bps']:>9.4f} {r['net_bps']:>8.4f}")

        avg_net = pc_df['net_bps'].mean()
        positive = (pc_df['net_bps'] > 0).sum()
        print(f"\nAverage net: {avg_net:.4f} bps")
        print(f"Assets with positive net: {positive}/{len(pc_df)}")


def small_cap_spread_analysis(funding_df: pd.DataFrame):
    print("\n\n" + "="*80)
    print("SMALL-CAP SPREAD + FUNDING COMBO ANALYSIS")
    print("="*80)
    print("Question: Can we market-make small caps AND collect negative funding?")

    smalls = ['ARB', 'kPEPE', 'POPCAT', 'MOODENG', 'SAGA', 'DYM', 'BLAST',
              'MANTA', 'TNSR', 'BOME', 'TURBO', 'NOT', 'BRETT', 'IO',
              'MEME', 'BLUR', 'NTRN', 'MAV', 'ZETA', 'W']

    small_funding = funding_df[funding_df['asset'].isin(smalls)]

    if len(small_funding) == 0:
        print("No funding data for small caps")
        return

    print(f"\nSmall-cap funding stats ({len(small_funding)} readings):")

    stats = small_funding.groupby('asset').agg(
        n=('funding_rate', 'count'),
        avg_bps=('funding_rate', lambda x: x.mean() * 10000),
        pct_neg=('funding_rate', lambda x: (x < 0).mean() * 100),
        median_bps=('funding_rate', lambda x: x.median() * 10000),
    ).round(4).sort_values('avg_bps')

    print(f"\n{'Asset':<10} {'N':>6} {'AvgBps':>8} {'MedBps':>8} {'%Neg':>6}")
    print("-"*40)
    for asset, r in stats.iterrows():
        print(f"{asset:<10} {r['n']:>6.0f} {r['avg_bps']:>8.4f} {r['median_bps']:>8.4f} {r['pct_neg']:>6.1f}")

    # Combined opportunity: spread capture + funding
    # Estimated spread from earlier analysis (bps)
    spreads = {
        'ARB': 3.0, 'kPEPE': 3.0, 'POPCAT': 5.0, 'MOODENG': 5.0,
        'SAGA': 5.8, 'DYM': 5.7, 'BLAST': 41.0, 'MANTA': 5.0,
        'TNSR': 5.0, 'BOME': 5.0, 'TURBO': 5.0, 'NOT': 5.0,
        'BRETT': 5.0, 'IO': 5.0, 'MEME': 5.0, 'BLUR': 5.0,
    }

    print(f"\n\n--- Combined Opportunity (spread/2 + funding + maker rebate) ---")
    print(f"Assumptions: capture half-spread on entry+exit, earn 1bps maker rebate per side")
    print(f"{'Asset':<10} {'Spread':>8} {'HalfSp':>8} {'AvgFund':>8} {'Rebate':>8} {'Total':>8} {'$/trade':>8}")
    print("-"*65)

    for asset in stats.index:
        if asset not in spreads:
            continue
        sp = spreads[asset]
        half_sp = sp / 2  # capture half spread
        rebate = 2.0  # 1 bps per side
        avg_fund = stats.loc[asset, 'avg_bps']
        # Funding per hour on a $200 position
        funding_per_trade = abs(avg_fund) if avg_fund < 0 else -avg_fund
        total_bps = half_sp + rebate + funding_per_trade
        dollar = total_bps * 200 / 10000
        print(f"{asset:<10} {sp:>8.1f} {half_sp:>8.1f} {avg_fund:>8.4f} {rebate:>8.1f} {total_bps:>8.2f} {dollar:>8.4f}")


def main():
    print("Loading funding data...")
    funding_df = load_funding()
    print(f"Loaded {len(funding_df):,} funding readings")

    funding_carry_backtest(funding_df)
    small_cap_spread_analysis(funding_df)

    print("\nDone.")


if __name__ == '__main__':
    main()
