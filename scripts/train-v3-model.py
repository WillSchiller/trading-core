import pandas as pd
import numpy as np
import xgboost as xgb
import re
import json
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.isotonic import IsotonicRegression
from datetime import datetime

DATA_PATH = '/tmp/pm_shadow_export.csv'
MODEL_DIR = '/Users/will/dev/blockhelix/models'

FEATURES_V3 = [
    'entry_price', 'payoff_ratio',
    'cat_sports', 'cat_crypto', 'cat_politics',
    'hour', 'dow', 'size_vs_median',
    'roll_wr_20', 'roll_pf_20', 'roll_streak',
    'lifetime_wr', 'lifetime_pf', 'trade_num',
    'market_trader_count',
    'is_no', 'is_binary_market', 'neg_risk',
    'time_to_resolution', 'price_momentum', 'trader_category_wr',
]

TRAIN_CUTOFF = pd.Timestamp('2026-02-15', tz='UTC')
CAL_CUTOFF = pd.Timestamp('2026-03-01', tz='UTC')

BINARY_OUTCOMES = {'yes', 'no', 'up', 'down', 'over', 'under', 'draw'}

print('Loading data...')
df = pd.read_csv(DATA_PATH)
df['buy_dt'] = pd.to_datetime(df['buy_ts'], unit='ms', utc=True)
df['resolve_dt'] = pd.to_datetime(df['resolve_ts'], unit='ms', utc=True)
df['win'] = (df['pnl'] > 0).astype(int)
df['hold_hours'] = (df['resolve_ts'] - df['buy_ts']) / (1000 * 60 * 60)
df = df[df['hold_hours'] > 0].copy()

# Filter out updown-5m markets
n_before = len(df)
df = df[~df['market_slug'].str.contains('updown-5m', na=False)].copy()
print(f'Filtered updown-5m: {n_before} -> {len(df)} ({n_before - len(df)} removed)')

# Basic features
df['payoff_ratio'] = (1.0 / df['entry_price'].clip(lower=0.01)) - 1
df['cat_sports'] = (df['category'] == 'SPORTS').astype(int)
df['cat_crypto'] = (df['category'] == 'CRYPTO').astype(int)
df['cat_politics'] = (df['category'] == 'POLITICS').astype(int)
df['hour'] = df['buy_dt'].dt.hour
df['dow'] = df['buy_dt'].dt.dayofweek

# neg_risk from column
df['neg_risk'] = df['neg_risk'].map({'t': 1, 'f': 0, True: 1, False: 0}).fillna(0).astype(int)

# is_binary_market and is_no
df['outcome_lower'] = df['outcome'].str.lower().str.strip()
df['is_binary_market'] = df.groupby('market_slug')['outcome_lower'].transform(
    lambda x: int(x.nunique() <= 2 and x.isin(BINARY_OUTCOMES).all())
)
df['is_no'] = df['outcome_lower'].isin({'no', 'down', 'under'}).astype(int)

# time_to_resolution: extract date from slug, compute hours from buy_ts
def extract_resolution_hours(row):
    m = re.search(r'(\d{4}-\d{2}-\d{2})', row['market_slug'])
    if m:
        try:
            res_date = pd.Timestamp(m.group(1), tz='UTC')
            hours = (res_date - row['buy_dt']).total_seconds() / 3600
            if hours > 0:
                return hours
        except Exception:
            pass
    return np.nan

print('Extracting time_to_resolution...')
df['time_to_resolution'] = df.apply(extract_resolution_hours, axis=1)

# Sort globally by trader then buy_ts for rolling features
df = df.sort_values(['trader_address', 'buy_ts']).reset_index(drop=True)

print('Computing per-trader rolling features...')

def rolling_features(group):
    group = group.sort_values('buy_ts').copy()
    pnls = group['pnl'].values
    wins = group['win'].values
    prices = group['entry_price'].values
    sizes = group['trader_size'].values
    cats = group['category'].values
    n = len(pnls)

    r = np.full(n, np.nan)
    p = np.full(n, np.nan)
    s = np.full(n, 0.0)
    lw = np.full(n, np.nan)
    lp = np.full(n, np.nan)
    tn = np.arange(1, n + 1, dtype=float)
    svm = np.full(n, np.nan)

    cw = 0; cgw = 0.0; cgl = 0.0
    running_sizes = []

    # trader_category_wr: expanding win rate per category
    cat_wins = {}
    cat_counts = {}
    tc_wr = np.full(n, np.nan)

    for i in range(n):
        cat = cats[i]

        # lifetime stats (using only past trades, not current)
        if i > 0:
            lw[i] = cw / i
            lp[i] = cgw / max(cgl, 0.001)

        # rolling 20
        if i >= 20:
            w = pnls[i-20:i]
            ww = sum(1 for x in w if x > 0)
            gw = sum(x for x in w if x > 0)
            gl = abs(sum(x for x in w if x < 0))
            r[i] = ww / 20
            p[i] = gw / max(gl, 0.001)

        # streak
        if i > 0:
            st = 0
            for j in range(i - 1, -1, -1):
                if wins[j] == wins[i - 1]:
                    st += 1
                else:
                    break
            s[i] = st if wins[i - 1] == 1 else -st

        # size_vs_median (expanding, past only)
        if len(running_sizes) > 0:
            med = np.median(running_sizes)
            svm[i] = sizes[i] / max(med, 0.01)
        running_sizes.append(sizes[i])

        # trader_category_wr (expanding, past only)
        if cat in cat_counts and cat_counts[cat] > 0:
            tc_wr[i] = cat_wins.get(cat, 0) / cat_counts[cat]
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
        if wins[i] == 1:
            cat_wins[cat] = cat_wins.get(cat, 0) + 1

        # update cumulative
        cw += wins[i]
        if pnls[i] > 0:
            cgw += pnls[i]
        else:
            cgl += abs(pnls[i])

    group['roll_wr_20'] = r
    group['roll_pf_20'] = p
    group['roll_streak'] = s
    group['lifetime_wr'] = lw
    group['lifetime_pf'] = lp
    group['trade_num'] = tn
    group['size_vs_median'] = svm
    group['trader_category_wr'] = tc_wr
    return group

df = df.groupby('trader_address', group_keys=False).apply(rolling_features)
df = df.dropna(subset=['roll_wr_20', 'lifetime_wr'])

# Cap extremes
df['roll_pf_20'] = df['roll_pf_20'].clip(upper=10)
df['lifetime_pf'] = df['lifetime_pf'].clip(upper=10)

# market_trader_count: cumcount per market_slug sorted by buy_ts (no look-ahead)
df = df.sort_values('buy_ts').reset_index(drop=True)
df['market_trader_count'] = df.groupby('market_slug').cumcount() + 1

# price_momentum: entry_price minus expanding mean of prior trades in same market
print('Computing price_momentum...')
market_price_sums = {}
market_price_counts = {}
momentum = np.full(len(df), np.nan)
for i, row in df.iterrows():
    slug = row['market_slug']
    if slug in market_price_counts and market_price_counts[slug] > 0:
        prior_mean = market_price_sums[slug] / market_price_counts[slug]
        momentum[i] = row['entry_price'] - prior_mean
    market_price_sums[slug] = market_price_sums.get(slug, 0.0) + row['entry_price']
    market_price_counts[slug] = market_price_counts.get(slug, 0) + 1
df['price_momentum'] = momentum

print(f'Total rows after feature engineering: {len(df)}')

# Temporal split
train_mask = df['buy_dt'] < TRAIN_CUTOFF
cal_mask = (df['buy_dt'] >= TRAIN_CUTOFF) & (df['buy_dt'] < CAL_CUTOFF)
test_mask = df['buy_dt'] >= CAL_CUTOFF

# Validation: last 10% of training data by date
train_df = df[train_mask].copy()
train_dates = train_df['buy_dt'].sort_values()
val_cutoff = train_dates.quantile(0.9)
val_mask_inner = train_df['buy_dt'] >= val_cutoff
train_inner_mask = train_df['buy_dt'] < val_cutoff

X_train = train_df.loc[train_inner_mask, FEATURES_V3].values
y_train = train_df.loc[train_inner_mask, 'win'].values
X_val = train_df.loc[val_mask_inner, FEATURES_V3].values
y_val = train_df.loc[val_mask_inner, 'win'].values
X_cal = df.loc[cal_mask, FEATURES_V3].values
y_cal = df.loc[cal_mask, 'win'].values
X_test = df.loc[test_mask, FEATURES_V3].values
y_test = df.loc[test_mask, 'win'].values

print(f'\nSplit sizes:')
print(f'  Train:       {len(X_train)} (before {val_cutoff.date()})')
print(f'  Validation:  {len(X_val)} ({val_cutoff.date()} to {TRAIN_CUTOFF.date()})')
print(f'  Calibration: {len(X_cal)} ({TRAIN_CUTOFF.date()} to {CAL_CUTOFF.date()})')
print(f'  Test:        {len(X_test)} ({CAL_CUTOFF.date()}+)')

# Baseline: AUC of raw entry_price
baseline_auc = roc_auc_score(y_test, X_test[:, FEATURES_V3.index('entry_price')])
print(f'\nBaseline AUC (entry_price alone): {baseline_auc:.4f}')

# Train XGBoost
print('\nTraining XGBoost classifier...')
model = xgb.XGBClassifier(
    n_estimators=500, max_depth=6, learning_rate=0.05,
    subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
    eval_metric='logloss', early_stopping_rounds=30, random_state=42,
    use_label_encoder=False,
)
model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=50)

# Raw predictions
raw_test = model.predict_proba(X_test)[:, 1]
raw_cal = model.predict_proba(X_cal)[:, 1]

# Calibrate with isotonic regression
print('\nCalibrating with IsotonicRegression on calibration set...')
iso = IsotonicRegression(y_min=0.01, y_max=0.99, out_of_bounds='clip')
iso.fit(raw_cal, y_cal)
cal_test = iso.predict(raw_test)

# Metrics
v3_auc = roc_auc_score(y_test, cal_test)
raw_auc = roc_auc_score(y_test, raw_test)
brier_baseline = brier_score_loss(y_test, X_test[:, FEATURES_V3.index('entry_price')])
brier_raw = brier_score_loss(y_test, raw_test)
brier_cal = brier_score_loss(y_test, cal_test)

print(f'\n=== AUC COMPARISON ===')
print(f'  Baseline (entry_price): {baseline_auc:.4f}')
print(f'  V3 raw:                 {raw_auc:.4f}')
print(f'  V3 calibrated:          {v3_auc:.4f}')

print(f'\n=== BRIER SCORES (lower is better) ===')
print(f'  Baseline (entry_price): {brier_baseline:.4f}')
print(f'  V3 raw:                 {brier_raw:.4f}')
print(f'  V3 calibrated:          {brier_cal:.4f}')

# Calibration table
print(f'\n=== CALIBRATION TABLE (test set) ===')
print(f'  {"Bucket":>12} {"Count":>7} {"Pred Mean":>10} {"Actual WR":>10} {"Gap":>8}')
buckets = [(0, 0.3), (0.3, 0.4), (0.4, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 1.0)]
for lo, hi in buckets:
    mask = (cal_test >= lo) & (cal_test < hi)
    if mask.sum() == 0:
        continue
    pred_mean = cal_test[mask].mean()
    actual_wr = y_test[mask].mean()
    gap = pred_mean - actual_wr
    print(f'  [{lo:.1f}, {hi:.1f})  {mask.sum():>7} {pred_mean:>10.4f} {actual_wr:>10.4f} {gap:>+8.4f}')

# Feature importance
print(f'\n=== FEATURE IMPORTANCE ===')
for feat, imp in sorted(zip(FEATURES_V3, model.feature_importances_), key=lambda x: -x[1]):
    print(f'  {feat:>25}: {imp:.4f}')

# Kelly simulation
def kelly_f(p, entry):
    b = (1.0 / np.clip(entry, 0.01, 0.99)) - 1
    return np.clip(p - (1 - p) / b, 0, 0.25) * 0.5

def kelly_sim(test_df, probs, bankroll, fill_rate=0.30, slip_bps=50, compound=True):
    tdf = test_df.copy()
    tdf['prob'] = probs
    tdf = tdf.sort_values('buy_ts').reset_index(drop=True)

    rng = np.random.RandomState(42)
    cash = float(bankroll)
    positions = []
    total_pnl = 0.0; trade_count = 0; wins = 0
    peak = float(bankroll); max_dd = 0.0

    for _, row in tdf.iterrows():
        # Resolve matured positions
        for i in range(len(positions) - 1, -1, -1):
            if positions[i]['resolve_ts'] <= row['buy_ts']:
                pos = positions.pop(i)
                cash += pos['cost'] + pos['pnl']
                total_pnl += pos['pnl']
                if pos['pnl'] > 0:
                    wins += 1
                trade_count += 1

        equity = cash + sum(p['cost'] + p['pnl'] for p in positions)
        if equity > peak:
            peak = equity
        dd = equity - peak
        if dd < max_dd:
            max_dd = dd

        if rng.random() > fill_rate:
            continue

        base = equity if compound else bankroll
        kf = kelly_f(row['prob'], row['entry_price'])
        size = base * kf
        slip = size * (slip_bps / 10000)
        size_after_slip = size - slip

        if size_after_slip < 0.50 or size_after_slip > cash:
            continue

        shadow_cost = row['our_size'] * row['entry_price']
        if shadow_cost < 0.01:
            continue
        scale = size_after_slip / shadow_cost
        scaled_pnl = max(row['pnl'] * scale, -size_after_slip)

        cash -= size_after_slip
        positions.append({
            'cost': size_after_slip,
            'pnl': scaled_pnl,
            'resolve_ts': row['resolve_ts'],
        })

    # Resolve remaining
    for pos in positions:
        cash += pos['cost'] + pos['pnl']
        total_pnl += pos['pnl']
        if pos['pnl'] > 0:
            wins += 1
        trade_count += 1

    final_equity = cash
    total_days = (tdf['buy_ts'].max() - tdf['buy_ts'].min()) / (1000 * 60 * 60 * 24)
    daily_pnl = total_pnl / max(total_days, 1)
    apy = (daily_pnl / bankroll) * 365 * 100
    wr = wins / max(trade_count, 1) * 100

    return {
        'trades': trade_count, 'wins': wins, 'wr': wr,
        'pnl': total_pnl, 'final': final_equity,
        'daily': daily_pnl, 'apy': apy, 'max_dd': max_dd,
        'days': total_days,
    }

test_df_sim = df[test_mask].copy()
test_df_sim['prob'] = cal_test

print(f'\n=== KELLY SIMULATION (fill=30%, slip=50bps, compound=True) ===')
print(f'  {"Bankroll":>10} {"Trades":>7} {"WR%":>6} {"PnL":>10} {"Final":>10} {"$/day":>8} {"APY%":>8} {"MaxDD":>8}')
for bankroll in [120, 1000, 5000]:
    r = kelly_sim(test_df_sim, cal_test, bankroll, fill_rate=0.30, slip_bps=50, compound=True)
    print(f'  ${bankroll:>9} {r["trades"]:>7} {r["wr"]:>5.1f}% ${r["pnl"]:>9.2f} ${r["final"]:>9.2f} ${r["daily"]:>7.2f} {r["apy"]:>7.0f}% ${r["max_dd"]:>7.2f}')

# Export ONNX
print('\nExporting ONNX model...')
from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType
import onnx

initial_type = [('features', FloatTensorType([None, len(FEATURES_V3)]))]
onnx_model = convert_xgboost(model, initial_types=initial_type)
onnx_path = f'{MODEL_DIR}/pm_scorer_v3.onnx'
onnx.save_model(onnx_model, onnx_path)
print(f'ONNX model saved to {onnx_path}')

# Export calibration
cal_data = {
    'x': iso.X_thresholds_.tolist(),
    'y': iso.y_thresholds_.tolist(),
}
cal_path = f'{MODEL_DIR}/pm_v3_calibration.json'
with open(cal_path, 'w') as f:
    json.dump(cal_data, f, indent=2)
print(f'Calibration saved to {cal_path}')

# Export features
feat_path = f'{MODEL_DIR}/pm_v3_features.json'
with open(feat_path, 'w') as f:
    json.dump(FEATURES_V3, f, indent=2)
print(f'Features saved to {feat_path}')

print('\nDone.')
