import pandas as pd
import numpy as np
import xgboost as xgb

DATA_PATH = '/tmp/pm_shadow_export.csv'

print('Loading...')
df = pd.read_csv(DATA_PATH)
df['win'] = (df['pnl'] > 0).astype(int)
df['hold_hours'] = (df['resolve_ts'] - df['buy_ts']) / (1000*60*60)
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
    p=g['pnl'].values; w=g['win'].values; n=len(p)
    r=np.full(n,np.nan);pf=np.full(n,np.nan);s=np.full(n,0.0)
    lw=np.full(n,np.nan);lp=np.full(n,np.nan);tn=np.arange(1,n+1,dtype=float)
    cw=0;cgw=0.0;cgl=0.0
    for i in range(n):
        if i>0: lw[i]=cw/i; lp[i]=cgw/max(cgl,0.001)
        if i>=20:
            ww=p[i-20:i]; wins=sum(1 for x in ww if x>0)
            gw=sum(x for x in ww if x>0); gl=abs(sum(x for x in ww if x<0))
            r[i]=wins/20; pf[i]=gw/max(gl,0.001)
        if i>0:
            st=0
            for j in range(i-1,-1,-1):
                if w[j]==w[i-1]: st+=1
                else: break
            s[i]=st if w[i-1]==1 else -st
        cw+=w[i]
        if p[i]>0: cgw+=p[i]
        else: cgl+=abs(p[i])
    g=g.copy()
    g['roll_wr_20']=r;g['roll_pf_20']=pf;g['roll_streak']=s
    g['lifetime_wr']=lw;g['lifetime_pf']=lp;g['trade_num']=tn
    return g

df = df.groupby('trader_address', group_keys=False).apply(rf)
df = df.dropna(subset=['roll_wr_20','lifetime_wr'])
mc = df.groupby('market_slug').size().rename('market_trader_count')
df = df.join(mc, on='market_slug')

FEATURES = ['entry_price','price_dist_from_half','implied_edge','cat_sports','cat_crypto','cat_politics','hour','dow','size_vs_median','roll_wr_20','roll_pf_20','roll_streak','lifetime_wr','lifetime_pf','trade_num','market_trader_count']

n = len(df); ve = int(n*0.8)
test_df = df.iloc[ve:].copy()

clf = xgb.XGBClassifier()
clf.load_model('/tmp/pm_scorer_model.json')
test_df['score'] = clf.predict_proba(test_df[FEATURES].values)[:, 1]

# Kelly regression model
n_full = len(df)
te = int(n_full * 0.6)
ve_idx = int(n_full * 0.8)
shadow_cost = (df['our_size'] * df['entry_price']).clip(lower=0.1)
df['return_per_hour'] = (df['pnl'] / shadow_cost) / df['hold_hours'].clip(lower=0.5)
reg = xgb.XGBRegressor(n_estimators=500,max_depth=5,learning_rate=0.05,subsample=0.8,colsample_bytree=0.8,min_child_weight=10,eval_metric='rmse',early_stopping_rounds=30,random_state=42)
reg.fit(df[FEATURES].values[:te], df['return_per_hour'].values[:te], eval_set=[(df[FEATURES].values[te:ve_idx], df['return_per_hour'].values[te:ve_idx])], verbose=0)
test_df['kelly_score'] = reg.predict(test_df[FEATURES].values)

total_days = (test_df['buy_ts'].max() - test_df['buy_ts'].min()) / (1000*60*60*24)
print(f'Test: {len(test_df)} trades, {total_days:.0f} days\n')

def simulate(tdf, start_bankroll, pos_pct, min_score, fill_rate, slip_bps, compound, max_pos_cap=None, kelly=False):
    tdf = tdf.sort_values('buy_ts')
    rng = np.random.RandomState(42)

    bankroll = start_bankroll
    cash = bankroll
    positions = []
    total_pnl = 0; tc = 0; wins = 0; skip = 0; miss = 0
    peak = bankroll; mdd = 0
    monthly = {}

    for _, row in tdf.iterrows():
        for i in range(len(positions)-1, -1, -1):
            if positions[i]['rt'] <= row['buy_ts']:
                pos = positions.pop(i)
                ret = max(0, pos['c'] + pos['p'])
                cash += ret
                total_pnl += pos['p']
                if pos['p'] > 0: wins += 1
                tc += 1

                if compound:
                    bankroll = cash + sum(p['c'] + p['p'] for p in positions)

                equity = cash + sum(p['c'] + p['p'] for p in positions)
                if equity > peak: peak = equity
                if equity - peak < mdd: mdd = equity - peak

                month = pd.Timestamp(row['buy_ts'], unit='ms').strftime('%Y-%m')
                monthly[month] = monthly.get(month, 0) + pos['p']

        score_col = 'kelly_score' if kelly else 'score'
        if row[score_col] < min_score: skip += 1; continue
        if rng.random() > fill_rate: miss += 1; continue

        if kelly:
            edge = max(0, row['kelly_score'])
            kelly_frac = min(0.05, edge * 0.1)
            pos_size = bankroll * kelly_frac
        else:
            pos_size = bankroll * pos_pct
        if max_pos_cap: pos_size = min(pos_size, max_pos_cap)
        pos_size = min(pos_size, cash)
        if pos_size < 1: skip += 1; continue

        sc = max(row['our_size'] * row['entry_price'], 0.01)
        raw = row['pnl'] * (pos_size / sc)
        slip_cost = pos_size * slip_bps / 10000
        sp = max(raw - slip_cost, -pos_size)

        cash -= pos_size
        positions.append({'c': pos_size, 'p': sp, 'rt': row['resolve_ts']})

    for pos in positions:
        total_pnl += pos['p']
        if pos['p'] > 0: wins += 1
        tc += 1

    final_equity = cash + sum(p['c'] + p['p'] for p in positions)
    return tc, wins, total_pnl, final_equity, mdd, monthly

configs = [
    # Fixed bankroll (no compounding)
    ('$1k fixed, 1% pos, clf>0.5',    1000, 0.01, 0.5, 0.30, 50, False, None, False),
    ('$1k fixed, 2.5% pos, clf>0.5',  1000, 0.025, 0.5, 0.30, 50, False, None, False),
    ('$5k fixed, 0.5% pos, clf>0.5',  5000, 0.005, 0.5, 0.30, 50, False, None, False),
    ('$5k fixed, 1% pos, clf>0.5',    5000, 0.01, 0.5, 0.30, 50, False, None, False),

    # Compounding
    ('$1k compound, 1% pos, >0.5',    1000, 0.01, 0.5, 0.30, 50, True, None, False),
    ('$1k compound, 2.5% pos, >0.5',  1000, 0.025, 0.5, 0.30, 50, True, None, False),
    ('$5k compound, 0.5% pos, >0.5',  5000, 0.005, 0.5, 0.30, 50, True, None, False),
    ('$5k compound, 1% pos, >0.5',    5000, 0.01, 0.5, 0.30, 50, True, None, False),

    # Compounding with cap
    ('$1k compound, 2.5%, cap $50',    1000, 0.025, 0.5, 0.30, 50, True, 50, False),
    ('$5k compound, 1%, cap $100',     5000, 0.01, 0.5, 0.30, 50, True, 100, False),
    ('$5k compound, 2%, cap $200',     5000, 0.02, 0.5, 0.30, 50, True, 200, False),

    # Higher threshold
    ('$5k compound, 1% pos, >0.7',    5000, 0.01, 0.7, 0.30, 50, True, None, False),
    ('$5k compound, 1% pos, >0.8',    5000, 0.01, 0.8, 0.30, 50, True, None, False),

    # Kelly compounding
    ('$1k Kelly compound',             1000, 0, 0.01, 0.30, 50, True, 50, True),
    ('$5k Kelly compound',             5000, 0, 0.01, 0.30, 50, True, 100, True),
    ('$5k Kelly compound cap$50',      5000, 0, 0.01, 0.30, 50, True, 50, True),
    ('$5k Kelly compound cap$200',     5000, 0, 0.05, 0.30, 50, True, 200, True),

    # Kelly no compound baseline
    ('$5k Kelly fixed',                5000, 0, 0.05, 0.30, 50, False, 50, True),
]

print(f'{"Config":<35} {"Trades":>7} {"WR%":>6} {"Final$":>10} {"Return":>8} {"CAGR%":>8} {"MaxDD":>8}')
print('-' * 90)

years = total_days / 365

for name, bk, pp, ms, fr, sl, comp, cap, kel in configs:
    tc, w, pnl, final, dd, monthly = simulate(test_df, bk, pp, ms, fr, sl, comp, cap, kel)
    wr = w / max(tc, 1) * 100
    ret = (final - bk) / bk * 100
    cagr = ((final / bk) ** (1 / max(years, 0.01)) - 1) * 100 if final > 0 else -100
    print(f'{name:<35} {tc:>7} {wr:>5.1f}% ${final:>9.0f} {ret:>7.0f}% {cagr:>7.0f}% ${dd:>7.0f}')

# Monthly equity curve for best compound config
print('\n=== MONTHLY EQUITY CURVE ($5k compound, 1% pos, clf>0.5) ===')
tc, w, pnl, final, dd, monthly = simulate(test_df, 5000, 0.01, 0.5, 0.30, 50, True, None)
equity = 5000
print(f'{"Month":<10} {"PnL":>10} {"Equity":>12}')
for month in sorted(monthly.keys()):
    equity += monthly[month]
    print(f'{month:<10} ${monthly[month]:>9.0f} ${equity:>11.0f}')
