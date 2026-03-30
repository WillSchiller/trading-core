"""
PM Scorer training script — this is the file you modify.
Run: python3 train.py > run.log 2>&1
"""

import pandas as pd
import numpy as np
import xgboost as xgb
from prepare import load_data, temporal_split, evaluate

# === FEATURE ENGINEERING ===

def compute_features(df):
    """Compute all features. Must use only past data (no look-ahead)."""
    df = df.copy()

    if 'category' not in df.columns:
        slug = df['market_slug'].fillna('').str.lower()
        crypto_kw = r'bitcoin|btc|eth|sol|xrp|crypto|doge|hype|token|defi'
        sports_kw = r'nba|nfl|mlb|nhl|premier|bundesliga|serie-a|lol|fifa|bayern|win-on|game\d|foxy|esport'
        df['category'] = 'OTHER'
        df.loc[slug.str.contains(crypto_kw), 'category'] = 'CRYPTO'
        df.loc[slug.str.contains(sports_kw), 'category'] = 'SPORTS'
        df.loc[slug.str.contains(r'trump|biden|elect|president|congress|politi|senate|governor'), 'category'] = 'POLITICS'
    df['cat_sports'] = (df['category'] == 'SPORTS').astype(int)
    df['cat_crypto'] = (df['category'] == 'CRYPTO').astype(int)
    df['cat_politics'] = (df['category'] == 'POLITICS').astype(int)

    df['price_dist_from_half'] = abs(df['entry_price'] - 0.5)
    df['implied_edge'] = np.where(df['entry_price'] < 0.5, 1 - df['entry_price'], df['entry_price'])
    df['payoff_ratio'] = (1.0 / df['entry_price'].clip(0.01, 0.99)) - 1

    # Outcome type features
    df['is_no'] = df['outcome'].str.lower().isin(['no', 'under', 'draw']).astype(int)
    df['is_favourite'] = (df['entry_price'] >= 0.5).astype(int)
    df['is_no_underdog'] = ((df['is_no'] == 1) & (df['entry_price'] < 0.5)).astype(int)
    df['is_no_favourite'] = ((df['is_no'] == 1) & (df['entry_price'] >= 0.5)).astype(int)
    df['is_yes_underdog'] = ((df['is_no'] == 0) & (df['entry_price'] < 0.5)).astype(int)
    df['is_yes_favourite'] = ((df['is_no'] == 0) & (df['entry_price'] >= 0.5)).astype(int)

    df['hour'] = pd.to_datetime(df['buy_ts'], unit='ms').dt.hour
    df['dow'] = pd.to_datetime(df['buy_ts'], unit='ms').dt.dayofweek


    # Trader conviction — expanding median (causal)
    df['size_vs_median'] = 1.0
    for addr in df['trader_address'].unique():
        mask = df['trader_address'] == addr
        sizes = df.loc[mask, 'trader_size']
        expanding_median = sizes.expanding().median().shift(1).fillna(sizes.iloc[0])
        df.loc[mask, 'size_vs_median'] = sizes / expanding_median.clip(lower=0.01)

    df = df.sort_values(['trader_address', 'buy_ts'])
    df = df.groupby('trader_address', group_keys=False).apply(rolling_trader_stats)
    df = df.dropna(subset=['roll_wr_20'])

    df['market_trader_count'] = 1
    market_counts = {}
    for idx in df.index:
        slug = df.at[idx, 'market_slug']
        market_counts[slug] = market_counts.get(slug, 0) + 1
        df.at[idx, 'market_trader_count'] = market_counts[slug]

    return df


def rolling_trader_stats(group):
    """Compute rolling stats per trader using only past data."""
    pnls = group['pnl'].values
    wins = group['win'].values
    n = len(pnls)

    roll_wr_20 = np.full(n, np.nan)
    roll_pf_20 = np.full(n, np.nan)
    roll_wr_50 = np.full(n, np.nan)
    roll_pf_50 = np.full(n, np.nan)
    roll_streak = np.full(n, 0.0)
    lifetime_wr = np.full(n, np.nan)
    lifetime_pf = np.full(n, np.nan)
    trade_num = np.arange(1, n + 1, dtype=float)
    roll_avg_pnl_20 = np.full(n, np.nan)

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
            roll_pf_20[i] = min(gw / max(gl, 0.001), 10)
            roll_avg_pnl_20[i] = np.mean(window)
        if i >= 50:
            window50 = pnls[i-50:i]
            w50 = sum(1 for p in window50 if p > 0)
            gw50 = sum(p for p in window50 if p > 0)
            gl50 = abs(sum(p for p in window50 if p < 0))
            roll_wr_50[i] = w50 / 50
            roll_pf_50[i] = min(gw50 / max(gl50, 0.001), 10)
        if i > 0:
            streak = 0
            for j in range(i-1, -1, -1):
                if wins[j] == wins[i-1]:
                    streak += 1
                else:
                    break
            roll_streak[i] = streak if wins[i-1] == 1 else -streak

        cum_wins += wins[i]
        if pnls[i] > 0:
            cum_gw += pnls[i]
        else:
            cum_gl += abs(pnls[i])

    group = group.copy()
    group['roll_wr_20'] = roll_wr_20
    group['roll_pf_20'] = roll_pf_20
    group['roll_wr_50'] = roll_wr_50
    group['roll_pf_50'] = roll_pf_50
    group['roll_streak'] = roll_streak
    group['lifetime_wr'] = lifetime_wr
    group['lifetime_pf'] = lifetime_pf
    group['trade_num'] = trade_num
    group['roll_avg_pnl_20'] = roll_avg_pnl_20
    return group


# === FEATURE LIST ===

FEATURES = [
    'entry_price',
    'price_dist_from_half',
    'implied_edge',
    'payoff_ratio',
    'is_no',
    'is_favourite',
    'is_no_underdog',
    'is_no_favourite',
    'is_yes_underdog',
    'is_yes_favourite',
    'cat_sports',
    'cat_crypto',
    'cat_politics',
    'hour',
    'dow',
    'size_vs_median',
    'roll_wr_20',
    'roll_pf_20',
    'roll_wr_50',
    'roll_pf_50',
    'roll_avg_pnl_20',
    'roll_streak',
    'lifetime_wr',
    'lifetime_pf',
    'trade_num',
    'market_trader_count',
]


# === MODEL CONFIG ===

MODEL_PARAMS = dict(
    n_estimators=800,
    max_depth=6,
    learning_rate=0.03,
    subsample=0.8,
    colsample_bytree=0.8,
    min_child_weight=120,
    gamma=2.0,
    reg_lambda=8.0,
    eval_metric='logloss',
    early_stopping_rounds=50,
    random_state=42,
)


# === TRAINING ===

def main():
    print('Loading data...')
    df = load_data()
    print(f'Loaded {len(df)} trades')

    print('Computing features...')
    df = compute_features(df)
    print(f'After feature computation: {len(df)} trades')

    print('Splitting data (temporal)...')
    splits = temporal_split(df)
    for k, v in splits.items():
        print(f'  {k}: {len(v)} trades ({v["buy_ts"].min()} - {v["buy_ts"].max()})')

    print(f'\nTraining XGBoost with {len(FEATURES)} features...')
    X_train = splits['train'][FEATURES].values
    y_train = splits['train']['win'].values
    X_val = splits['val'][FEATURES].values
    y_val = splits['val']['win'].values

    print(f'Features: {FEATURES}')
    print(f'X_train shape: {X_train.shape}')
    print(f'Model params: {MODEL_PARAMS}')

    train_ts = splits['train']['buy_ts'].values
    ts_norm = (train_ts - train_ts.min()) / (train_ts.max() - train_ts.min())
    sample_weights = 0.5 + 0.5 * ts_norm

    model = xgb.XGBClassifier(**MODEL_PARAMS)
    model.fit(X_train, y_train, sample_weight=sample_weights,
              eval_set=[(X_val, y_val)], verbose=50)

    print('\nEvaluating...')
    results, iso = evaluate(model, FEATURES, splits)

    print('\nFeature importance:')
    for feat, imp in sorted(zip(FEATURES, model.feature_importances_), key=lambda x: -x[1]):
        print(f'  {feat:<25} {imp:.4f}')


if __name__ == '__main__':
    main()
