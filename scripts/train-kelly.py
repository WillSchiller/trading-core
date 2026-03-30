import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.metrics import roc_auc_score
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
    pnls = group['pnl'].values; wins = group['win'].values; n = len(pnls)
    r = np.full(n, np.nan); p = np.full(n, np.nan); s = np.full(n, 0.0)
    lw = np.full(n, np.nan); lp = np.full(n, np.nan); tn = np.arange(1,n+1,dtype=float)
    cw=0; cgw=0.0; cgl=0.0
    for i in range(n):
        if i>0: lw[i]=cw/i; lp[i]=cgw/max(cgl,0.001)
        if i>=20:
            w=pnls[i-20:i]; ww=sum(1 for x in w if x>0); gw=sum(x for x in w if x>0); gl=abs(sum(x for x in w if x<0))
            r[i]=ww/20; p[i]=gw/max(gl,0.001)
        if i>0:
            st=0
            for j in range(i-1,-1,-1):
                if wins[j]==wins[i-1]: st+=1
                else: break
            s[i]=st if wins[i-1]==1 else -st
        cw+=wins[i]
        if pnls[i]>0: cgw+=pnls[i]
        else: cgl+=abs(pnls[i])
    group=group.copy()
    group['roll_wr_20']=r; group['roll_pf_20']=p; group['roll_streak']=s
    group['lifetime_wr']=lw; group['lifetime_pf']=lp; group['trade_num']=tn
    return group

print('Computing features...')
df = df.groupby('trader_address', group_keys=False).apply(rolling_features)
df = df.dropna(subset=['roll_wr_20','lifetime_wr'])
mc = df.groupby('market_slug').size().rename('market_trader_count')
df = df.join(mc, on='market_slug')

FEATURES = [
    'entry_price','price_dist_from_half','implied_edge',
    'cat_sports','cat_crypto','cat_politics',
    'hour','dow','size_vs_median',
    'roll_wr_20','roll_pf_20','roll_streak',
    'lifetime_wr','lifetime_pf','trade_num',
    'market_trader_count',
]

# Regression target: PnL per dollar per hour (capital efficiency)
shadow_cost = (df['our_size'] * df['entry_price']).clip(lower=0.1)
df['return_per_hour'] = (df['pnl'] / shadow_cost) / df['hold_hours'].clip(lower=0.5)

n = len(df); te = int(n*0.6); ve = int(n*0.8)

# Train regression model: predict return_per_hour
print(f'Split: {te} train / {ve-te} val / {n-ve} test')

X_train = df[FEATURES].values[:te]
X_val = df[FEATURES].values[te:ve]
X_test = df[FEATURES].values[ve:]

y_train = df['return_per_hour'].values[:te]
y_val = df['return_per_hour'].values[te:ve]
y_test = df['return_per_hour'].values[ve:]

print('\nTraining regression model (predict return per dollar per hour)...')
reg = xgb.XGBRegressor(
    n_estimators=500, max_depth=5, learning_rate=0.05,
    subsample=0.8, colsample_bytree=0.8, min_child_weight=10,
    eval_metric='rmse', early_stopping_rounds=30, random_state=42,
)
reg.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=50)

test_preds = reg.predict(X_test)
print(f'\nTest correlation: {np.corrcoef(y_test, test_preds)[0,1]:.4f}')

# Also load the classifier for comparison
clf = xgb.XGBClassifier()
clf.load_model('/tmp/pm_scorer_model.json')
clf_probs = clf.predict_proba(X_test)[:, 1]

# Simulate with dynamic sizing
test_df = df.iloc[ve:].copy()
total_days = (test_df['buy_ts'].max() - test_df['buy_ts'].min()) / (1000 * 60 * 60 * 24)
print(f'\nTest period: {total_days:.0f} days')

def simulate(trades_df, scores, bankroll, sizing_mode='fixed', fixed_size=10, min_score=0.0):
    trades_df = trades_df.copy()
    trades_df['score'] = scores
    trades_df = trades_df.sort_values('buy_ts')

    cash = bankroll
    positions = []
    total_pnl = 0; trade_count = 0; wins = 0; skipped = 0
    peak = bankroll; max_dd = 0
    sizes_used = []

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

        if row['score'] < min_score:
            skipped += 1; continue

        if sizing_mode == 'fixed':
            pos_size = min(fixed_size, cash)
        elif sizing_mode == 'kelly':
            # Kelly: bet proportional to predicted edge
            # For regression: score is predicted return/hr, use as edge proxy
            edge = max(0, row['score'])
            kelly_frac = min(0.05, edge * 0.1)  # conservative: max 5% of bankroll
            pos_size = min(bankroll * kelly_frac, cash, 50)  # cap at $50
            pos_size = max(pos_size, 0)
        elif sizing_mode == 'score_scaled':
            # Scale position size by classifier confidence
            confidence = row['score']
            pos_size = min(fixed_size * confidence * 2, cash, 50)
        else:
            pos_size = fixed_size

        if pos_size < 1:
            skipped += 1; continue

        shadow_cost = row['our_size'] * row['entry_price']
        scale = pos_size / max(shadow_cost, 0.01)
        scaled_pnl = max(row['pnl'] * scale, -pos_size)
        cash -= pos_size
        positions.append({'cost': pos_size, 'pnl': scaled_pnl, 'resolve_ts': row['resolve_ts']})
        sizes_used.append(pos_size)

    for pos in positions:
        total_pnl += pos['pnl']
        if pos['pnl'] > 0: wins += 1
        trade_count += 1

    avg_size = np.mean(sizes_used) if sizes_used else 0
    return {'trades': trade_count, 'wins': wins, 'pnl': total_pnl, 'skipped': skipped, 'max_dd': max_dd, 'avg_size': avg_size}

configs = [
    ('Fixed $10, no model',        clf_probs * 0 + 1,  5000, 'fixed', 10, 0.0),
    ('Fixed $10, classifier>0.5',  clf_probs,          5000, 'fixed', 10, 0.5),
    ('Fixed $10, classifier>0.7',  clf_probs,          5000, 'fixed', 10, 0.7),
    ('Fixed $10, classifier>0.8',  clf_probs,          5000, 'fixed', 10, 0.8),
    ('Fixed $25, classifier>0.5',  clf_probs,          5000, 'fixed', 25, 0.5),
    ('Score-scaled, clf>0.5',      clf_probs,          5000, 'score_scaled', 10, 0.5),
    ('Score-scaled, clf>0.7',      clf_probs,          5000, 'score_scaled', 10, 0.7),
    ('Kelly, regression>0',        test_preds,         5000, 'kelly', 10, 0.0),
    ('Kelly, regression>0.01',     test_preds,         5000, 'kelly', 10, 0.01),
    ('Kelly, regression>0.05',     test_preds,         5000, 'kelly', 10, 0.05),
    # $1k comparison
    ('$1k Fixed $10, clf>0.5',     clf_probs,          1000, 'fixed', 10, 0.5),
    ('$1k Score-scaled, clf>0.5',  clf_probs,          1000, 'score_scaled', 10, 0.5),
    ('$1k Kelly, reg>0.01',        test_preds,         1000, 'kelly', 10, 0.01),
]

print(f'\n{"Config":<32} {"Trades":>7} {"Wins":>6} {"WR%":>6} {"PnL":>10} {"$/day":>8} {"APY%":>8} {"MaxDD":>8} {"AvgSz":>6} {"Skip%":>6}')
print('-' * 115)

for name, scores, bankroll, mode, size, threshold in configs:
    r = simulate(test_df, scores, bankroll, mode, size, threshold)
    daily = r['pnl'] / max(total_days, 1)
    apy = (daily / bankroll) * 365 * 100
    wr = r['wins'] / max(r['trades'], 1) * 100
    total = r['trades'] + r['skipped']
    skip_pct = r['skipped'] / max(total, 1) * 100
    print(f'{name:<32} {r["trades"]:>7} {r["wins"]:>6} {wr:>5.1f}% ${r["pnl"]:>8.0f} ${daily:>7.2f} {apy:>7.0f}% ${r["max_dd"]:>7.0f} ${r["avg_size"]:>5.1f} {skip_pct:>5.0f}%')

# Feature importance for regression
print('\n=== REGRESSION FEATURE IMPORTANCE ===')
for feat, imp in sorted(zip(FEATURES, reg.feature_importances_), key=lambda x: -x[1]):
    print(f'  {feat:>25}: {imp:.4f}')
