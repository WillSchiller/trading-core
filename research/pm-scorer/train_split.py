"""
Train separate PM scorer models for binary vs multi-outcome markets.
Run: python3 train_split.py > split_run.log 2>&1
"""

import pandas as pd
import numpy as np
import xgboost as xgb
from prepare import load_data, kelly_simulate, calibrate, kelly_fraction
from train import compute_features, get_sample_weights, BASE_FEATURES, BASE_PARAMS
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.isotonic import IsotonicRegression
import sys


def custom_temporal_split(df):
    """Temporal split adjusted for this dataset (buy dates through Feb 2026).
    ~70% train, ~10% cal, ~10% val, ~10% test by time."""
    df['buy_dt'] = pd.to_datetime(df['buy_ts'], unit='ms', utc=True)
    train_end = pd.Timestamp('2025-11-01', tz='UTC')
    cal_end = pd.Timestamp('2025-12-01', tz='UTC')
    val_end = pd.Timestamp('2026-01-01', tz='UTC')
    return {
        'train': df[df['buy_dt'] < train_end],
        'cal': df[(df['buy_dt'] >= train_end) & (df['buy_dt'] < cal_end)],
        'val': df[(df['buy_dt'] >= cal_end) & (df['buy_dt'] < val_end)],
        'test': df[df['buy_dt'] >= val_end],
    }


def custom_evaluate(model, features, splits):
    """Evaluation pipeline matching prepare.py but using our splits."""
    X_cal = splits['cal'][features].values
    y_cal = splits['cal']['win'].values
    X_val = splits['val'][features].values
    y_val = splits['val']['win'].values
    X_test = splits['test'][features].values
    y_test = splits['test']['win'].values

    raw_cal = model.predict_proba(X_cal)[:, 1]
    raw_val = model.predict_proba(X_val)[:, 1]
    raw_test = model.predict_proba(X_test)[:, 1]

    cal_test, iso = calibrate(raw_cal, y_cal, raw_test)
    cal_val = iso.predict(raw_val)

    test_auc = roc_auc_score(y_test, cal_test)
    test_brier = brier_score_loss(y_test, cal_test)
    val_auc = roc_auc_score(y_val, cal_val)

    kelly = kelly_simulate(splits['test'], cal_test)

    results = {
        'test_auc': test_auc,
        'test_brier': test_brier,
        'val_auc': val_auc,
        'kelly_pnl': kelly['pnl'],
        'kelly_cagr': kelly['cagr'],
        'kelly_max_dd': kelly['max_dd'],
        'kelly_trades': kelly['trades'],
        'kelly_wr': kelly['wr'],
    }

    print('---')
    for k, v in results.items():
        if isinstance(v, float):
            print(f'{k}:{" " * (18 - len(k))}{v:.4f}')
        else:
            print(f'{k}:{" " * (18 - len(k))}{v}')

    return results, iso


def classify_market_type(df):
    """Label each trade as binary (Yes/No outcome) or multi-outcome."""
    df = df.copy()
    outcome_lower = df['outcome'].fillna('').astype(str).str.lower().str.strip()
    df['is_multi_outcome'] = (~outcome_lower.isin(['yes', 'no'])).astype(int)
    return df


def filter_splits(splits, mask_col, value):
    filtered = {}
    for k, v in splits.items():
        sub = v[v[mask_col] == value].copy()
        filtered[k] = sub
    return filtered


def train_and_eval(name, features, params, splits, sw_mode='time_weighted', export_path=None):
    print(f'\n{"="*60}')
    print(f'MODEL: {name}')
    print(f'Features ({len(features)})')
    print(f'Train: {len(splits["train"])}, Cal: {len(splits["cal"])}, Val: {len(splits["val"])}, Test: {len(splits["test"])}')
    print(f'{"="*60}')

    missing = [f for f in features if f not in splits['train'].columns]
    if missing:
        print(f'SKIP — missing features: {missing}')
        return None, None, None

    for split_name in ['train', 'cal', 'val', 'test']:
        n = len(splits[split_name])
        if n < 50:
            print(f'SKIP — {split_name} has only {n} rows')
            return None, None, None

    X_train = splits['train'][features].values
    y_train = splits['train']['win'].values
    X_val = splits['val'][features].values
    y_val = splits['val']['win'].values

    sample_weights = get_sample_weights(splits, sw_mode)

    model = xgb.XGBClassifier(**params)
    model.fit(X_train, y_train, sample_weight=sample_weights,
              eval_set=[(X_val, y_val)], verbose=50)

    results, iso = custom_evaluate(model, features, splits)

    print(f'\nFeature importance ({name}):')
    for feat, imp in sorted(zip(features, model.feature_importances_), key=lambda x: -x[1])[:10]:
        print(f'  {feat:<25} {imp:.4f}')

    if export_path:
        model.save_model(export_path.replace('.onnx', '.json'))
        print(f'Saved model to {export_path.replace(".onnx", ".json")}')

    return results, model, iso


def eval_existing_on_subset(model, features, splits):
    """Evaluate an already-trained model on a data subset (re-calibrate on subset's cal)."""
    X_cal = splits['cal'][features].values
    y_cal = splits['cal']['win'].values
    X_test = splits['test'][features].values
    y_test = splits['test']['win'].values

    raw_cal = model.predict_proba(X_cal)[:, 1]
    raw_test = model.predict_proba(X_test)[:, 1]

    cal_test, _ = calibrate(raw_cal, y_cal, raw_test)
    test_auc = roc_auc_score(y_test, cal_test)
    kelly = kelly_simulate(splits['test'], cal_test)

    return {
        'test_auc': test_auc,
        'kelly_pnl': kelly['pnl'],
        'kelly_trades': kelly['trades'],
        'kelly_wr': kelly['wr'],
        'kelly_cagr': kelly['cagr'],
        'kelly_max_dd': kelly['max_dd'],
    }


def main():
    print('Loading data...')
    df = load_data()
    print(f'Loaded {len(df)} trades')

    print('Classifying market types...')
    df = classify_market_type(df)

    n_binary = (df['is_multi_outcome'] == 0).sum()
    n_multi = (df['is_multi_outcome'] == 1).sum()
    print(f'\n--- MARKET TYPE SPLIT ---')
    print(f'Binary (Yes/No):    {n_binary:>7} trades ({n_binary/len(df)*100:.1f}%)')
    print(f'Multi-outcome:      {n_multi:>7} trades ({n_multi/len(df)*100:.1f}%)')
    print(f'Binary WR:  {(df.loc[df["is_multi_outcome"]==0, "pnl"]>0).mean():.3f}')
    print(f'Multi WR:   {(df.loc[df["is_multi_outcome"]==1, "pnl"]>0).mean():.3f}')
    print(f'Binary avg PnL: {df.loc[df["is_multi_outcome"]==0, "pnl"].mean():.4f}')
    print(f'Multi avg PnL:  {df.loc[df["is_multi_outcome"]==1, "pnl"].mean():.4f}')
    print(f'Binary median entry: {df.loc[df["is_multi_outcome"]==0, "entry_price"].median():.3f}')
    print(f'Multi median entry:  {df.loc[df["is_multi_outcome"]==1, "entry_price"].median():.3f}')

    print('\nComputing features...')
    df = compute_features(df)
    print(f'After feature computation: {len(df)} trades')

    print('Temporal split (Nov/Dec/Jan/Feb)...')
    splits_all = custom_temporal_split(df)
    for k, v in splits_all.items():
        n_b = (v['is_multi_outcome'] == 0).sum()
        n_m = (v['is_multi_outcome'] == 1).sum()
        print(f'  {k}: {len(v)} trades (binary={n_b}, multi={n_m})')

    splits_binary = filter_splits(splits_all, 'is_multi_outcome', 0)
    splits_multi = filter_splits(splits_all, 'is_multi_outcome', 1)

    E18_FEATURES = BASE_FEATURES + ['time_to_resolution_log', 'price_x_time', 'edge_x_time']
    MULTI_PARAMS = {**BASE_PARAMS, 'reg_lambda': 15.0, 'gamma': 4.0, 'min_child_weight': 200, 'max_depth': 4}

    # ============================================================
    # Baseline: Combined model on all data
    # ============================================================
    print('\n\n' + '#'*60)
    print('# BASELINE: Combined model (E18 on all data)')
    print('#'*60)
    r_combined, m_combined, iso_combined = train_and_eval(
        'v6_combined_all', E18_FEATURES, BASE_PARAMS, splits_all, 'time_weighted')

    r_v6_on_binary = None
    r_v6_on_multi = None
    if m_combined is not None:
        print('\n--- v6 combined on BINARY subset ---')
        r_v6_on_binary = eval_existing_on_subset(m_combined, E18_FEATURES, splits_binary)
        for k, v in r_v6_on_binary.items():
            print(f'  {k}: {v:.4f}' if isinstance(v, float) else f'  {k}: {v}')

        print('\n--- v6 combined on MULTI subset ---')
        r_v6_on_multi = eval_existing_on_subset(m_combined, E18_FEATURES, splits_multi)
        for k, v in r_v6_on_multi.items():
            print(f'  {k}: {v:.4f}' if isinstance(v, float) else f'  {k}: {v}')

    # ============================================================
    # Model A: Binary-only
    # ============================================================
    print('\n\n' + '#'*60)
    print('# MODEL A: Binary markets only (E18 config)')
    print('#'*60)
    r_binary, m_binary, iso_binary = train_and_eval(
        'v7_binary', E18_FEATURES, BASE_PARAMS, splits_binary, 'time_weighted',
        export_path='pm_scorer_v7_binary.onnx')

    # ============================================================
    # Model B: Multi-outcome (conservative)
    # ============================================================
    print('\n\n' + '#'*60)
    print('# MODEL B: Multi-outcome (conservative params)')
    print('#'*60)
    r_multi_c, m_multi_c, iso_multi_c = train_and_eval(
        'v7_multi_conservative', E18_FEATURES, MULTI_PARAMS, splits_multi, 'time_weighted',
        export_path='pm_scorer_v7_multi.onnx')

    # Model B2: Multi with standard params
    print('\n\n' + '#'*60)
    print('# MODEL B2: Multi-outcome (E18 params)')
    print('#'*60)
    r_multi_e18, m_multi_e18, iso_multi_e18 = train_and_eval(
        'v7_multi_e18', E18_FEATURES, BASE_PARAMS, splits_multi, 'time_weighted')

    # Model B3: Multi with heavy reg + lower kelly
    MULTI_HEAVY_PARAMS = {**BASE_PARAMS, 'reg_lambda': 25.0, 'gamma': 6.0, 'min_child_weight': 300, 'max_depth': 3}
    print('\n\n' + '#'*60)
    print('# MODEL B3: Multi-outcome (heavy reg, depth=3)')
    print('#'*60)
    r_multi_heavy, m_multi_h, iso_multi_h = train_and_eval(
        'v7_multi_heavy', E18_FEATURES, MULTI_HEAVY_PARAMS, splits_multi, 'time_weighted')

    # ============================================================
    # COMPARISON
    # ============================================================
    print('\n\n' + '='*90)
    print('COMPARISON SUMMARY')
    print('='*90)
    print(f'{"Model":<35} {"AUC":>6} {"PnL":>8} {"Trades":>7} {"WR%":>6} {"CAGR%":>8} {"MaxDD":>8}')
    print('-'*90)

    rows = []
    if r_combined:
        rows.append(('v6_combined (all)', r_combined))
    if r_v6_on_binary:
        rows.append(('  -> binary subset', r_v6_on_binary))
    if r_v6_on_multi:
        rows.append(('  -> multi subset', r_v6_on_multi))
    rows.append(('', None))  # separator
    if r_binary:
        rows.append(('v7_binary (binary only)', r_binary))
    if r_multi_c:
        rows.append(('v7_multi_conservative', r_multi_c))
    if r_multi_e18:
        rows.append(('v7_multi_e18', r_multi_e18))
    if r_multi_heavy:
        rows.append(('v7_multi_heavy', r_multi_heavy))

    for name, r in rows:
        if r is None:
            print()
            continue
        pnl = r.get('kelly_pnl', 0)
        trades = r.get('kelly_trades', 0)
        wr = r.get('kelly_wr', 0)
        auc = r.get('test_auc', 0)
        cagr = r.get('kelly_cagr', 0)
        mdd = r.get('kelly_max_dd', 0)
        print(f'{name:<35} {auc:>6.4f} {pnl:>8.1f} {trades:>7} {wr:>6.1f} {cagr:>8.1f} {mdd:>8.1f}')

    # Combined PnL from best split models
    best_multi = None
    best_multi_name = None
    for nm, r in [('conservative', r_multi_c), ('e18', r_multi_e18), ('heavy', r_multi_heavy)]:
        if r and (best_multi is None or r['kelly_pnl'] > best_multi['kelly_pnl']):
            best_multi = r
            best_multi_name = nm

    print(f'\n--- SPLIT vs COMBINED ---')
    if r_combined:
        print(f'Combined v6 total PnL:       {r_combined["kelly_pnl"]:>8.1f} ({r_combined["kelly_trades"]} trades)')
    if r_v6_on_binary and r_v6_on_multi:
        print(f'  v6 on binary subset:       {r_v6_on_binary["kelly_pnl"]:>8.1f} ({r_v6_on_binary["kelly_trades"]} trades)')
        print(f'  v6 on multi subset:        {r_v6_on_multi["kelly_pnl"]:>8.1f} ({r_v6_on_multi["kelly_trades"]} trades)')
    if r_binary:
        print(f'v7_binary PnL:               {r_binary["kelly_pnl"]:>8.1f} ({r_binary["kelly_trades"]} trades)')
    if best_multi:
        print(f'v7_multi_{best_multi_name} PnL:  {best_multi["kelly_pnl"]:>8.1f} ({best_multi["kelly_trades"]} trades)')
    if r_binary and best_multi:
        split_pnl = r_binary['kelly_pnl'] + best_multi['kelly_pnl']
        print(f'Split total:                 {split_pnl:>8.1f}')
        if r_combined:
            print(f'Improvement vs combined:     {split_pnl - r_combined["kelly_pnl"]:>+8.1f}')
    if r_binary and r_combined:
        print(f'\nBinary-only (skip multi):    {r_binary["kelly_pnl"]:>8.1f}')
        print(f'  vs combined:               {r_binary["kelly_pnl"] - r_combined["kelly_pnl"]:>+8.1f}')

    print('\n--- KEY INSIGHT ---')
    if r_v6_on_multi:
        print(f'Multi-outcome trades under combined v6: PnL={r_v6_on_multi["kelly_pnl"]:.1f}, '
              f'WR={r_v6_on_multi["kelly_wr"]:.1f}%, trades={r_v6_on_multi["kelly_trades"]}')
        if r_v6_on_multi['kelly_pnl'] < 0:
            print('>>> Multi-outcome trades are NET NEGATIVE under the combined model.')
            print('>>> Splitting or skipping multi-outcome markets improves total PnL.')
        else:
            print('>>> Multi-outcome trades are positive under combined model.')


if __name__ == '__main__':
    main()
