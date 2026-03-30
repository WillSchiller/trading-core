"""
Retrain model with proper features including outcome type and payoff structure.
Let the model learn the Yes/No asymmetry instead of hand-picking filters.
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

# Filter out 5-min markets
df = df[~df['market_slug'].str.contains('updown-5m', na=False)].copy()
print(f'After removing 5-min: {len(df)} trades')

# Original features
df['cat_sports'] = (df['category'] == 'SPORTS').astype(int)
df['cat_crypto'] = (df['category'] == 'CRYPTO').astype(int)
df['cat_politics'] = (df['category'] == 'POLITICS').astype(int)
df['price_dist_from_half'] = abs(df['entry_price'] - 0.5)
df['implied_edge'] = np.where(df['entry_price'] < 0.5, 1 - df['entry_price'], df['entry_price'])
df['hour'] = pd.to_datetime(df['buy_ts'], unit='ms').dt.hour
df['dow'] = pd.to_datetime(df['buy_ts'], unit='ms').dt.dayofweek
tms = df.groupby('trader_address')['trader_size'].transform('median')
df['size_vs_median'] = df['trader_size'] / tms.clip(lower=0.01)

# NEW features
df['payoff_ratio'] = (1.0 / df['entry_price'].clip(0.01, 0.99)) - 1
df['is_no'] = df['outcome'].str.lower().isin(['no', 'under', 'draw']).astype(int)
df['is_favourite'] = (df['entry_price'] >= 0.5).astype(int)
df['is_no_underdog'] = ((df['is_no'] == 1) & (df['entry_price'] < 0.5)).astype(int)
df['is_no_favourite'] = ((df['is_no'] == 1) & (df['entry_price'] >= 0.5)).astype(int)
df['is_yes_underdog'] = ((df['is_no'] == 0) & (df['entry_price'] < 0.5)).astype(int)
df['is_yes_favourite'] = ((df['is_no'] == 0) & (df['entry_price'] >= 0.5)).astype(int)
df['is_5min'] = df['market_slug'].str.contains('updown-', na=False).astype(int)

df = df.sort_values(['trader_address', 'buy_ts'])

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

FEATURES_V1 = [
    'entry_price', 'price_dist_from_half', 'implied_edge',
    'cat_sports', 'cat_crypto', 'cat_politics',
    'hour', 'dow', 'size_vs_median',
    'roll_wr_20', 'roll_pf_20', 'roll_streak',
    'lifetime_wr', 'lifetime_pf', 'trade_num',
    'market_trader_count',
]

FEATURES_V2 = FEATURES_V1 + [
    'payoff_ratio', 'is_no', 'is_favourite',
    'is_no_underdog', 'is_no_favourite', 'is_yes_underdog', 'is_yes_favourite',
    'is_5min',
]

n = len(df)
te = int(n * 0.5); ve = int(n * 0.7); ts = int(n * 0.85)

print(f'Split: {te} train / {ve-te} cal / {ts-ve} val / {n-ts} test\n')

results = {}

for name, features in [('v1 (current)', FEATURES_V1), ('v2 (+ outcome/payoff)', FEATURES_V2)]:
    X_train = df[features].values[:te]
    y_train = df['win'].values[:te]
    X_cal = df[features].values[te:ve]
    y_cal = df['win'].values[te:ve]
    X_val = df[features].values[ve:ts]
    y_val = df['win'].values[ve:ts]
    X_test = df[features].values[ts:]
    y_test = df['win'].values[ts:]

    print(f'--- {name} ({len(features)} features) ---')
    m = xgb.XGBClassifier(
        n_estimators=500, max_depth=6, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        eval_metric='logloss', early_stopping_rounds=30, random_state=42,
    )
    m.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=0)

    raw_cal = m.predict_proba(X_cal)[:, 1]
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(raw_cal, y_cal)

    raw_test = m.predict_proba(X_test)[:, 1]
    cal_test = iso.predict(raw_test)

    auc = roc_auc_score(y_test, cal_test)
    brier = brier_score_loss(y_test, cal_test)
    print(f'  Test AUC: {auc:.4f}, Brier: {brier:.4f}')

    results[name] = {'model': m, 'iso': iso, 'cal': cal_test, 'features': features, 'auc': auc}

# Calibration comparison by bucket
print('\n=== CALIBRATION BY OUTCOME TYPE (v2, test set) ===')
test_df = df.iloc[ts:].copy()
test_df['v2_prob'] = results['v2 (+ outcome/payoff)']['cal']

for otype in ['yes/team/over', 'no/under/draw']:
    if otype == 'no/under/draw':
        mask = test_df['is_no'] == 1
    else:
        mask = test_df['is_no'] == 0
    subset = test_df[mask]
    print(f'\n{otype}:')
    print(f'  {"Pred Bucket":<15} {"Count":>7} {"Pred":>8} {"Actual":>8}')
    for lo in np.arange(0, 1, 0.1):
        hi = lo + 0.1
        bmask = (subset['v2_prob'] >= lo) & (subset['v2_prob'] < hi)
        if bmask.sum() < 50: continue
        pred = subset.loc[bmask, 'v2_prob'].mean()
        actual = subset.loc[bmask, 'win'].mean()
        print(f'  {lo:.1f}-{hi:.1f}       {bmask.sum():>7} {pred:>8.3f} {actual:>8.3f}')

# Kelly simulation
def kelly_f(p, entry):
    b = (1.0 / np.clip(entry, 0.01, 0.99)) - 1
    return np.clip(p - (1-p)/b, 0, 0.25) * 0.5

def simulate(tdf, probs, bankroll, fill_rate=0.30, slip_bps=50, compound=True):
    tdf = tdf.copy()
    tdf['kf'] = kelly_f(probs, tdf['entry_price'].values)
    tdf = tdf.sort_values('buy_ts')
    rng = np.random.RandomState(42)
    cash = bankroll; positions = []; pnl = 0; tc = 0; wins = 0; skip = 0
    peak = bankroll; mdd = 0

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

        if row['kf'] <= 0: skip += 1; continue
        if rng.random() > fill_rate: skip += 1; continue
        ps = min(bankroll * row['kf'], cash, 50)
        if ps < 1: skip += 1; continue
        sc = max(row['our_size'] * row['entry_price'], 0.01)
        raw = row['pnl'] * (ps / sc)
        sp = max(raw - ps * slip_bps / 10000, -ps)
        cash -= ps; positions.append({'c': ps, 'p': sp, 'rt': row['resolve_ts']})

    for pos in positions:
        pnl += pos['p']; tc += 1
        if pos['p'] > 0: wins += 1
    final = cash + sum(p['c']+p['p'] for p in positions)
    return tc, wins, pnl, final, mdd

total_days = (test_df['buy_ts'].max() - test_df['buy_ts'].min()) / (1000*60*60*24)
years = max(total_days / 365, 0.01)

print(f'\n=== KELLY SIMULATION (test set, {total_days:.0f} days) ===')
print(f'{"Model":<30} {"Bank":>6} {"Trades":>7} {"WR%":>6} {"Final$":>10} {"CAGR%":>8} {"MaxDD":>8}')
print('-' * 80)

for name in results:
    cal = results[name]['cal']
    for bk in [120, 1000, 5000]:
        tc, w, p, final, dd = simulate(test_df, cal, bk)
        wr = w / max(tc, 1) * 100
        cagr = ((final / bk) ** (1/years) - 1) * 100 if final > 0 else -100
        print(f'{name:<30} ${bk:>5} {tc:>7} {wr:>5.1f}% ${final:>9.0f} {cagr:>7.0f}% ${dd:>7.0f}')

# Feature importance
print('\n=== V2 FEATURE IMPORTANCE ===')
for feat, imp in sorted(zip(FEATURES_V2, results['v2 (+ outcome/payoff)']['model'].feature_importances_), key=lambda x: -x[1]):
    print(f'  {feat:<25} {imp:.4f}')

# Export
print('\nExporting v2 model...')
best = results['v2 (+ outcome/payoff)']
from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType
import onnx

initial_type = [('features', FloatTensorType([None, len(FEATURES_V2)]))]
onnx_model = convert_xgboost(best['model'], initial_types=initial_type)
onnx.save_model(onnx_model, '/Users/will/dev/blockhelix/models/pm_scorer_v2.onnx')

iso_data = {'x': best['iso'].X_thresholds_.tolist(), 'y': best['iso'].y_thresholds_.tolist()}
with open('/Users/will/dev/blockhelix/models/pm_v2_calibration.json', 'w') as f:
    json.dump(iso_data, f)

with open('/Users/will/dev/blockhelix/models/pm_v2_features.json', 'w') as f:
    json.dump(FEATURES_V2, f)

print(f'Exported: models/pm_scorer_v2.onnx ({len(FEATURES_V2)} features)')
print(f'v1 AUC: {results["v1 (current)"]["auc"]:.4f}')
print(f'v2 AUC: {results["v2 (+ outcome/payoff)"]["auc"]:.4f}')
