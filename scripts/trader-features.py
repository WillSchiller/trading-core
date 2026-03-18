#!/usr/bin/env python3
"""
Extract features from Q4/Q5 persisters vs failures.
Find what separates traders with real edge from lucky ones.
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
    market_cache = json.load(f)

# Rebuild per-trade PnL with richer features
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
        outcome = t.get('outcome', '')
        title = t.get('title', '')

        if price <= 0 or size <= 0 or idx is None or not slug:
            continue

        market = market_cache.get(slug)
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

        # Classify market type from slug
        sport = 'other'
        for s in ['nba', 'nfl', 'nhl', 'mlb', 'soccer', 'epl', 'ucl', 'mls', 'wbc', 'cfb', 'ncaa']:
            if s in slug:
                sport = s
                break
        if 'kor-' in slug or 'bk' in slug.lower():
            sport = 'korean-sports'

        # Bet type from slug
        bet_type = 'moneyline'
        if 'spread' in slug:
            bet_type = 'spread'
        elif 'total' in slug or 'over' in slug:
            bet_type = 'total'

        rows.append({
            'address': addr,
            'timestamp': ts,
            'price': price,
            'size': size,
            'pnl': pnl,
            'won': res_price > 0.5,
            'sport': sport,
            'bet_type': bet_type,
            'is_favorite': price > 0.5,
            'is_underdog': price < 0.4,
            'is_coinflip': 0.4 <= price <= 0.6,
        })

df = pd.DataFrame(rows)
df['date'] = pd.to_datetime(df['timestamp'], unit='s')

# Compute per-trader features using FULL history (train+test)
SPLIT = 0.6
MIN_N = 50

features = []
for addr, group in df.groupby('address'):
    group = group.sort_values('timestamp')
    n = len(group)
    if n < MIN_N:
        continue

    split_idx = int(n * SPLIT)
    train = group.iloc[:split_idx]
    test = group.iloc[split_idx:]
    if len(test) < 20:
        continue

    train_pnl = train['pnl'].sum()
    test_pnl = test['pnl'].sum()

    # Features computed on FULL data for profiling
    # (in production, would compute on train only for selection)
    g = group

    # Basic stats
    wr = (g['pnl'] > 0).mean()
    avg_pnl = g['pnl'].mean()
    med_pnl = g['pnl'].median()
    std_pnl = g['pnl'].std()
    sharpe = avg_pnl / std_pnl if std_pnl > 0 else 0

    # Win/loss asymmetry
    wins = g[g['pnl'] > 0]['pnl']
    losses = g[g['pnl'] <= 0]['pnl']
    avg_win = wins.mean() if len(wins) > 0 else 0
    avg_loss = losses.mean() if len(losses) > 0 else 0
    profit_factor = wins.sum() / abs(losses.sum()) if losses.sum() != 0 else 99

    # Drawdown
    equity = g['pnl'].cumsum()
    peak = equity.cummax()
    dd = (equity - peak).min()

    # Consistency
    g_daily = g.groupby(g['date'].dt.date)['pnl'].sum()
    daily_wr = (g_daily > 0).mean()
    n_active_days = len(g_daily)

    # Streak
    is_loss = (g['pnl'] <= 0).values
    max_loss_streak = 0
    streak = 0
    for x in is_loss:
        if x:
            streak += 1
            max_loss_streak = max(max_loss_streak, streak)
        else:
            streak = 0

    # Bet sizing
    avg_size = g['size'].mean()
    med_size = g['size'].median()
    size_cv = g['size'].std() / g['size'].mean() if g['size'].mean() > 0 else 0

    # Market selection
    n_sports = g['sport'].nunique()
    top_sport = g['sport'].value_counts().index[0]
    top_sport_pct = g['sport'].value_counts().values[0] / n
    fav_pct = g['is_favorite'].mean()
    dog_pct = g['is_underdog'].mean()
    spread_pct = (g['bet_type'] == 'spread').mean()
    total_pct = (g['bet_type'] == 'total').mean()
    ml_pct = (g['bet_type'] == 'moneyline').mean()

    # Entry price profile
    avg_entry = g['price'].mean()
    med_entry = g['price'].median()

    # Tenure
    tenure_days = (g['date'].max() - g['date'].min()).days
    trades_per_day = n / max(tenure_days, 1)

    features.append({
        'address': addr[:10],
        'n': n, 'train_pnl': train_pnl, 'test_pnl': test_pnl,
        'train_pos': train_pnl > 0, 'test_pos': test_pnl > 0,
        'persists': train_pnl > 0 and test_pnl > 0,
        'wr': wr, 'avg_pnl': avg_pnl, 'sharpe': sharpe,
        'profit_factor': min(profit_factor, 10),
        'avg_win': avg_win, 'avg_loss': avg_loss,
        'max_dd': dd, 'daily_wr': daily_wr,
        'n_active_days': n_active_days, 'max_loss_streak': max_loss_streak,
        'avg_size': avg_size, 'size_cv': size_cv,
        'n_sports': n_sports, 'top_sport': top_sport, 'top_sport_pct': top_sport_pct,
        'fav_pct': fav_pct, 'dog_pct': dog_pct,
        'spread_pct': spread_pct, 'total_pct': total_pct, 'ml_pct': ml_pct,
        'avg_entry': avg_entry, 'med_entry': med_entry,
        'tenure_days': tenure_days, 'trades_per_day': trades_per_day,
    })

feat = pd.DataFrame(features)
feat['quintile'] = pd.qcut(feat['train_pnl'], 5, labels=['Q1', 'Q2', 'Q3', 'Q4', 'Q5'], duplicates='drop')

print(f"{'='*90}")
print(f"FEATURE ANALYSIS — {len(feat)} traders")
print(f"{'='*90}")

# Compare persisters vs failures in Q4+Q5
top = feat[feat['quintile'].isin(['Q4', 'Q5'])]
persisters = top[top['persists']]
failures = top[~top['persists'] & top['train_pos']]

print(f"\nQ4+Q5 traders: {len(top)} | Persist: {len(persisters)} | Fail: {len(failures)}")

compare_cols = [
    'n', 'wr', 'sharpe', 'profit_factor',
    'avg_win', 'avg_loss', 'daily_wr', 'max_loss_streak',
    'avg_size', 'size_cv', 'n_sports', 'top_sport_pct',
    'fav_pct', 'dog_pct', 'spread_pct', 'ml_pct',
    'avg_entry', 'tenure_days', 'trades_per_day', 'n_active_days',
]

print(f"\n{'feature':<20} {'persisters':>12} {'failures':>12} {'diff':>8} {'p-val':>8}")
print("-" * 65)
for col in compare_cols:
    pm = persisters[col].mean()
    fm = failures[col].mean()
    if len(persisters) > 1 and len(failures) > 1:
        _, p = stats.mannwhitneyu(persisters[col].dropna(), failures[col].dropna(), alternative='two-sided')
    else:
        p = 1.0
    sig = '*' if p < 0.05 else '**' if p < 0.01 else ''
    print(f"{col:<20} {pm:>12.3f} {fm:>12.3f} {pm-fm:>+8.3f} {p:>7.3f} {sig}")

# What sports do persisters focus on?
print(f"\n--- SPORT SPECIALIZATION ---")
print(f"\nPersisters top sports:")
for _, r in persisters.iterrows():
    print(f"  {r['address']}: {r['top_sport']} ({r['top_sport_pct']:.0%}), {r['n_sports']} sports, n={r['n']}, WR={r['wr']:.0%}, persist_test=${r['test_pnl']:.0f}")

print(f"\nFailures top sports:")
for _, r in failures.iterrows():
    print(f"  {r['address']}: {r['top_sport']} ({r['top_sport_pct']:.0%}), {r['n_sports']} sports, n={r['n']}, WR={r['wr']:.0%}, test=${r['test_pnl']:.0f}")

# Quintile feature profiles
print(f"\n--- QUINTILE PROFILES ---")
print(f"{'quintile':<6} {'n_traders':>10} {'persist%':>10} {'wr':>7} {'sharpe':>8} {'pf':>6} {'fav%':>6} {'spread%':>8} {'sports':>7} {'tenure':>7} {'tpd':>6}")
print("-" * 95)
for q in ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']:
    qd = feat[feat['quintile'] == q]
    tp = qd[qd['train_pos']]
    persist_rate = len(tp[tp['test_pos']]) / len(tp) * 100 if len(tp) > 0 else 0
    print(f"{q:<6} {len(qd):>10} {persist_rate:>9.0f}% {qd['wr'].mean():>6.1%} {qd['sharpe'].mean():>8.4f} {qd['profit_factor'].mean():>6.2f} {qd['fav_pct'].mean():>5.0%} {qd['spread_pct'].mean():>7.0%} {qd['n_sports'].mean():>7.1f} {qd['tenure_days'].mean():>7.0f} {qd['trades_per_day'].mean():>6.1f}")

# Feature importance — what predicts test_pnl > 0?
print(f"\n--- FEATURE CORRELATIONS WITH TEST SUCCESS ---")
feat['test_success'] = feat['test_pnl'] > 0
numeric_feats = ['wr', 'sharpe', 'profit_factor', 'daily_wr', 'n_active_days',
                 'max_loss_streak', 'size_cv', 'n_sports', 'top_sport_pct',
                 'fav_pct', 'dog_pct', 'spread_pct', 'tenure_days', 'trades_per_day',
                 'avg_entry', 'n']
print(f"{'feature':<20} {'corr_w_test_success':>20} {'p':>8}")
print("-" * 50)
for col in numeric_feats:
    r, p = stats.pointbiserialr(feat['test_success'].astype(int), feat[col])
    sig = ' *' if p < 0.05 else ' **' if p < 0.01 else ''
    print(f"{col:<20} {r:>20.3f} {p:>7.3f}{sig}")
