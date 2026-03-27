"""
Train a proper Kelly sizing model.

Instead of predicting return_per_hour and converting to bet size with arbitrary formula,
directly predict the optimal bet fraction that maximises log wealth growth.

Kelly criterion: f* = p - q/b = p - (1-p)/(payoff_ratio)
For binary prediction markets: payoff = (1/entry_price) - 1 if win, -1 if lose
So f* = p - (1-p) * entry_price / (1 - entry_price)

The model predicts p (probability of winning), then we compute Kelly fraction analytically.
This is properly calibrated because we train to predict actual win probability, not an
arbitrary score.
"""

import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import roc_auc_score, brier_score_loss
import json

DATA_PATH = '/tmp/pm_shadow_export.csv'

print('Loading data...')
df = pd.read_csv(DATA_PATH)
df['win'] = (df['pnl'] > 0).astype(int)
df['hold_hours'] = (df['resolve_ts'] - df['buy_ts']) / (1000 * 60 * 60)
df = df[df['hold_hours'] > 0].copy()

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

FEATURES = [
    'entry_price', 'price_dist_from_half', 'implied_edge',
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
y_train = df['win'].values[:te]
X_cal = df[FEATURES].values[te:ve]
y_cal = df['win'].values[te:ve]
X_val = df[FEATURES].values[ve:ts]
y_val = df['win'].values[ve:ts]
X_test = df[FEATURES].values[ts:]
y_test = df['win'].values[ts:]

print(f'Split: {te} train / {ve-te} calibration / {ts-ve} validation / {n-ts} test\n')

# Train base classifier
print('Training base XGBoost classifier...')
base_model = xgb.XGBClassifier(
    n_estimators=500, max_depth=5, learning_rate=0.05,
    subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
    eval_metric='logloss', early_stopping_rounds=30, random_state=42,
)
base_model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=50)

# Check calibration before
raw_probs_val = base_model.predict_proba(X_val)[:, 1]
print(f'\nBase model - Val AUC: {roc_auc_score(y_val, raw_probs_val):.4f}, Brier: {brier_score_loss(y_val, raw_probs_val):.4f}')

# Calibrate using isotonic regression on calibration set
print('\nCalibrating probabilities with isotonic regression...')
from sklearn.isotonic import IsotonicRegression

raw_probs_cal = base_model.predict_proba(X_cal)[:, 1]
iso = IsotonicRegression(out_of_bounds='clip')
iso.fit(raw_probs_cal, y_cal)

cal_probs_val = iso.predict(raw_probs_val)
print(f'Calibrated - Val AUC: {roc_auc_score(y_val, cal_probs_val):.4f}, Brier: {brier_score_loss(y_val, cal_probs_val):.4f}')

# Check calibration by bucket
print('\nCalibration check (predicted vs actual):')
print(f'{"Bucket":<15} {"Count":>7} {"Pred":>8} {"Actual":>8} {"Gap":>8}')
for lo in np.arange(0, 1, 0.1):
    hi = lo + 0.1
    mask = (cal_probs_val >= lo) & (cal_probs_val < hi)
    if mask.sum() < 10: continue
    pred_avg = cal_probs_val[mask].mean()
    actual_avg = y_val[mask].mean()
    print(f'{lo:.1f}-{hi:.1f}       {mask.sum():>7} {pred_avg:>8.3f} {actual_avg:>8.3f} {abs(pred_avg-actual_avg):>8.3f}')

# Now compute proper Kelly fraction
def kelly_fraction(p, entry_price, half_kelly=True):
    """Compute Kelly bet fraction for a binary prediction market.
    Win payoff: (1/entry_price - 1) per dollar bet
    Loss: -1 per dollar bet
    Kelly: f = p/q_loss - q/(b * q_loss) = p - (1-p)*cost/(1-cost)
    where cost = entry_price, payoff = 1/cost - 1
    """
    b = (1.0 / np.clip(entry_price, 0.01, 0.99)) - 1  # payoff ratio
    q = 1 - p
    f = p - q / b  # Kelly fraction
    f = np.clip(f, 0, 0.25)  # max 25% of bankroll
    if half_kelly:
        f = f * 0.5  # half Kelly for safety
    return f

# Test set evaluation
raw_probs_test = base_model.predict_proba(X_test)[:, 1]
cal_probs_test = iso.predict(raw_probs_test)

print(f'\nTest AUC: {roc_auc_score(y_test, cal_probs_test):.4f}, Brier: {brier_score_loss(y_test, cal_probs_test):.4f}')

test_df = df.iloc[ts:].copy()
test_df['win_prob'] = cal_probs_test
test_df['kelly_f'] = kelly_fraction(cal_probs_test, test_df['entry_price'].values)
total_days = (test_df['buy_ts'].max() - test_df['buy_ts'].min()) / (1000*60*60*24)

print(f'Test period: {total_days:.0f} days, {len(test_df)} trades')
print(f'Kelly fraction stats: mean={test_df["kelly_f"].mean():.4f}, median={test_df["kelly_f"].median():.4f}, max={test_df["kelly_f"].max():.4f}')
print(f'Trades with f>0: {(test_df["kelly_f"] > 0).sum()} ({(test_df["kelly_f"] > 0).mean()*100:.1f}%)')

# Simulate
def simulate(tdf, bankroll, sizing_mode, fill_rate=0.30, slip_bps=50, compound=True):
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

        if rng.random() > fill_rate: skip += 1; continue

        if sizing_mode == 'kelly':
            ps = bankroll * row['kelly_f']
        elif sizing_mode == 'fixed10':
            if row['win_prob'] < 0.5: skip += 1; continue
            ps = 10
        elif sizing_mode == 'fixed_score':
            if row['win_prob'] < 0.5: skip += 1; continue
            ps = 10 * (row['win_prob'] - 0.5) * 4  # 0-20 range
        else:
            ps = 10

        ps = min(ps, cash, 50)  # cap at $50
        if ps < 1: skip += 1; continue

        sc = max(row['our_size'] * row['entry_price'], 0.01)
        raw = row['pnl'] * (ps / sc)
        slip = ps * slip_bps / 10000
        sp = max(raw - slip, -ps)
        cash -= ps
        positions.append({'c': ps, 'p': sp, 'rt': row['resolve_ts']})

    for pos in positions:
        pnl += pos['p']; tc += 1
        if pos['p'] > 0: wins += 1

    final = cash + sum(p['c']+p['p'] for p in positions)
    return tc, wins, pnl, final, mdd, skip

print(f'\n{"Config":<40} {"Trades":>7} {"WR%":>6} {"Final$":>10} {"Return":>8} {"CAGR%":>8} {"MaxDD":>8}')
print('-' * 95)

years = max(total_days / 365, 0.01)

for name, bk, mode in [
    ('$120 fixed $10, prob>0.5',             120,  'fixed10'),
    ('$120 Kelly (half)',                     120,  'kelly'),
    ('$120 score-scaled',                    120,  'fixed_score'),
    ('$1k fixed $10, prob>0.5',             1000,  'fixed10'),
    ('$1k Kelly (half)',                    1000,  'kelly'),
    ('$5k fixed $10, prob>0.5',             5000,  'fixed10'),
    ('$5k Kelly (half)',                    5000,  'kelly'),
    ('$5k Kelly (half), no compound',       5000,  'kelly'),
]:
    comp = 'no compound' not in name
    tc, w, p, final, dd, sk = simulate(test_df, bk, mode, compound=comp)
    wr = w / max(tc, 1) * 100
    ret = (final - bk) / bk * 100
    cagr = ((final / bk) ** (1/years) - 1) * 100 if final > 0 else -100
    print(f'{name:<40} {tc:>7} {wr:>5.1f}% ${final:>9.0f} {ret:>7.0f}% {cagr:>7.0f}% ${dd:>7.0f}')

# Export calibrated model
print('\nExporting calibrated model...')
base_model.save_model('/tmp/pm_kelly_proper_base.json')

# Save isotonic calibration as lookup table
iso_x = iso.X_thresholds_
iso_y = iso.y_thresholds_
cal_data = {'x': iso_x.tolist(), 'y': iso_y.tolist()}
with open('/tmp/pm_kelly_proper_calibration.json', 'w') as f:
    json.dump(cal_data, f)

# Export to ONNX
from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType
import onnx

initial_type = [('features', FloatTensorType([None, 16]))]
onnx_model = convert_xgboost(base_model, initial_types=initial_type)
onnx.save_model(onnx_model, '/Users/will/dev/blockhelix/models/pm_scorer_kelly_proper.onnx')

# Save calibration for TypeScript
import shutil
shutil.copy('/tmp/pm_kelly_proper_calibration.json', '/Users/will/dev/blockhelix/models/pm_kelly_calibration.json')

print('Models exported:')
print('  models/pm_scorer_kelly_proper.onnx (base classifier)')
print('  models/pm_kelly_calibration.json (isotonic calibration lookup)')
print('\nTo use: run base model -> get raw prob -> isotonic lookup -> Kelly fraction')
