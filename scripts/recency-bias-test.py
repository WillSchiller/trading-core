#!/usr/bin/env python3
"""
Test whether recency-weighted eligibility outperforms equal-weighted.

Approach:
- Split each trader's history into train (60%) and test (40%)
- In train, compute eligibility two ways:
  1. Equal-weighted: Sharpe/PF on all train data (current system)
  2. Recency-weighted: exponential decay weighting recent trades higher
- Compare test-set performance of traders selected by each method

If recency weighting selects better traders, we should adopt it.
If not, equal weighting is fine and simpler.
"""
import json
import numpy as np
import pandas as pd
from pathlib import Path
from scipy import stats

DATA_DIR = Path("/tmp/pm_edge_study")

with open(DATA_DIR / "trader_histories.json") as f:
    histories = json.load(f)
with open(DATA_DIR / "slug_cache.json") as f:
    slug_cache = json.load(f)

# Build per-trade PnL dataset
rows = []
for addr, trades in histories.items():
    for t in trades:
        if t.get('side') != 'BUY':
            continue
        slug = t.get('slug', '')
        price = float(t.get('price', 0))
        size = float(t.get('size', 0))
        ts = t.get('timestamp', 0)
        if isinstance(ts, str):
            ts = int(float(ts))
        idx = t.get('outcomeIndex')
        if price <= 0 or size <= 0 or idx is None or not slug:
            continue
        market = slug_cache.get(slug)
        if not market or not market.get('closed'):
            continue
        try:
            outcome_prices = [float(x) for x in json.loads(market.get('outcomePrices', '[]'))]
        except:
            continue
        if idx >= len(outcome_prices):
            continue
        res_price = outcome_prices[idx]
        pnl = (res_price - price) * size
        rows.append({'address': addr, 'timestamp': ts, 'pnl': pnl, 'price': price, 'size': size})

df = pd.DataFrame(rows).sort_values(['address', 'timestamp'])
print(f"Total resolved trades: {len(df):,}, Traders: {df.address.nunique()}")

SPLIT = 0.6
MIN_TRAIN = 50
MIN_TEST = 20

# Eligibility criteria
SHARPE_THRESHOLD = 0.05
PF_THRESHOLD = 1.3
MIN_DAYS = 14

def compute_stats_equal(trades_df):
    pnls = trades_df['pnl'].values
    if len(pnls) < 2:
        return None
    avg = pnls.mean()
    std = pnls.std()
    sharpe = avg / std if std > 0 else 0
    wins = pnls[pnls > 0].sum()
    losses = abs(pnls[pnls < 0].sum())
    pf = wins / losses if losses > 0 else (99 if wins > 0 else 0)
    days = trades_df.assign(date=pd.to_datetime(trades_df['timestamp'], unit='s').dt.date)['date'].nunique()
    return {'sharpe': sharpe, 'pf': pf, 'pnl': pnls.sum(), 'days': days, 'n': len(pnls)}

def compute_stats_recency(trades_df, halflife_frac=0.3):
    pnls = trades_df['pnl'].values
    n = len(pnls)
    if n < 2:
        return None
    halflife = max(int(n * halflife_frac), 5)
    decay = np.exp(-np.log(2) / halflife * np.arange(n)[::-1])
    weights = decay / decay.sum() * n

    w_avg = np.average(pnls, weights=weights)
    w_var = np.average((pnls - w_avg) ** 2, weights=weights)
    w_std = np.sqrt(w_var)
    sharpe = w_avg / w_std if w_std > 0 else 0

    w_wins = (pnls * weights)[pnls > 0].sum()
    w_losses = abs((pnls * weights)[pnls < 0].sum())
    pf = w_wins / w_losses if w_losses > 0 else (99 if w_wins > 0 else 0)

    days = trades_df.assign(date=pd.to_datetime(trades_df['timestamp'], unit='s').dt.date)['date'].nunique()
    return {'sharpe': sharpe, 'pf': pf, 'pnl': pnls.sum(), 'days': days, 'n': n}

def is_eligible(stats):
    if stats is None:
        return False
    return (stats['sharpe'] >= SHARPE_THRESHOLD and
            stats['pf'] >= PF_THRESHOLD and
            stats['n'] >= 50 and
            stats['days'] >= MIN_DAYS and
            stats['pnl'] > 0)

# Run comparison across multiple halflife values
halflives = [0.15, 0.2, 0.3, 0.4, 0.5]

print(f"\n{'='*90}")
print(f"RECENCY BIAS TEST — equal weight vs exponential decay")
print(f"{'='*90}")

# Equal weight baseline
equal_results = []
for addr, group in df.groupby('address'):
    group = group.sort_values('timestamp')
    n = len(group)
    if n < MIN_TRAIN + MIN_TEST:
        continue
    split_idx = int(n * SPLIT)
    train = group.iloc[:split_idx]
    test = group.iloc[split_idx:]
    if len(train) < MIN_TRAIN or len(test) < MIN_TEST:
        continue
    stats_eq = compute_stats_equal(train)
    eligible_eq = is_eligible(stats_eq)
    equal_results.append({
        'address': addr,
        'eligible': eligible_eq,
        'train_sharpe': stats_eq['sharpe'] if stats_eq else 0,
        'train_pf': stats_eq['pf'] if stats_eq else 0,
        'test_pnl': test['pnl'].sum(),
        'test_wr': (test['pnl'] > 0).mean(),
        'test_n': len(test),
    })

eq_df = pd.DataFrame(equal_results)
eq_eligible = eq_df[eq_df.eligible]
eq_total_test_pnl = eq_eligible.test_pnl.sum()
eq_n_eligible = len(eq_eligible)
eq_avg_test_pnl = eq_eligible.test_pnl.mean() if len(eq_eligible) > 0 else 0
eq_persist = (eq_eligible.test_pnl > 0).mean() if len(eq_eligible) > 0 else 0

print(f"\n--- EQUAL WEIGHT (baseline) ---")
print(f"Eligible traders: {eq_n_eligible}")
print(f"Aggregate test PnL: ${eq_total_test_pnl:,.0f}")
print(f"Avg test PnL per trader: ${eq_avg_test_pnl:,.0f}")
print(f"Persistence rate: {eq_persist:.0%}")

# Recency weighted for each halflife
print(f"\n--- RECENCY WEIGHTED ---")
print(f"{'halflife':>10} {'eligible':>10} {'test_pnl':>12} {'avg_pnl':>10} {'persist':>10} {'overlap':>10} {'unique':>10}")
print("-" * 80)

for hl in halflives:
    recency_results = []
    for addr, group in df.groupby('address'):
        group = group.sort_values('timestamp')
        n = len(group)
        if n < MIN_TRAIN + MIN_TEST:
            continue
        split_idx = int(n * SPLIT)
        train = group.iloc[:split_idx]
        test = group.iloc[split_idx:]
        if len(train) < MIN_TRAIN or len(test) < MIN_TEST:
            continue
        stats_rec = compute_stats_recency(train, halflife_frac=hl)
        eligible_rec = is_eligible(stats_rec)
        recency_results.append({
            'address': addr,
            'eligible': eligible_rec,
            'test_pnl': test['pnl'].sum(),
        })

    rec_df = pd.DataFrame(recency_results)
    rec_eligible = rec_df[rec_df.eligible]
    rec_total = rec_eligible.test_pnl.sum()
    rec_n = len(rec_eligible)
    rec_avg = rec_eligible.test_pnl.mean() if rec_n > 0 else 0
    rec_persist = (rec_eligible.test_pnl > 0).mean() if rec_n > 0 else 0

    # Overlap with equal weight
    eq_addrs = set(eq_eligible.address)
    rec_addrs = set(rec_eligible.address)
    overlap = len(eq_addrs & rec_addrs)
    unique_rec = len(rec_addrs - eq_addrs)

    print(f"{hl:>10.2f} {rec_n:>10} ${rec_total:>11,.0f} ${rec_avg:>9,.0f} {rec_persist:>9.0%} {overlap:>10} {unique_rec:>10}")

# Detailed comparison: who does recency add/remove vs equal?
print(f"\n--- DETAILED COMPARISON (halflife=0.3) ---")
rec30 = []
for addr, group in df.groupby('address'):
    group = group.sort_values('timestamp')
    n = len(group)
    if n < MIN_TRAIN + MIN_TEST:
        continue
    split_idx = int(n * SPLIT)
    train = group.iloc[:split_idx]
    test = group.iloc[split_idx:]
    if len(train) < MIN_TRAIN or len(test) < MIN_TEST:
        continue
    stats_eq = compute_stats_equal(train)
    stats_rec = compute_stats_recency(train, halflife_frac=0.3)
    rec30.append({
        'address': addr[:10],
        'eq_eligible': is_eligible(stats_eq),
        'rec_eligible': is_eligible(stats_rec),
        'eq_sharpe': stats_eq['sharpe'] if stats_eq else 0,
        'rec_sharpe': stats_rec['sharpe'] if stats_rec else 0,
        'test_pnl': test['pnl'].sum(),
        'test_wr': (test['pnl'] > 0).mean(),
    })

cmp = pd.DataFrame(rec30)
added = cmp[(~cmp.eq_eligible) & (cmp.rec_eligible)]
removed = cmp[(cmp.eq_eligible) & (~cmp.rec_eligible)]

if len(added) > 0:
    print(f"\nTraders ADDED by recency (not in equal, yes in recency):")
    for _, r in added.sort_values('test_pnl', ascending=False).iterrows():
        print(f"  {r.address}: eq_sharpe={r.eq_sharpe:.4f} rec_sharpe={r.rec_sharpe:.4f} test=${r.test_pnl:,.0f} ({'WIN' if r.test_pnl > 0 else 'LOSS'})")
    print(f"  Net test PnL of added: ${added.test_pnl.sum():,.0f}")

if len(removed) > 0:
    print(f"\nTraders REMOVED by recency (yes in equal, not in recency):")
    for _, r in removed.sort_values('test_pnl', ascending=False).iterrows():
        print(f"  {r.address}: eq_sharpe={r.eq_sharpe:.4f} rec_sharpe={r.rec_sharpe:.4f} test=${r.test_pnl:,.0f} ({'WIN' if r.test_pnl > 0 else 'LOSS'})")
    print(f"  Net test PnL of removed: ${removed.test_pnl.sum():,.0f}")

# Bottom line
print(f"\n{'='*90}")
print(f"VERDICT:")
best_rec_pnl = 0
best_hl = None
for hl in halflives:
    rec_res = []
    for addr, group in df.groupby('address'):
        group = group.sort_values('timestamp')
        n = len(group)
        if n < MIN_TRAIN + MIN_TEST:
            continue
        split_idx = int(n * SPLIT)
        train = group.iloc[:split_idx]
        test = group.iloc[split_idx:]
        if len(train) < MIN_TRAIN or len(test) < MIN_TEST:
            continue
        s = compute_stats_recency(train, halflife_frac=hl)
        if is_eligible(s):
            rec_res.append(test['pnl'].sum())
    total = sum(rec_res)
    if total > best_rec_pnl:
        best_rec_pnl = total
        best_hl = hl

if best_rec_pnl > eq_total_test_pnl * 1.1:
    improvement = (best_rec_pnl - eq_total_test_pnl) / abs(eq_total_test_pnl) * 100
    print(f"Recency weighting (halflife={best_hl}) improves test PnL by {improvement:.0f}%")
    print(f"Equal: ${eq_total_test_pnl:,.0f} → Recency: ${best_rec_pnl:,.0f}")
    print(f"RECOMMEND: adopt recency weighting")
elif best_rec_pnl < eq_total_test_pnl * 0.9:
    print(f"Recency weighting HURTS performance")
    print(f"Equal: ${eq_total_test_pnl:,.0f} → Best recency: ${best_rec_pnl:,.0f}")
    print(f"RECOMMEND: keep equal weighting")
else:
    print(f"No significant difference between equal and recency weighting")
    print(f"Equal: ${eq_total_test_pnl:,.0f} → Best recency: ${best_rec_pnl:,.0f} (halflife={best_hl})")
    print(f"RECOMMEND: keep equal weighting (simpler)")
print(f"{'='*90}")
