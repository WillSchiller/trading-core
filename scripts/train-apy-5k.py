"""
Train APY model optimised for $5k bankroll.

Instead of labeling based on raw return_per_hour, simulate Kelly at $5k
and label based on contribution to portfolio APY.

A trade is "good" if Kelly at $5k would have sized it AND it was profitable
after accounting for the capital lockup.
"""

import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.isotonic import IsotonicRegression
import json

DATA_PATH = '/tmp/pm_shadow_export.csv'
TARGET_BANKROLL = 5000

print('Loading data...')
df = pd.read_csv(DATA_PATH)
df['win'] = (df['pnl'] > 0).astype(int)
df['hold_hours'] = (df['resolve_ts'] - df['buy_ts']) / (1000 * 60 * 60)
df = df[df['hold_hours'] > 0].copy()

df['cost'] = (df['our_size'] * df['entry_price']).clip(lower=0.01)
df['payoff_ratio'] = (1.0 / df['entry_price'].clip(0.01, 0.99)) - 1

# Kelly-weighted APY label:
# Simulate what a $5k Kelly bet would return per hour
# f = 0.5 * max(0, p - (1-p)/b) where p = actual win rate of trader's last 20
# Then APY contribution = f * bankroll * (pnl/cost) / hold_hours
# Label = top 40% by this metric

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

# Compute Kelly-weighted APY contribution at $5k
# Use rolling WR as proxy for true probability
b = df['payoff_ratio'].values
p_est = df['roll_wr_20'].values
q_est = 1 - p_est
kelly_f = np.clip(p_est - q_est / np.clip(b, 0.01, 100), 0, 0.25) * 0.5
bet_size = TARGET_BANKROLL * kelly_f
bet_size = np.clip(bet_size, 0, 50)  # cap at $50

return_pct = df['pnl'].values / df['cost'].values
apy_contribution = bet_size * return_pct / df['hold_hours'].clip(lower=0.5).values

df['apy_contribution'] = apy_contribution
df['high_apy_5k'] = (apy_contribution > np.percentile(apy_contribution[~np.isnan(apy_contribution)], 60)).astype(int)

FEATURES = [
    'entry_price', 'price_dist_from_half', 'implied_edge', 'payoff_ratio',
    'cat_sports', 'cat_crypto', 'cat_politics',
    'hour', 'dow', 'size_vs_median',
    'roll_wr_20', 'roll_pf_20', 'roll_streak',
    'lifetime_wr', 'lifetime_pf', 'trade_num',
    'market_trader_count',
]

n = len(df)
te = int(n * 0.5); ve = int(n * 0.7); ts = int(n * 0.85)

print(f'Split: {te}/{ve-te}/{ts-ve}/{n-ts}')
print(f'high_apy_5k positive rate: {df["high_apy_5k"].values[:te].mean():.3f}')

# Train all three for comparison
models = {}
for name, col in [('win', 'win'), ('high_apy', 'high_apy_5k')]:
    y_tr = df[col].values[:te]; y_ca = df[col].values[te:ve]
    y_va = df[col].values[ve:ts]; y_te = df[col].values[ts:]

    m = xgb.XGBClassifier(
        n_estimators=500, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        eval_metric='logloss', early_stopping_rounds=30, random_state=42,
    )
    m.fit(df[FEATURES].values[:te], y_tr, eval_set=[(df[FEATURES].values[ve:ts], y_va)], verbose=0)

    raw_ca = m.predict_proba(df[FEATURES].values[te:ve])[:, 1]
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(raw_ca, y_ca)

    raw_te = m.predict_proba(df[FEATURES].values[ts:])[:, 1]
    cal_te = iso.predict(raw_te)
    print(f'{name}: AUC={roc_auc_score(y_te, cal_te):.4f} Brier={brier_score_loss(y_te, cal_te):.4f}')
    models[name] = {'model': m, 'iso': iso, 'cal': cal_te}

# Simulate
test_df = df.iloc[ts:].copy()
total_days = (test_df['buy_ts'].max() - test_df['buy_ts'].min()) / (1000 * 60 * 60 * 24)
years = max(total_days / 365, 0.01)

def kelly_f(p, entry):
    b = (1.0 / np.clip(entry, 0.01, 0.99)) - 1
    return np.clip(p - (1-p) / b, 0, 0.25) * 0.5

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
        ps = min(bankroll * row['kf'], cash, 100)
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

print(f'\nTest: {len(test_df)} trades, {total_days:.0f} days')
print(f'\n{"Model":<15} {"Bank":>6} {"Trades":>7} {"WR%":>6} {"Final$":>10} {"CAGR%":>8} {"MaxDD":>8}')
print('-' * 65)

for name in ['win', 'high_apy']:
    cal = models[name]['cal']
    for bk in [120, 1000, 5000]:
        tc, w, p, final, dd = simulate(test_df, cal, bk)
        wr = w / max(tc, 1) * 100
        cagr = ((final / bk) ** (1/years) - 1) * 100 if final > 0 else -100
        print(f'{name:<15} ${bk:>5} {tc:>7} {wr:>5.1f}% ${final:>9.0f} {cagr:>7.0f}% ${dd:>7.0f}')

# Export
print('\nExporting high_apy model...')
best = models['high_apy']

from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType
import onnx

initial_type = [('features', FloatTensorType([None, len(FEATURES)]))]
onnx_model = convert_xgboost(best['model'], initial_types=initial_type)
onnx.save_model(onnx_model, '/Users/will/dev/blockhelix/models/pm_scorer_apy.onnx')

iso_data = {'x': best['iso'].X_thresholds_.tolist(), 'y': best['iso'].y_thresholds_.tolist()}
with open('/Users/will/dev/blockhelix/models/pm_apy_calibration.json', 'w') as f:
    json.dump(iso_data, f)

with open('/Users/will/dev/blockhelix/models/pm_apy_features.json', 'w') as f:
    json.dump(FEATURES, f)

print('Exported models/pm_scorer_apy.onnx + calibration + features')

# Feature importance
print(f'\n{"Feature":<25} {"win":>8} {"apy_5k":>8}')
for i, feat in enumerate(FEATURES):
    iw = models['win']['model'].feature_importances_[i]
    ia = models['high_apy']['model'].feature_importances_[i]
    print(f'{feat:<25} {iw:>8.4f} {ia:>8.4f}')
