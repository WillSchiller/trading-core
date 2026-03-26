import pandas as pd
import numpy as np
import xgboost as xgb
import json

DATA_PATH = '/tmp/pm_shadow_export.csv'
MODEL_PATH = '/tmp/pm_scorer_model.json'
FEATURES_PATH = '/tmp/pm_scorer_model_features.json'

print('Loading data and model...')
df = pd.read_csv(DATA_PATH)
model = xgb.XGBClassifier()
model.load_model(MODEL_PATH)
with open(FEATURES_PATH) as f:
    FEATURES = json.load(f)

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
    cum_wins = 0
    cum_gw = 0.0
    cum_gl = 0.0
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
                if wins[j] == wins[i-1]:
                    streak += 1
                else:
                    break
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

# Use last 20% as test (same as training script)
n = len(df)
test_start = int(n * 0.8)
test_df = df.iloc[test_start:].copy()

X_test = test_df[FEATURES].values
test_df['score'] = model.predict_proba(X_test)[:, 1]

print(f'Test set: {len(test_df)} trades')
total_days = (test_df['buy_ts'].max() - test_df['buy_ts'].min()) / (1000 * 60 * 60 * 24)
print(f'Period: {total_days:.0f} days\n')

def simulate(trades_df, bankroll, max_pos, score_threshold, buffer_minutes=0):
    trades_df = trades_df.sort_values('buy_ts')
    cash = bankroll
    positions = []
    total_pnl = 0
    trade_count = 0
    wins = 0
    skipped = 0
    peak = bankroll
    max_dd = 0

    if buffer_minutes > 0:
        # Buffer mode: group trades into windows, take top N per window
        window_ms = buffer_minutes * 60 * 1000
        window_start = trades_df['buy_ts'].iloc[0]
        buffer = []

        for _, row in trades_df.iterrows():
            # Resolve positions
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

            if row['buy_ts'] - window_start > window_ms:
                # Process buffer: sort by score, take what we can afford
                buffer.sort(key=lambda x: x['score'], reverse=True)
                for b in buffer:
                    if b['score'] < score_threshold:
                        skipped += 1
                        continue
                    pos_size = min(max_pos, cash)
                    if pos_size < 1:
                        skipped += 1
                        continue
                    shadow_cost = b['shadow_cost']
                    scale = pos_size / max(shadow_cost, 0.01)
                    scaled_pnl = max(b['pnl'] * scale, -pos_size)
                    cash -= pos_size
                    positions.append({'cost': pos_size, 'pnl': scaled_pnl, 'resolve_ts': b['resolve_ts']})
                buffer = []
                window_start = row['buy_ts']

            buffer.append({
                'score': row['score'], 'pnl': row['pnl'],
                'shadow_cost': row['our_size'] * row['entry_price'],
                'resolve_ts': row['resolve_ts'],
            })

        # Final buffer
        buffer.sort(key=lambda x: x['score'], reverse=True)
        for b in buffer:
            if b['score'] < score_threshold:
                skipped += 1
                continue
            pos_size = min(max_pos, cash)
            if pos_size < 1:
                skipped += 1
                continue
            shadow_cost = b['shadow_cost']
            scale = pos_size / max(shadow_cost, 0.01)
            scaled_pnl = max(b['pnl'] * scale, -pos_size)
            cash -= pos_size
            positions.append({'cost': pos_size, 'pnl': scaled_pnl, 'resolve_ts': b['resolve_ts']})
    else:
        # No buffer: take immediately if above threshold
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

            if row['score'] < score_threshold:
                skipped += 1
                continue
            pos_size = min(max_pos, cash)
            if pos_size < 1:
                skipped += 1
                continue
            shadow_cost = row['our_size'] * row['entry_price']
            scale = pos_size / max(shadow_cost, 0.01)
            scaled_pnl = max(row['pnl'] * scale, -pos_size)
            cash -= pos_size
            positions.append({'cost': pos_size, 'pnl': scaled_pnl, 'resolve_ts': row['resolve_ts']})

    # Resolve remaining
    for pos in positions:
        total_pnl += pos['pnl']
        if pos['pnl'] > 0: wins += 1
        trade_count += 1

    return {
        'trades': trade_count, 'wins': wins, 'pnl': total_pnl,
        'skipped': skipped, 'max_dd': max_dd,
    }

configs = [
    # No scoring baseline
    ('No model, $25, $1k',         1000, 25, 0.0,  0),
    ('No model, $10, $1k',         1000, 10, 0.0,  0),
    # Scored, take-first (no buffer)
    ('Score>0.5, $25, $1k',        1000, 25, 0.5,  0),
    ('Score>0.5, $10, $1k',        1000, 10, 0.5,  0),
    ('Score>0.7, $25, $1k',        1000, 25, 0.7,  0),
    ('Score>0.7, $10, $1k',        1000, 10, 0.7,  0),
    ('Score>0.8, $25, $1k',        1000, 25, 0.8,  0),
    ('Score>0.8, $10, $1k',        1000, 10, 0.8,  0),
    # Buffered (collect 10min, take best)
    ('Buffered 10m, $25, $1k',     1000, 25, 0.5, 10),
    ('Buffered 10m, $10, $1k',     1000, 10, 0.5, 10),
    ('Buffered 30m, $25, $1k',     1000, 25, 0.5, 30),
    ('Buffered 30m, $10, $1k',     1000, 10, 0.5, 30),
    # Different bankrolls with scoring
    ('Score>0.5, $10, $100',        100, 10, 0.5,  0),
    ('Score>0.5, $10, $500',        500, 10, 0.5,  0),
    ('Score>0.5, $10, $5k',        5000, 10, 0.5,  0),
    ('Score>0.7, $10, $100',        100, 10, 0.7,  0),
    ('Score>0.7, $10, $500',        500, 10, 0.7,  0),
]

print(f'{"Config":<30} {"Trades":>7} {"Wins":>6} {"WR%":>6} {"PnL":>10} {"$/day":>8} {"APY%":>8} {"MaxDD":>8} {"Skip":>7} {"Skip%":>6}')
print('-' * 110)

for name, bankroll, max_pos, threshold, buffer_min in configs:
    r = simulate(test_df, bankroll, max_pos, threshold, buffer_min)
    daily = r['pnl'] / max(total_days, 1)
    apy = (daily / bankroll) * 365 * 100
    total_possible = r['trades'] + r['skipped']
    skip_pct = r['skipped'] / max(total_possible, 1) * 100
    wr = r['wins'] / max(r['trades'], 1) * 100
    print(f'{name:<30} {r["trades"]:>7} {r["wins"]:>6} {wr:>5.1f}% ${r["pnl"]:>8.0f} ${daily:>7.2f} {apy:>7.0f}% ${r["max_dd"]:>7.0f} {r["skipped"]:>7} {skip_pct:>5.0f}%')
