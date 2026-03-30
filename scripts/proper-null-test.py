#!/usr/bin/env python3
"""
Proper null hypothesis test for Polymarket trader edge persistence.

Instead of coin flips, shuffles each trader's outcomes while preserving
their bet sizes, prices, and number of trades. This tests whether
the observed persistence could arise from random outcomes given the
same betting patterns.

Also computes all correlations on train-only features (no test leakage)
and reports Spearman alongside Pearson.
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

# Build per-trade dataset with entry price and resolution price
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
        rows.append({
            'address': addr, 'timestamp': ts,
            'price': price, 'size': size,
            'res_price': res_price,
            'pnl': (res_price - price) * size,
            'won': res_price > 0.5,
        })

df = pd.DataFrame(rows).sort_values(['address', 'timestamp'])
print(f"Trades: {len(df):,}  Traders: {df.address.nunique()}")

SPLIT = 0.6
MIN_TRAIN = 50
MIN_TEST = 20

# Prepare per-trader train/test splits
trader_data = {}
for addr, group in df.groupby('address'):
    group = group.sort_values('timestamp').reset_index(drop=True)
    n = len(group)
    if n < MIN_TRAIN + MIN_TEST:
        continue
    split_idx = int(n * SPLIT)
    if split_idx < MIN_TRAIN or (n - split_idx) < MIN_TEST:
        continue
    trader_data[addr] = {
        'train': group.iloc[:split_idx],
        'test': group.iloc[split_idx:],
        'all': group,
    }

print(f"Traders with enough data: {len(trader_data)}")

# ============================================================
# 1. ACTUAL persistence rate
# ============================================================
actual_train_pos = 0
actual_persist = 0
actual_train_pnls = []
actual_test_pnls = []

for addr, data in trader_data.items():
    train_pnl = data['train']['pnl'].sum()
    test_pnl = data['test']['pnl'].sum()
    actual_train_pnls.append(train_pnl)
    actual_test_pnls.append(test_pnl)
    if train_pnl > 0:
        actual_train_pos += 1
        if test_pnl > 0:
            actual_persist += 1

actual_rate = actual_persist / actual_train_pos if actual_train_pos > 0 else 0

# ============================================================
# 2. BOOTSTRAP NULL: shuffle outcomes within each trader
# ============================================================
N_BOOTSTRAP = 1000
null_persist_rates = []

np.random.seed(42)
for b in range(N_BOOTSTRAP):
    boot_train_pos = 0
    boot_persist = 0
    for addr, data in trader_data.items():
        all_trades = data['all']
        n = len(all_trades)
        split_idx = int(n * SPLIT)

        # Shuffle the won/lost outcomes while preserving prices and sizes
        shuffled_won = np.random.permutation(all_trades['won'].values)
        # Recompute PnL: if won, pnl = (1 - price) * size; if lost, pnl = (0 - price) * size
        shuffled_pnl = np.where(shuffled_won,
                                (1.0 - all_trades['price'].values) * all_trades['size'].values,
                                (0.0 - all_trades['price'].values) * all_trades['size'].values)

        train_pnl = shuffled_pnl[:split_idx].sum()
        test_pnl = shuffled_pnl[split_idx:].sum()

        if train_pnl > 0:
            boot_train_pos += 1
            if test_pnl > 0:
                boot_persist += 1

    rate = boot_persist / boot_train_pos if boot_train_pos > 0 else 0
    null_persist_rates.append(rate)

null_persist_rates = np.array(null_persist_rates)
p_value = (null_persist_rates >= actual_rate).mean()

print(f"\n{'='*70}")
print(f"PROPER BOOTSTRAP NULL HYPOTHESIS TEST")
print(f"{'='*70}")
print(f"Actual persistence rate: {actual_rate:.3f} ({actual_persist}/{actual_train_pos})")
print(f"Null distribution mean:  {null_persist_rates.mean():.3f}")
print(f"Null distribution std:   {null_persist_rates.std():.3f}")
print(f"Null 95th percentile:    {np.percentile(null_persist_rates, 95):.3f}")
print(f"Null 99th percentile:    {np.percentile(null_persist_rates, 99):.3f}")
print(f"p-value:                 {p_value:.4f}")
print(f"Significant (p<0.05)?    {'YES' if p_value < 0.05 else 'NO'}")

# ============================================================
# 3. CORRELATIONS on TRAIN-ONLY features (no test leakage)
# ============================================================
print(f"\n{'='*70}")
print(f"CORRELATIONS — TRAIN-ONLY FEATURES vs TEST OUTCOME")
print(f"{'='*70}")

feature_rows = []
for addr, data in trader_data.items():
    train = data['train']
    test = data['test']
    pnls = train['pnl'].values
    n = len(pnls)
    if n < 2:
        continue

    avg = pnls.mean()
    std = pnls.std()
    sharpe = avg / std if std > 0 else 0
    wins_sum = pnls[pnls > 0].sum()
    losses_sum = abs(pnls[pnls < 0].sum())
    pf = wins_sum / losses_sum if losses_sum > 0 else (99 if wins_sum > 0 else 0)
    wr = (pnls > 0).mean()
    daily_pnl = train.assign(d=pd.to_datetime(train['timestamp'], unit='s').dt.date).groupby('d')['pnl'].sum()
    daily_wr = (daily_pnl > 0).mean()
    avg_entry = train['price'].mean()

    test_pnl = test['pnl'].sum()
    test_positive = 1 if test_pnl > 0 else 0

    feature_rows.append({
        'address': addr,
        'train_sharpe': sharpe,
        'train_pf': min(pf, 10),
        'train_wr': wr,
        'train_daily_wr': daily_wr,
        'train_pnl': pnls.sum(),
        'train_n': n,
        'train_avg_entry': avg_entry,
        'test_pnl': test_pnl,
        'test_positive': test_positive,
    })

feat = pd.DataFrame(feature_rows)

print(f"\n{'feature':<20} {'Pearson r':>10} {'p':>8} {'Spearman ρ':>12} {'p':>8}")
print("-" * 65)
for col in ['train_sharpe', 'train_pf', 'train_wr', 'train_daily_wr', 'train_pnl', 'train_n', 'train_avg_entry']:
    pr, pp = stats.pearsonr(feat[col], feat['test_pnl'])
    sr, sp = stats.spearmanr(feat[col], feat['test_pnl'])
    sig = ' **' if min(pp, sp) < 0.01 else ' *' if min(pp, sp) < 0.05 else ''
    print(f"{col:<20} {pr:>10.3f} {pp:>7.4f} {sr:>12.3f} {sp:>7.4f}{sig}")

# Also correlate with binary test success
print(f"\n{'feature':<20} {'PointBis r':>10} {'p':>8}  (vs test_positive)")
print("-" * 50)
for col in ['train_sharpe', 'train_pf', 'train_wr', 'train_daily_wr', 'train_pnl', 'train_n']:
    r, p = stats.pointbiserialr(feat['test_positive'], feat[col])
    sig = ' **' if p < 0.01 else ' *' if p < 0.05 else ''
    print(f"{col:<20} {r:>10.3f} {p:>7.4f}{sig}")

# ============================================================
# 4. SPEARMAN on train PnL vs test PnL (the key question)
# ============================================================
print(f"\n{'='*70}")
print(f"KEY QUESTION: Does train-period ranking predict test-period ranking?")
print(f"{'='*70}")
pr, pp = stats.pearsonr(feat['train_pnl'], feat['test_pnl'])
sr, sp = stats.spearmanr(feat['train_pnl'], feat['test_pnl'])
print(f"Pearson  (train PnL vs test PnL): r={pr:.3f}  p={pp:.4f}")
print(f"Spearman (train PnL vs test PnL): ρ={sr:.3f}  p={sp:.4f}")

# Check if Pearson is driven by outliers: remove top/bottom 5%
trimmed = feat[(feat.train_pnl > feat.train_pnl.quantile(0.05)) &
               (feat.train_pnl < feat.train_pnl.quantile(0.95)) &
               (feat.test_pnl > feat.test_pnl.quantile(0.05)) &
               (feat.test_pnl < feat.test_pnl.quantile(0.95))]
tpr, tpp = stats.pearsonr(trimmed['train_pnl'], trimmed['test_pnl'])
tsr, tsp = stats.spearmanr(trimmed['train_pnl'], trimmed['test_pnl'])
print(f"\nAfter trimming top/bottom 5% outliers (n={len(trimmed)}):")
print(f"Pearson:  r={tpr:.3f}  p={tpp:.4f}")
print(f"Spearman: ρ={tsr:.3f}  p={tsp:.4f}")

# ============================================================
# 5. QUINTILE with Spearman
# ============================================================
print(f"\n{'='*70}")
print(f"QUINTILE ANALYSIS (train rank → test performance)")
print(f"{'='*70}")
feat['quintile'] = pd.qcut(feat['train_pnl'], 5, labels=['Q1','Q2','Q3','Q4','Q5'], duplicates='drop')
for q in ['Q1','Q2','Q3','Q4','Q5']:
    qd = feat[feat.quintile == q]
    persist = (qd.test_pnl > 0).mean()
    print(f"  {q}: n={len(qd):>3}  train avg ${qd.train_pnl.mean():>10,.0f}  test avg ${qd.test_pnl.mean():>10,.0f}  test median ${qd.test_pnl.median():>10,.0f}  persist {persist:.0%}")

# ============================================================
# VERDICT
# ============================================================
print(f"\n{'='*70}")
print(f"VERDICT")
print(f"{'='*70}")
if p_value < 0.05:
    print(f"Bootstrap null: REJECTED (p={p_value:.4f}) — persistence is real")
else:
    print(f"Bootstrap null: NOT REJECTED (p={p_value:.4f}) — persistence could be random")

if sr > 0.1 and sp < 0.05:
    print(f"Spearman rank persistence: SIGNIFICANT (ρ={sr:.3f}, p={sp:.4f})")
elif tsr > 0.1 and tsp < 0.05:
    print(f"Spearman rank (trimmed): SIGNIFICANT (ρ={tsr:.3f}, p={tsp:.4f})")
    print(f"But outlier-driven — Spearman drops from full sample")
else:
    print(f"Spearman rank persistence: NOT SIGNIFICANT (ρ={sr:.3f})")
    print(f"Ranking traders by train performance does NOT predict test ranking")
print(f"{'='*70}")
