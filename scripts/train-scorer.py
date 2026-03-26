import pandas as pd
import numpy as np
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import classification_report, roc_auc_score, precision_recall_curve
import xgboost as xgb
import json
import os

DATA_PATH = os.environ.get('DATA_PATH', '/tmp/pm_shadow_export.csv')
MODEL_OUT = os.environ.get('MODEL_OUT', '/tmp/pm_scorer_model.json')

print(f'Loading {DATA_PATH}...')
df = pd.read_csv(DATA_PATH)
print(f'Loaded {len(df)} trades from {df.trader_address.nunique()} traders')

df['win'] = (df['pnl'] > 0).astype(int)
df['hold_hours'] = (df['resolve_ts'] - df['buy_ts']) / (1000 * 60 * 60)
df = df[df['hold_hours'] > 0].copy()

# Category encoding
df['cat_sports'] = (df['category'] == 'SPORTS').astype(int)
df['cat_crypto'] = (df['category'] == 'CRYPTO').astype(int)
df['cat_politics'] = (df['category'] == 'POLITICS').astype(int)

# Entry price features
df['price_dist_from_half'] = abs(df['entry_price'] - 0.5)
df['implied_edge'] = np.where(df['entry_price'] < 0.5, 1 - df['entry_price'], df['entry_price'])

# Time features
df['hour'] = pd.to_datetime(df['buy_ts'], unit='ms').dt.hour
df['dow'] = pd.to_datetime(df['buy_ts'], unit='ms').dt.dayofweek

# Trader size relative to their median (conviction signal)
trader_median_size = df.groupby('trader_address')['trader_size'].transform('median')
df['size_vs_median'] = df['trader_size'] / trader_median_size.clip(lower=0.01)

# Rolling features per trader (using expanding window to avoid leakage)
df = df.sort_values(['trader_address', 'buy_ts'])

def rolling_features(group):
    pnls = group['pnl'].values
    wins = group['win'].values
    n = len(pnls)

    roll_wr_20 = np.full(n, np.nan)
    roll_pf_20 = np.full(n, np.nan)
    roll_streak = np.full(n, 0.0)
    lifetime_wr = np.full(n, np.nan)
    lifetime_pf = np.full(n, np.nan)
    trade_num = np.arange(1, n + 1, dtype=float)

    cum_wins = 0
    cum_gw = 0.0
    cum_gl = 0.0

    for i in range(n):
        # Lifetime stats (up to but NOT including current trade)
        if i > 0:
            lifetime_wr[i] = cum_wins / i
            lifetime_pf[i] = cum_gw / max(cum_gl, 0.001)

        # Rolling 20
        if i >= 20:
            window = pnls[i-20:i]
            w = sum(1 for p in window if p > 0)
            gw = sum(p for p in window if p > 0)
            gl = abs(sum(p for p in window if p < 0))
            roll_wr_20[i] = w / 20
            roll_pf_20[i] = gw / max(gl, 0.001)

        # Current streak (positive = win streak, negative = loss streak)
        if i > 0:
            streak = 0
            for j in range(i-1, -1, -1):
                if wins[j] == wins[i-1]:
                    streak += 1
                else:
                    break
            roll_streak[i] = streak if wins[i-1] == 1 else -streak

        # Update cumulative
        cum_wins += wins[i]
        if pnls[i] > 0:
            cum_gw += pnls[i]
        else:
            cum_gl += abs(pnls[i])

    group = group.copy()
    group['roll_wr_20'] = roll_wr_20
    group['roll_pf_20'] = roll_pf_20
    group['roll_streak'] = roll_streak
    group['lifetime_wr'] = lifetime_wr
    group['lifetime_pf'] = lifetime_pf
    group['trade_num'] = trade_num
    return group

print('Computing rolling features...')
df = df.groupby('trader_address', group_keys=False).apply(rolling_features)
df = df.dropna(subset=['roll_wr_20', 'lifetime_wr'])
print(f'{len(df)} trades after dropping warmup rows')

# Market consensus: how many traders are in the same market_slug at similar time?
market_counts = df.groupby('market_slug').size().rename('market_trader_count')
df = df.join(market_counts, on='market_slug')

FEATURES = [
    'entry_price', 'price_dist_from_half', 'implied_edge',
    'cat_sports', 'cat_crypto', 'cat_politics',
    'hour', 'dow',
    'size_vs_median',
    'roll_wr_20', 'roll_pf_20', 'roll_streak',
    'lifetime_wr', 'lifetime_pf', 'trade_num',
    'market_trader_count',
]

X = df[FEATURES].values
y = df['win'].values

# Temporal split: first 60% train, next 20% val, last 20% test
n = len(X)
train_end = int(n * 0.6)
val_end = int(n * 0.8)

X_train, y_train = X[:train_end], y[:train_end]
X_val, y_val = X[train_end:val_end], y[train_end:val_end]
X_test, y_test = X[val_end:], y[val_end:]

print(f'\nSplit: {train_end} train / {val_end - train_end} val / {n - val_end} test')
print(f'Train win rate: {y_train.mean():.3f}')
print(f'Val win rate: {y_val.mean():.3f}')
print(f'Test win rate: {y_test.mean():.3f}')

# Train XGBoost
print('\nTraining XGBoost...')
model = xgb.XGBClassifier(
    n_estimators=500,
    max_depth=5,
    learning_rate=0.05,
    subsample=0.8,
    colsample_bytree=0.8,
    min_child_weight=10,
    eval_metric='logloss',
    early_stopping_rounds=30,
    random_state=42,
)

model.fit(
    X_train, y_train,
    eval_set=[(X_val, y_val)],
    verbose=50,
)

# Evaluate
print('\n=== VALIDATION SET ===')
val_probs = model.predict_proba(X_val)[:, 1]
val_auc = roc_auc_score(y_val, val_probs)
print(f'AUC: {val_auc:.4f}')

print('\n=== TEST SET ===')
test_probs = model.predict_proba(X_test)[:, 1]
test_auc = roc_auc_score(y_test, test_probs)
print(f'AUC: {test_auc:.4f}')

# Simulate: take top N% of trades by score
print('\n=== SIMULATED APY BY SCORE PERCENTILE (test set) ===')
test_df = df.iloc[val_end:].copy()
test_df['score'] = test_probs
test_df['pnl_orig'] = test_df['pnl']

total_days = (test_df['buy_ts'].max() - test_df['buy_ts'].min()) / (1000 * 60 * 60 * 24)

print(f'{"Percentile":>12} {"Trades":>7} {"WR%":>6} {"PnL":>10} {"AvgPnL":>8} {"$/day":>8} {"APY%":>8}')
print('-' * 65)

for pct in [100, 50, 25, 10, 5, 2, 1]:
    threshold = np.percentile(test_probs, 100 - pct)
    mask = test_probs >= threshold
    selected = test_df[mask]
    if len(selected) < 5:
        continue
    wins = (selected['pnl_orig'] > 0).sum()
    total_pnl = selected['pnl_orig'].sum()
    avg_pnl = total_pnl / len(selected)
    daily_pnl = total_pnl / max(total_days, 1)
    apy = (daily_pnl / 1000) * 365 * 100  # assuming $1k bankroll
    wr = wins / len(selected) * 100
    print(f'Top {pct:>3}%    {len(selected):>7} {wr:>5.1f}% ${total_pnl:>8.0f} ${avg_pnl:>7.2f} ${daily_pnl:>7.2f} {apy:>7.0f}%')

# Feature importance
print('\n=== FEATURE IMPORTANCE ===')
importances = model.feature_importances_
for feat, imp in sorted(zip(FEATURES, importances), key=lambda x: -x[1]):
    print(f'  {feat:>25}: {imp:.4f}')

# Save model
model.save_model(MODEL_OUT)
print(f'\nModel saved to {MODEL_OUT}')

# Save feature list
with open(MODEL_OUT.replace('.json', '_features.json'), 'w') as f:
    json.dump(FEATURES, f)
print(f'Features saved to {MODEL_OUT.replace(".json", "_features.json")}')
