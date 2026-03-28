"""
Train Kelly model optimised for APY, not win rate.

Label: risk-adjusted return = pnl / cost / hold_hours
This rewards:
- Longshots that pay big (37c -> 100c = 170% return)
- Fast resolution (hours not days)
- Penalises high-price trades with small upside (90c -> 100c = 11%)

Then calibrate and apply Kelly criterion.
"""

import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.isotonic import IsotonicRegression
import json

DATA_PATH = '/tmp/pm_shadow_export.csv'

print('Loading data...')
df = pd.read_csv(DATA_PATH)
df['win'] = (df['pnl'] > 0).astype(int)
df['hold_hours'] = (df['resolve_ts'] - df['buy_ts']) / (1000 * 60 * 60)
df = df[df['hold_hours'] > 0].copy()

# Compute return metrics
df['cost'] = df['our_size'] * df['entry_price']
df['return_pct'] = df['pnl'] / df['cost'].clip(lower=0.01)
df['return_per_hour'] = df['return_pct'] / df['hold_hours'].clip(lower=0.5)
df['apy'] = df['return_per_hour'] * 24 * 365

# APY-based label: top 40% by return_per_hour = 1 (including losses that resolve fast)
df['high_apy'] = (df['return_per_hour'] > df['return_per_hour'].quantile(0.6)).astype(int)

# Features
df['cat_sports'] = (df['category'] == 'SPORTS').astype(int)
df['cat_crypto'] = (df['category'] == 'CRYPTO').astype(int)
df['cat_politics'] = (df['category'] == 'POLITICS').astype(int)
df['price_dist_from_half'] = abs(df['entry_price'] - 0.5)
df['implied_edge'] = np.where(df['entry_price'] < 0.5, 1 - df['entry_price'], df['entry_price'])
df['hour'] = pd.to_datetime(df['buy_ts'], unit='ms').dt.hour
df['dow'] = pd.to_datetime(df['buy_ts'], unit='ms').dt.dayofweek
tms = df.groupby('trader_address')['trader_size'].transform('median')
df['size_vs_median'] = df['trader_size'] / tms.clip(lower=0.01)
df = df.sort_values(['trader_address', 'buy_ts'])

# Payoff ratio as feature — the model needs to know the asymmetry
df['payoff_ratio'] = (1.0 / df['entry_price'].clip(0.01, 0.99)) - 1

def rf(g):
    p = g['pnl'].values; w = g['win'].values; n = len(p)
    r = np.full(n, np.nan); pf = np.full(n, np.nan); s = np.full(n, 0.0)
    lw = np.full(n, np.nan); lp = np.full(n, np.nan); tn = np.arange(1, n+1, dtype=float)
    cw = 0; cgw = 0.0; cgl = 0.0
    for i in range(n):
        if i > 0: lw[i] = cw/i; lp[i] = cgw/max(cgl, 0.001)
        if i >= 20:
            ww = p[i-20:i]; wins = sum(1 for x in ww if x > 0)
            gw = sum(x for x in ww if x > 0); gl = abs(sum(x for x in ww if x < 0))
            r[i] = wins/20; pf[i] = gw/max(gl, 0.001)
        if i > 0:
            st = 0
            for j in range(i-1, -1, -1):
                if w[j] == w[i-1]: st += 1
                else: break
            s[i] = st if w[i-1] == 1 else -st
        cw += w[i]
        if p[i] > 0: cgw += p[i]
        else: cgl += abs(p[i])
    g = g.copy()
    g['roll_wr_20'] = r; g['roll_pf_20'] = pf; g['roll_streak'] = s
    g['lifetime_wr'] = lw; g['lifetime_pf'] = lp; g['trade_num'] = tn
    return g

print('Computing features...')
df = df.groupby('trader_address', group_keys=False).apply(rf)
df = df.dropna(subset=['roll_wr_20', 'lifetime_wr'])
mc = df.groupby('market_slug').size().rename('market_trader_count')
df = df.join(mc, on='market_slug')

FEATURES = [
    'entry_price', 'price_dist_from_half', 'implied_edge', 'payoff_ratio',
    'cat_sports', 'cat_crypto', 'cat_politics',
    'hour', 'dow', 'size_vs_median',
    'roll_wr_20', 'roll_pf_20', 'roll_streak',
    'lifetime_wr', 'lifetime_pf', 'trade_num',
    'market_trader_count',
]

n = len(df)
te = int(n * 0.5)
ve = int(n * 0.7)
ts = int(n * 0.85)

X_train = df[FEATURES].values[:te]
X_cal = df[FEATURES].values[te:ve]
X_val = df[FEATURES].values[ve:ts]
X_test = df[FEATURES].values[ts:]

print(f'Split: {te} train / {ve-te} cal / {ts-ve} val / {n-ts} test')

# Train three models and compare
results = {}

for label_name, label_col in [('win', 'win'), ('high_apy', 'high_apy')]:
    y_train = df[label_col].values[:te]
    y_cal = df[label_col].values[te:ve]
    y_val = df[label_col].values[ve:ts]
    y_test = df[label_col].values[ts:]

    print(f'\n--- Training: {label_name} (positive rate: {y_train.mean():.3f}) ---')

    model = xgb.XGBClassifier(
        n_estimators=500, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        eval_metric='logloss', early_stopping_rounds=30, random_state=42,
    )
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=0)

    # Calibrate
    raw_cal = model.predict_proba(X_cal)[:, 1]
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(raw_cal, y_cal)

    raw_test = model.predict_proba(X_test)[:, 1]
    cal_test = iso.predict(raw_test)

    print(f'  Test AUC: {roc_auc_score(y_test, cal_test):.4f}')
    print(f'  Test Brier: {brier_score_loss(y_test, cal_test):.4f}')

    results[label_name] = {
        'model': model, 'iso': iso, 'cal_test': cal_test,
        'y_test': y_test, 'raw_test': raw_test,
    }

# Now simulate with Kelly using both models
test_df = df.iloc[ts:].copy()
total_days = (test_df['buy_ts'].max() - test_df['buy_ts'].min()) / (1000 * 60 * 60 * 24)

def kelly_fraction(p, entry_price):
    b = (1.0 / np.clip(entry_price, 0.01, 0.99)) - 1
    q = 1 - p
    f = p - q / b
    return np.clip(f, 0, 0.25) * 0.5  # half kelly

def simulate(tdf, probs, bankroll, fill_rate=0.30, slip_bps=50, compound=True):
    tdf = tdf.copy()
    tdf['prob'] = probs
    tdf['kelly_f'] = kelly_fraction(probs, tdf['entry_price'].values)
    tdf = tdf.sort_values('buy_ts')
    rng = np.random.RandomState(42)

    cash = bankroll; positions = []; pnl = 0; tc = 0; wins = 0; skip = 0
    peak = bankroll; mdd = 0
    bets_by_price = {'low': [], 'mid': [], 'high': []}

    for _, row in tdf.iterrows():
        for i in range(len(positions)-1, -1, -1):
            if positions[i]['rt'] <= row['buy_ts']:
                pos = positions.pop(i)
                cash += max(0, pos['c'] + pos['p'])
                pnl += pos['p']
                if pos['p'] > 0: wins += 1
                tc += 1
                if compound: bankroll = cash + sum(p['c']+p['p'] for p in positions)
                eq = cash + sum(p['c']+p['p'] for p in positions)
                if eq > peak: peak = eq
                if eq - peak < mdd: mdd = eq - peak

        if row['kelly_f'] <= 0: skip += 1; continue
        if rng.random() > fill_rate: skip += 1; continue

        ps = min(bankroll * row['kelly_f'], cash, 50)
        if ps < 1: skip += 1; continue

        sc = max(row['our_size'] * row['entry_price'], 0.01)
        raw = row['pnl'] * (ps / sc)
        slip = ps * slip_bps / 10000
        sp = max(raw - slip, -ps)
        cash -= ps
        positions.append({'c': ps, 'p': sp, 'rt': row['resolve_ts']})

        bucket = 'low' if row['entry_price'] < 0.35 else ('high' if row['entry_price'] > 0.65 else 'mid')
        bets_by_price[bucket].append({'size': ps, 'pnl': sp, 'won': sp > 0})

    for pos in positions:
        pnl += pos['p']; tc += 1
        if pos['p'] > 0: wins += 1

    final = cash + sum(p['c']+p['p'] for p in positions)
    return tc, wins, pnl, final, mdd, bets_by_price

years = max(total_days / 365, 0.01)

print(f'\nTest period: {total_days:.0f} days ({years:.1f} years)')
print(f'\n{"Model":<20} {"Bankroll":<10} {"Trades":>7} {"WR%":>6} {"Final$":>10} {"CAGR%":>8} {"MaxDD":>8}')
print('-' * 75)

for label_name in ['win', 'high_apy']:
    cal = results[label_name]['cal_test']
    for bk in [120, 1000, 5000]:
        tc, w, p, final, dd, by_price = simulate(test_df, cal, bk)
        wr = w / max(tc, 1) * 100
        cagr = ((final / bk) ** (1/years) - 1) * 100 if final > 0 else -100
        print(f'{label_name:<20} ${bk:<9} {tc:>7} {wr:>5.1f}% ${final:>9.0f} {cagr:>7.0f}% ${dd:>7.0f}')

# Price bucket analysis
print(f'\n=== TRADE ANALYSIS BY ENTRY PRICE (high_apy model, $1k) ===')
cal = results['high_apy']['cal_test']
tc, w, p, final, dd, by_price = simulate(test_df, cal, 1000)
for bucket in ['low', 'mid', 'high']:
    bets = by_price[bucket]
    if not bets: continue
    n_bets = len(bets)
    n_wins = sum(1 for b in bets if b['won'])
    total_pnl = sum(b['pnl'] for b in bets)
    avg_size = sum(b['size'] for b in bets) / n_bets
    print(f'  {bucket:>5} ({"<35c" if bucket=="low" else "35-65c" if bucket=="mid" else ">65c"}): {n_bets} trades, {n_wins/n_bets*100:.0f}% WR, ${total_pnl:.0f} PnL, ${avg_size:.1f} avg bet')

# Feature importance comparison
print(f'\n=== FEATURE IMPORTANCE ===')
print(f'{"Feature":<25} {"win":>8} {"high_apy":>10}')
for i, feat in enumerate(FEATURES):
    imp_win = results['win']['model'].feature_importances_[i]
    imp_apy = results['high_apy']['model'].feature_importances_[i]
    print(f'{feat:<25} {imp_win:>8.4f} {imp_apy:>10.4f}')

# Export best model
print('\nExporting high_apy model...')
best = results['high_apy']
best['model'].save_model('/tmp/pm_apy_model.json')

from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType
import onnx

initial_type = [('features', FloatTensorType([None, len(FEATURES)]))]
onnx_model = convert_xgboost(best['model'], initial_types=initial_type)
onnx.save_model(onnx_model, '/Users/will/dev/blockhelix/models/pm_scorer_apy.onnx')

iso_data = {'x': best['iso'].X_thresholds_.tolist(), 'y': best['iso'].y_thresholds_.tolist()}
with open('/Users/will/dev/blockhelix/models/pm_apy_calibration.json', 'w') as f:
    json.dump(iso_data, f)

# Save features list (has extra payoff_ratio)
with open('/Users/will/dev/blockhelix/models/pm_apy_features.json', 'w') as f:
    json.dump(FEATURES, f)

print('Exported: models/pm_scorer_apy.onnx + pm_apy_calibration.json')
