#!/usr/bin/env python3
"""
Pull top 100+ Polymarket sports traders, fetch full history, proper train/test analysis.
"""
import requests
import time
import json
import numpy as np
import pandas as pd
from pathlib import Path
from scipy import stats

DATA_DIR = Path("/tmp/pm_edge_study")
DATA_DIR.mkdir(exist_ok=True)
DATA_API = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"

def fetch_leaderboard(period, limit=100):
    url = f"{DATA_API}/v1/leaderboard?category=SPORTS&timePeriod={period}&orderBy=PNL&limit={limit}&offset=0"
    resp = requests.get(url, timeout=30)
    if resp.status_code != 200:
        return []
    return [{'address': (i.get('proxyWallet') or '').lower(), 'name': i.get('userName', ''),
             'pnl': i.get('pnl', 0), 'volume': i.get('vol', 0), 'period': period}
            for i in resp.json() if i.get('proxyWallet')]

# Step 1: Load cached trader histories
cache_file = DATA_DIR / "trader_histories.json"
print("Loading cached trader histories...")
with open(cache_file) as f:
    histories = json.load(f)
print(f"  {len(histories)} traders, {sum(len(v) for v in histories.values())} total trades")

# Step 2: Fetch market resolutions
# Each trade has slug, conditionId, asset (tokenId), outcome, outcomeIndex
# We need to know if the market is closed and what the resolution prices are
slug_cache_file = DATA_DIR / "slug_cache.json"
if slug_cache_file.exists():
    with open(slug_cache_file) as f:
        market_cache = json.load(f)
else:
    market_cache = {}

closed_markets = sum(1 for v in market_cache.values() if v and v.get('closed'))
print(f"\nMarket cache: {len(market_cache)} total, {closed_markets} resolved")

# Step 3: Compute PnL per trade
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
        rows.append({
            'address': addr,
            'timestamp': ts,
            'price': price,
            'size': size,
            'pnl': pnl,
            'won': res_price > 0.5,
        })

df = pd.DataFrame(rows)
if df.empty:
    print("ERROR: No resolved trades found")
    exit(1)

print(f"\nResolved BUY trades: {len(df)}")
print(f"Unique traders: {df['address'].nunique()}")
print(f"Date range: {pd.to_datetime(df['timestamp'].min(), unit='s').date()} to {pd.to_datetime(df['timestamp'].max(), unit='s').date()}")

# Step 4: Train/test split
SPLIT = 0.6
MIN_TRAIN = 30
MIN_TEST = 20

results = []
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

    results.append({
        'address': addr[:10],
        'n': n,
        'train_n': len(train), 'train_pnl': train['pnl'].sum(),
        'train_wr': (train['pnl'] > 0).mean(), 'train_avg': train['pnl'].mean(),
        'test_n': len(test), 'test_pnl': test['pnl'].sum(),
        'test_wr': (test['pnl'] > 0).mean(), 'test_avg': test['pnl'].mean(),
    })

res = pd.DataFrame(results).sort_values('train_pnl', ascending=False)
res['train_pos'] = res['train_pnl'] > 0
res['test_pos'] = res['test_pnl'] > 0

print(f"\n{'='*90}")
print(f"TRAIN/TEST PERSISTENCE — {len(res)} traders ({SPLIT:.0%}/{1-SPLIT:.0%} split, min {MIN_TRAIN}/{MIN_TEST})")
print(f"{'='*90}")
print(f"\n{'addr':<12} {'n':>5} {'trn_n':>5} {'trn_pnl':>10} {'trn_wr':>7} {'tst_n':>5} {'tst_pnl':>10} {'tst_wr':>7} {'p':>5}")
print("-" * 90)
for _, r in res.head(40).iterrows():
    p = "YES" if r['train_pos'] and r['test_pos'] else "FAIL" if r['train_pos'] else "-"
    print(f"{r['address']:<12} {r['n']:>5} {r['train_n']:>5} {r['train_pnl']:>10.2f} {r['train_wr']:>6.1%} {r['test_n']:>5} {r['test_pnl']:>10.2f} {r['test_wr']:>6.1%} {p:>5}")

train_winners = res[res['train_pos']]
n_tw = len(train_winners)
persisters = train_winners[train_winners['test_pos']]
n_persist = len(persisters)

print(f"\n--- PERSISTENCE ---")
print(f"Profitable in train:  {n_tw}/{len(res)} ({n_tw/len(res)*100:.0f}%)")
if n_tw > 0:
    print(f"Persist in test:      {n_persist}/{n_tw} ({n_persist/n_tw*100:.0f}%)")

# Stricter filter: only traders with >$200 train PnL AND >55% train WR
strict = res[(res['train_pnl'] > 200) & (res['train_wr'] > 0.55)]
if len(strict) > 0:
    strict_persist = strict[strict['test_pos']]
    print(f"\nStrict filter (train >$200, WR>55%):")
    print(f"  Qualify: {len(strict)}")
    print(f"  Persist: {len(strict_persist)}/{len(strict)} ({len(strict_persist)/len(strict)*100:.0f}%)")
    for _, r in strict.iterrows():
        p = "YES" if r['test_pos'] else "FAIL"
        print(f"    {r['address']}: train ${r['train_pnl']:.0f} ({r['train_wr']:.0%}) → test ${r['test_pnl']:.0f} ({r['test_wr']:.0%}) {p}")

# Null hypothesis
n_sims = 50000
null_rates = []
for _ in range(n_sims):
    ft = np.random.random(len(res)) > 0.5
    ftest = np.random.random(len(res)) > 0.5
    n_ft = ft.sum()
    if n_ft > 0:
        null_rates.append((ft & ftest).sum() / n_ft)
null_rates = np.array(null_rates)
actual_rate = n_persist / n_tw if n_tw > 0 else 0
p_val = (null_rates >= actual_rate).mean()

print(f"\n--- NULL HYPOTHESIS ---")
print(f"Expected random persistence: {null_rates.mean():.0%}")
print(f"Actual persistence:          {actual_rate:.0%}")
print(f"p-value:                     {p_val:.4f}")
print(f"Significant (p<0.05)?        {'YES' if p_val < 0.05 else 'NO'}")

# Correlation
corr, corr_p = stats.pearsonr(res['train_pnl'], res['test_pnl'])
rank_corr, rank_p = stats.spearmanr(res['train_pnl'], res['test_pnl'])
print(f"\n--- PREDICTIVE POWER ---")
print(f"Pearson (train PnL → test PnL):  r={corr:.3f} p={corr_p:.4f}")
print(f"Spearman (rank correlation):      ρ={rank_corr:.3f} p={rank_p:.4f}")

# Quintile
if len(res) >= 10:
    res['quintile'] = pd.qcut(res['train_pnl'], 5, labels=['Q1(worst)', 'Q2', 'Q3', 'Q4', 'Q5(best)'], duplicates='drop')
    print(f"\n--- QUINTILE (train rank → test performance) ---")
    for q in res['quintile'].cat.categories:
        qd = res[res['quintile'] == q]
        print(f"  {q}: train avg ${qd['train_pnl'].mean():>8.0f} → test avg ${qd['test_pnl'].mean():>8.0f}  test WR {qd['test_wr'].mean():.1%}  n={len(qd)}")

# Bottom line
print(f"\n{'='*90}")
if p_val < 0.05:
    print("CONCLUSION: Statistically significant edge persistence detected.")
    print("There ARE traders on Polymarket with real, persistent skill.")
elif p_val < 0.15:
    print("CONCLUSION: Suggestive but not conclusive. More data needed.")
else:
    print("CONCLUSION: No evidence of persistent edge. Leaderboard is survivorship bias.")
print(f"{'='*90}")
