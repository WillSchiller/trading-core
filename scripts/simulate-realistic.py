import pandas as pd
import numpy as np
import xgboost as xgb
import json

DATA_PATH = '/tmp/pm_shadow_export.csv'

print('Loading...')
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

print('Features...')
df = df.groupby('trader_address', group_keys=False).apply(rolling_features)
df = df.dropna(subset=['roll_wr_20','lifetime_wr'])
mc = df.groupby('market_slug').size().rename('market_trader_count')
df = df.join(mc, on='market_slug')

FEATURES = ['entry_price','price_dist_from_half','implied_edge','cat_sports','cat_crypto','cat_politics','hour','dow','size_vs_median','roll_wr_20','roll_pf_20','roll_streak','lifetime_wr','lifetime_pf','trade_num','market_trader_count']

n = len(df); ve = int(n*0.8)
test_df = df.iloc[ve:].copy()
total_days = (test_df['buy_ts'].max() - test_df['buy_ts'].min()) / (1000*60*60*24)

clf = xgb.XGBClassifier()
clf.load_model('/tmp/pm_scorer_model.json')
test_df['score'] = clf.predict_proba(test_df[FEATURES].values)[:, 1]

print(f'Test: {len(test_df)} trades, {total_days:.0f} days\n')

def simulate(trades_df, bankroll, max_pos, min_score, fill_rate=1.0, slippage_bps=0, latency_miss_pct=0):
    trades_df = trades_df.sort_values('buy_ts')
    rng = np.random.RandomState(42)

    cash = bankroll
    positions = []
    total_pnl = 0; trade_count = 0; wins = 0; skipped = 0; missed = 0
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

        if row['score'] < min_score:
            skipped += 1; continue

        pos_size = min(max_pos, cash)
        if pos_size < 1:
            skipped += 1; continue

        # Latency: miss some trades because price moved
        if rng.random() < latency_miss_pct:
            missed += 1; continue

        # Fill rate: some orders don't fill
        if rng.random() > fill_rate:
            missed += 1; continue

        # Slippage: worse entry price reduces PnL
        shadow_cost = max(row['our_size'] * row['entry_price'], 0.01)
        scale = pos_size / shadow_cost
        raw_pnl = row['pnl'] * scale
        slippage_cost = pos_size * slippage_bps / 10000
        scaled_pnl = max(raw_pnl - slippage_cost, -pos_size)

        cash -= pos_size
        positions.append({'cost': pos_size, 'pnl': scaled_pnl, 'resolve_ts': row['resolve_ts']})

    for pos in positions:
        total_pnl += pos['pnl']
        if pos['pnl'] > 0: wins += 1
        trade_count += 1

    return {'trades': trade_count, 'wins': wins, 'pnl': total_pnl, 'skipped': skipped, 'missed': missed, 'max_dd': max_dd}

configs = [
    # Perfect execution (what we've been showing)
    ('Perfect, $10, clf>0.5',       5000, 10, 0.5, 1.0,  0,   0),
    ('Perfect, $10, clf>0.7',       5000, 10, 0.7, 1.0,  0,   0),
    ('Perfect, $10, clf>0.8',       5000, 10, 0.8, 1.0,  0,   0),

    # Realistic: 30% fill rate (matches our live experience)
    ('30% fill, $10, clf>0.5',      5000, 10, 0.5, 0.30, 0,   0),
    ('30% fill, $10, clf>0.7',      5000, 10, 0.7, 0.30, 0,   0),
    ('30% fill, $10, clf>0.8',      5000, 10, 0.8, 0.30, 0,   0),

    # Realistic: 30% fill + 50bps slippage
    ('30% fill + slip, $10, >0.5',  5000, 10, 0.5, 0.30, 50,  0),
    ('30% fill + slip, $10, >0.7',  5000, 10, 0.7, 0.30, 50,  0),
    ('30% fill + slip, $10, >0.8',  5000, 10, 0.8, 0.30, 50,  0),

    # Worst case: 30% fill + 100bps slip + 10% latency miss
    ('Worst case, $10, >0.5',       5000, 10, 0.5, 0.30, 100, 0.10),
    ('Worst case, $10, >0.7',       5000, 10, 0.7, 0.30, 100, 0.10),
    ('Worst case, $10, >0.8',       5000, 10, 0.8, 0.30, 100, 0.10),

    # $1k versions
    ('Perfect, $10, $1k, >0.5',     1000, 10, 0.5, 1.0,  0,   0),
    ('30% fill, $10, $1k, >0.5',    1000, 10, 0.5, 0.30, 0,   0),
    ('Worst, $10, $1k, >0.5',       1000, 10, 0.5, 0.30, 100, 0.10),

    # Bigger positions with friction
    ('30% fill, $25, >0.5',         5000, 25, 0.5, 0.30, 50,  0),
    ('30% fill, $25, >0.7',         5000, 25, 0.7, 0.30, 50,  0),
]

print(f'{"Config":<35} {"Trades":>7} {"Wins":>6} {"WR%":>6} {"PnL":>10} {"$/day":>8} {"APY%":>8} {"MaxDD":>8} {"Miss":>6}')
print('-' * 110)

for name, bankroll, max_pos, threshold, fill, slip, lat in configs:
    r = simulate(test_df, bankroll, max_pos, threshold, fill, slip, lat)
    daily = r['pnl'] / max(total_days, 1)
    apy = (daily / bankroll) * 365 * 100
    wr = r['wins'] / max(r['trades'], 1) * 100
    print(f'{name:<35} {r["trades"]:>7} {r["wins"]:>6} {wr:>5.1f}% ${r["pnl"]:>8.0f} ${daily:>7.2f} {apy:>7.0f}% ${r["max_dd"]:>7.0f} {r["missed"]:>6}')
