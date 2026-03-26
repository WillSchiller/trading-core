import pandas as pd
import numpy as np
import xgboost as xgb
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
trader_median_size = df.groupby('trader_address')['trader_size'].transform('median')
df['size_vs_median'] = df['trader_size'] / trader_median_size.clip(lower=0.01)

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
    cum_wins = 0; cum_gw = 0.0; cum_gl = 0.0
    for i in range(n):
        if i > 0:
            lifetime_wr[i] = cum_wins / i
            lifetime_pf[i] = cum_gw / max(cum_gl, 0.001)
        if i >= 20:
            window = pnls[i-20:i]
            w = sum(1 for p in window if p > 0)
            gw = sum(p for p in window if p > 0)
            gl = abs(sum(p for p in window if p < 0))
            roll_wr_20[i] = w / 20
            roll_pf_20[i] = gw / max(gl, 0.001)
        if i > 0:
            streak = 0
            for j in range(i-1, -1, -1):
                if wins[j] == wins[i-1]: streak += 1
                else: break
            roll_streak[i] = streak if wins[i-1] == 1 else -streak
        cum_wins += wins[i]
        if pnls[i] > 0: cum_gw += pnls[i]
        else: cum_gl += abs(pnls[i])
    group = group.copy()
    group['roll_wr_20'] = roll_wr_20
    group['roll_pf_20'] = roll_pf_20
    group['roll_streak'] = roll_streak
    group['lifetime_wr'] = lifetime_wr
    group['lifetime_pf'] = lifetime_pf
    group['trade_num'] = trade_num
    return group

print('Computing features...')
df = df.groupby('trader_address', group_keys=False).apply(rolling_features)
df = df.dropna(subset=['roll_wr_20', 'lifetime_wr'])
market_counts = df.groupby('market_slug').size().rename('market_trader_count')
df = df.join(market_counts, on='market_slug')

FEATURES = [
    'entry_price', 'price_dist_from_half', 'implied_edge',
    'cat_sports', 'cat_crypto', 'cat_politics',
    'hour', 'dow', 'size_vs_median',
    'roll_wr_20', 'roll_pf_20', 'roll_streak',
    'lifetime_wr', 'lifetime_pf', 'trade_num',
    'market_trader_count',
]

# Capital-aware label: PnL per hour of capital locked
# This rewards trades that win big and resolve fast
# Penalises trades that tie up capital for days even if they win
df['pnl_per_hour'] = df['pnl'] / df['hold_hours'].clip(lower=0.5)
# Normalize to 0-1 for classification: top 50% by pnl_per_hour = 1, bottom = 0
df['capital_efficient'] = (df['pnl_per_hour'] > df['pnl_per_hour'].median()).astype(int)

n = len(df)
train_end = int(n * 0.6)
val_end = int(n * 0.8)

X_train = df[FEATURES].values[:train_end]
X_val = df[FEATURES].values[train_end:val_end]
X_test = df[FEATURES].values[val_end:]

print(f'Split: {train_end} train / {val_end - train_end} val / {n - val_end} test\n')

# Train 3 models and compare
models = {}
labels = {
    'win_only': ('win', 'Predicts: will this trade win?'),
    'capital_aware': ('capital_efficient', 'Predicts: is this trade capital-efficient (high PnL/hour)?'),
}

for name, (label_col, desc) in labels.items():
    y_train = df[label_col].values[:train_end]
    y_val = df[label_col].values[train_end:val_end]
    y_test = df[label_col].values[val_end:]

    print(f'--- Training: {name} ---')
    print(f'  {desc}')
    print(f'  Train positive rate: {y_train.mean():.3f}')

    m = xgb.XGBClassifier(
        n_estimators=500, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
        eval_metric='logloss', early_stopping_rounds=30, random_state=42,
    )
    m.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=0)

    from sklearn.metrics import roc_auc_score
    val_probs = m.predict_proba(X_val)[:, 1]
    test_probs = m.predict_proba(X_test)[:, 1]
    print(f'  Val AUC: {roc_auc_score(y_val, val_probs):.4f}')
    print(f'  Test AUC: {roc_auc_score(y_test, test_probs):.4f}')
    models[name] = m
    print()

# Now simulate both models capital-constrained
test_df = df.iloc[val_end:].copy()
total_days = (test_df['buy_ts'].max() - test_df['buy_ts'].min()) / (1000 * 60 * 60 * 24)

def simulate(trades_df, scores, bankroll, max_pos, threshold):
    trades_df = trades_df.copy()
    trades_df['score'] = scores
    trades_df = trades_df.sort_values('buy_ts')

    cash = bankroll
    positions = []
    total_pnl = 0; trade_count = 0; wins = 0; skipped = 0
    peak = bankroll; max_dd = 0

    for _, row in trades_df.iterrows():
        for i in range(len(positions) - 1, -1, -1):
            if positions[i]['resolve_ts'] <= row['buy_ts']:
                pos = positions.pop(i)
                cash += max(0, pos['cost'] + pos['pnl'])
                total_pnl += pos['pnl']
                if pos['pnl'] > 0: wins += 1
                trade_count += 1
                equity = cash + sum(p['cost'] + p['pnl'] for p in positions)
                if equity > peak: peak = equity
                if equity - peak < max_dd: max_dd = equity - peak

        if row['score'] < threshold:
            skipped += 1; continue
        pos_size = min(max_pos, cash)
        if pos_size < 1:
            skipped += 1; continue

        shadow_cost = row['our_size'] * row['entry_price']
        scale = pos_size / max(shadow_cost, 0.01)
        scaled_pnl = max(row['pnl'] * scale, -pos_size)
        cash -= pos_size
        positions.append({'cost': pos_size, 'pnl': scaled_pnl, 'resolve_ts': row['resolve_ts']})

    for pos in positions:
        total_pnl += pos['pnl']
        if pos['pnl'] > 0: wins += 1
        trade_count += 1

    return {'trades': trade_count, 'wins': wins, 'pnl': total_pnl, 'skipped': skipped, 'max_dd': max_dd}

X_test_feat = test_df[FEATURES].values

print('=' * 110)
print('CAPITAL-CONSTRAINED COMPARISON ($1k bankroll, $10 positions)')
print('=' * 110)
print(f'{"Model":<30} {"Thresh":<8} {"Trades":>7} {"Wins":>6} {"WR%":>6} {"PnL":>10} {"$/day":>8} {"APY%":>8} {"MaxDD":>8} {"Skip%":>6}')
print('-' * 110)

for name, m in models.items():
    probs = m.predict_proba(X_test_feat)[:, 1]
    for threshold in [0.0, 0.3, 0.5, 0.7, 0.8]:
        r = simulate(test_df, probs, 1000, 10, threshold)
        daily = r['pnl'] / max(total_days, 1)
        apy = (daily / 1000) * 365 * 100
        wr = r['wins'] / max(r['trades'], 1) * 100
        total = r['trades'] + r['skipped']
        skip_pct = r['skipped'] / max(total, 1) * 100
        print(f'{name:<30} {threshold:<8.1f} {r["trades"]:>7} {r["wins"]:>6} {wr:>5.1f}% ${r["pnl"]:>8.0f} ${daily:>7.2f} {apy:>7.0f}% ${r["max_dd"]:>7.0f} {skip_pct:>5.0f}%')
    print()

# Feature importance comparison
print('=== FEATURE IMPORTANCE COMPARISON ===')
print(f'{"Feature":<25} {"win_only":>10} {"capital_aware":>15}')
print('-' * 55)
for i, feat in enumerate(FEATURES):
    imp_win = models['win_only'].feature_importances_[i]
    imp_cap = models['capital_aware'].feature_importances_[i]
    print(f'{feat:<25} {imp_win:>10.4f} {imp_cap:>15.4f}')
