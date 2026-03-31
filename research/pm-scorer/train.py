"""
PM Scorer training script — this is the file you modify.
Run: python3 train.py > run.log 2>&1
"""

import pandas as pd
import numpy as np
import xgboost as xgb
from prepare import load_data, temporal_split, evaluate
import sys


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

    df['is_no'] = df['outcome'].str.lower().isin(['no', 'under', 'draw']).astype(int)
    df['is_favourite'] = (df['entry_price'] >= 0.5).astype(int)
    df['is_no_underdog'] = ((df['is_no'] == 1) & (df['entry_price'] < 0.5)).astype(int)
    df['is_no_favourite'] = ((df['is_no'] == 1) & (df['entry_price'] >= 0.5)).astype(int)
    df['is_yes_underdog'] = ((df['is_no'] == 0) & (df['entry_price'] < 0.5)).astype(int)
    df['is_yes_favourite'] = ((df['is_no'] == 0) & (df['entry_price'] >= 0.5)).astype(int)

    df['hour'] = pd.to_datetime(df['buy_ts'], unit='ms').dt.hour
    df['dow'] = pd.to_datetime(df['buy_ts'], unit='ms').dt.dayofweek

    df['hold_hours'] = (df['resolve_ts'] - df['buy_ts']) / (1000 * 60 * 60)
    df['hold_hours_log'] = np.log1p(df['hold_hours'].clip(lower=0))

    import re
    def extract_hours_to_resolution(row):
        m = re.search(r'(\d{4}-\d{2}-\d{2})', row['market_slug'])
        if m:
            try:
                res_date = pd.Timestamp(m.group(1))
                buy_date = pd.Timestamp(row['buy_ts'], unit='ms')
                hours = (res_date - buy_date).total_seconds() / 3600
                if hours > 0:
                    return hours
            except Exception:
                pass
        return row.get('hold_hours', 24.0)
    df['time_to_resolution'] = df.apply(extract_hours_to_resolution, axis=1)
    df['time_to_resolution_log'] = np.log1p(df['time_to_resolution'].clip(lower=0))

    # Bucketed time to resolution
    df['time_bucket_short'] = (df['time_to_resolution'] < 24).astype(int)
    df['time_bucket_long'] = (df['time_to_resolution'] > 168).astype(int)

    # Interaction features
    df['price_x_time'] = df['entry_price'] * df['time_to_resolution_log']
    df['edge_x_time'] = df['implied_edge'] * df['time_to_resolution_log']
    df['payoff_per_hour'] = df['payoff_ratio'] / df['time_to_resolution'].clip(lower=1)
    df['annualized_edge'] = df['implied_edge'] / np.sqrt(df['time_to_resolution'].clip(lower=1) / 24)

    # Trader conviction
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


# === EXPERIMENT CONFIGS ===

BASE_FEATURES = [
    'entry_price', 'price_dist_from_half', 'implied_edge', 'payoff_ratio',
    'is_no', 'is_favourite', 'is_no_underdog', 'is_no_favourite',
    'is_yes_underdog', 'is_yes_favourite',
    'cat_sports', 'cat_crypto', 'cat_politics',
    'hour', 'dow', 'size_vs_median',
    'roll_wr_20', 'roll_pf_20', 'roll_wr_50', 'roll_pf_50',
    'roll_avg_pnl_20', 'roll_streak', 'lifetime_wr', 'lifetime_pf',
    'trade_num', 'market_trader_count',
]

V4_FEATURES = [
    'entry_price', 'price_dist_from_half', 'implied_edge', 'payoff_ratio',
    'is_no', 'is_favourite', 'is_no_underdog', 'is_no_favourite',
    'is_yes_underdog', 'is_yes_favourite',
    'cat_sports', 'cat_crypto', 'cat_politics',
    'hour', 'dow', 'size_vs_median',
    'roll_wr_20', 'roll_pf_20', 'roll_wr_50', 'roll_pf_50',
    'roll_avg_pnl_20', 'roll_streak', 'lifetime_wr', 'lifetime_pf',
    'trade_num', 'market_trader_count',
]

CORE_FEATURES = [
    'entry_price', 'price_dist_from_half', 'implied_edge', 'payoff_ratio',
    'is_no', 'is_favourite',
    'cat_sports', 'cat_crypto', 'cat_politics',
    'size_vs_median',
    'roll_wr_20', 'roll_pf_20',
    'roll_avg_pnl_20', 'roll_streak',
    'lifetime_wr', 'lifetime_pf',
    'trade_num', 'market_trader_count',
]

BASE_PARAMS = dict(
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

EXPERIMENTS = {
    'E01_v4_baseline_no_time': {
        'features': V4_FEATURES,
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'v4 without time features',
    },
    'E02_v5_time_log': {
        'features': BASE_FEATURES + ['time_to_resolution_log'],
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'v5 current with time_to_resolution_log',
    },
    'E03_time_raw': {
        'features': BASE_FEATURES + ['time_to_resolution'],
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'raw time_to_resolution instead of log',
    },
    'E04_time_buckets': {
        'features': BASE_FEATURES + ['time_bucket_short', 'time_bucket_long'],
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'time bucketed: short <24h, long >7d',
    },
    'E05_payoff_per_hour': {
        'features': BASE_FEATURES + ['payoff_per_hour'],
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'payoff_ratio / time_to_resolution (hourly yield)',
    },
    'E06_annualized_edge': {
        'features': BASE_FEATURES + ['annualized_edge'],
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'edge / sqrt(hours/24) — annualized',
    },
    'E07_interactions': {
        'features': BASE_FEATURES + ['time_to_resolution_log', 'price_x_time', 'edge_x_time'],
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'time log + price*time + edge*time interactions',
    },
    'E08_time_weighted_samples': {
        'features': BASE_FEATURES + ['time_to_resolution_log'],
        'params': BASE_PARAMS,
        'sample_weight': 'time_weighted',
        'note': 'sample weight: 1/sqrt(hold_hours) to emphasize fast trades',
    },
    'E09_core_plus_payoff_per_hour': {
        'features': CORE_FEATURES + ['payoff_per_hour'],
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'reduced feature set (18) + payoff_per_hour',
    },
    'E10_core_plus_annualized': {
        'features': CORE_FEATURES + ['annualized_edge'],
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'reduced feature set + annualized_edge',
    },
    'E11_heavy_reg_time': {
        'features': BASE_FEATURES + ['time_to_resolution_log'],
        'params': {**BASE_PARAMS, 'reg_lambda': 20.0, 'gamma': 5.0, 'max_depth': 4, 'min_child_weight': 200},
        'sample_weight': 'temporal',
        'note': 'heavier regularization with time feature',
    },
    'E12_all_time_features': {
        'features': BASE_FEATURES + ['time_to_resolution_log', 'payoff_per_hour', 'annualized_edge'],
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'all time-derived features together',
    },
    'E13_time_plus_temporal_weight': {
        'features': BASE_FEATURES + ['payoff_per_hour', 'annualized_edge'],
        'params': BASE_PARAMS,
        'sample_weight': 'time_weighted',
        'note': 'payoff_per_hour + annualized_edge with time-weighted samples',
    },
    'E14_shallow_time': {
        'features': BASE_FEATURES + ['payoff_per_hour'],
        'params': {**BASE_PARAMS, 'max_depth': 4, 'n_estimators': 1200, 'learning_rate': 0.02},
        'sample_weight': 'temporal',
        'note': 'shallower trees, more boosting rounds with payoff_per_hour',
    },
    'E15_v4_heavy_reg': {
        'features': V4_FEATURES,
        'params': {**BASE_PARAMS, 'reg_lambda': 15.0, 'gamma': 4.0, 'max_depth': 5},
        'params_note': 'v4 features with heavier regularization',
        'sample_weight': 'temporal',
        'note': 'v4 with more reg to see if base improves',
    },
    'E16_annualized_plus_interactions': {
        'features': BASE_FEATURES + ['annualized_edge', 'price_x_time', 'edge_x_time'],
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'annualized_edge + both interaction features (best of E06+E07)',
    },
    'E17_interactions_shallow': {
        'features': BASE_FEATURES + ['time_to_resolution_log', 'price_x_time', 'edge_x_time'],
        'params': {**BASE_PARAMS, 'max_depth': 4, 'n_estimators': 1200, 'learning_rate': 0.02},
        'sample_weight': 'temporal',
        'note': 'E07 features with shallower trees (more boosting)',
    },
    'E18_interactions_time_weight': {
        'features': BASE_FEATURES + ['time_to_resolution_log', 'price_x_time', 'edge_x_time'],
        'params': BASE_PARAMS,
        'sample_weight': 'time_weighted',
        'note': 'E07 features + time-weighted samples',
    },
    'E19_kitchen_sink': {
        'features': BASE_FEATURES + ['time_to_resolution_log', 'price_x_time', 'edge_x_time', 'annualized_edge', 'payoff_per_hour'],
        'params': BASE_PARAMS,
        'sample_weight': 'temporal',
        'note': 'all time features: log, interactions, annualized, payoff/hr',
    },
    'E20_interactions_more_reg': {
        'features': BASE_FEATURES + ['time_to_resolution_log', 'price_x_time', 'edge_x_time'],
        'params': {**BASE_PARAMS, 'reg_lambda': 15.0, 'gamma': 4.0, 'min_child_weight': 200},
        'sample_weight': 'temporal',
        'note': 'E07 features with heavier regularization',
    },
}


def get_sample_weights(splits, mode, df_full=None):
    train = splits['train']
    train_ts = train['buy_ts'].values
    ts_norm = (train_ts - train_ts.min()) / (train_ts.max() - train_ts.min())

    if mode == 'temporal':
        return 0.5 + 0.5 * ts_norm
    elif mode == 'time_weighted':
        hold = train['hold_hours'].clip(lower=1).values
        time_w = 1.0 / np.sqrt(hold)
        time_w = time_w / time_w.mean()
        temporal_w = 0.5 + 0.5 * ts_norm
        return temporal_w * time_w
    else:
        return np.ones(len(train))


def run_experiment(name, config, df, splits):
    features = config['features']
    params = config['params']
    sw_mode = config.get('sample_weight', 'temporal')

    print(f'\n{"="*60}')
    print(f'EXPERIMENT: {name}')
    print(f'Note: {config.get("note", "")}')
    print(f'Features ({len(features)}): {features}')
    print(f'Sample weight: {sw_mode}')
    print(f'{"="*60}')

    missing = [f for f in features if f not in splits['train'].columns]
    if missing:
        print(f'SKIP — missing features: {missing}')
        return None

    X_train = splits['train'][features].values
    y_train = splits['train']['win'].values
    X_val = splits['val'][features].values
    y_val = splits['val']['win'].values

    sample_weights = get_sample_weights(splits, sw_mode)

    model = xgb.XGBClassifier(**params)
    model.fit(X_train, y_train, sample_weight=sample_weights,
              eval_set=[(X_val, y_val)], verbose=50)

    results, iso = evaluate(model, features, splits)

    print(f'\nFeature importance ({name}):')
    for feat, imp in sorted(zip(features, model.feature_importances_), key=lambda x: -x[1])[:10]:
        print(f'  {feat:<25} {imp:.4f}')

    return results


def main():
    run_name = sys.argv[1] if len(sys.argv) > 1 else None

    print('Loading data...')
    df = load_data()
    print(f'Loaded {len(df)} trades')

    print('Computing features...')
    df = compute_features(df)
    print(f'After feature computation: {len(df)} trades')

    print('Splitting data (temporal)...')
    splits = temporal_split(df)
    for k, v in splits.items():
        print(f'  {k}: {len(v)} trades')

    if run_name:
        exps = {run_name: EXPERIMENTS[run_name]}
    else:
        exps = EXPERIMENTS

    summary = []
    for name, config in exps.items():
        r = run_experiment(name, config, df, splits)
        if r:
            summary.append((name, r))

    print(f'\n\n{"="*80}')
    print('SUMMARY')
    print(f'{"="*80}')
    print(f'{"Experiment":<35} {"PnL":>8} {"Trades":>7} {"WR%":>6} {"AUC":>6} {"CAGR%":>12} {"MaxDD":>8}')
    print('-' * 80)
    for name, r in sorted(summary, key=lambda x: -x[1]['kelly_pnl']):
        print(f'{name:<35} {r["kelly_pnl"]:>8.1f} {r["kelly_trades"]:>7} {r["kelly_wr"]:>6.1f} {r["test_auc"]:>6.4f} {r["kelly_cagr"]:>12.1f} {r["kelly_max_dd"]:>8.1f}')

    if summary:
        best = max(summary, key=lambda x: x[1]['kelly_pnl'])
        print(f'\nBest: {best[0]} — kelly_pnl: {best[1]["kelly_pnl"]:.2f}')


if __name__ == '__main__':
    main()
