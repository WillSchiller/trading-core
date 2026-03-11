#!/usr/bin/env python3
"""
PCA stat-arb signal classifier.
Trains XGBoost on historical signals with proper time-series train/test split.
"""

import subprocess
import json
import sys
import numpy as np
import pandas as pd
from datetime import datetime
from xgboost import XGBClassifier
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.model_selection import TimeSeriesSplit

DB_CMD = [
    "ssh", "-o", "StrictHostKeyChecking=no", "ubuntu@3.1.140.199",
    "docker exec dislocation-postgres psql -U trader -d dislocation_trader -A -t -c"
]

def query_db(sql: str) -> str:
    cmd = DB_CMD[:-1] + [DB_CMD[-1] + f" \"{sql}\""]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        print(f"DB error: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()

def load_data() -> pd.DataFrame:
    sql = """
    COPY (
        SELECT
            id, timestamp, asset, direction, z_score, residual, confidence,
            pc1_return, pc2_return, pc1_momentum, regime_state,
            ewma_vol_bps, pc1_displacement_bps,
            pnl_bps, pnl_usd, hold_time_ms, exit_reason,
            peak_pnl_bps, trough_pnl_bps,
            pc1_pnl_bps, residual_pnl_bps, pc1_pct_of_total,
            position_size_usd,
            market_context->>'funding' as funding_rate,
            market_context->>'premium' as premium,
            market_context->>'openInterest' as open_interest,
            market_context->>'dayNtlVlm' as day_volume
        FROM pca_signals
        WHERE position_size_usd > 0 AND pnl_bps IS NOT NULL
        ORDER BY timestamp
    ) TO STDOUT WITH CSV HEADER
    """
    raw = query_db(sql)
    from io import StringIO
    df = pd.read_csv(StringIO(raw))
    return df

def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    df['timestamp_dt'] = pd.to_datetime(df['timestamp'], unit='ms')
    df['hour_utc'] = df['timestamp_dt'].dt.hour
    df['day_of_week'] = df['timestamp_dt'].dt.dayofweek
    df['is_short'] = (df['direction'] == 'short').astype(int)

    for col in ['funding_rate', 'premium', 'open_interest', 'day_volume']:
        df[col] = pd.to_numeric(df[col], errors='coerce')

    df['abs_z'] = df['z_score'].abs()
    df['z_x_vol'] = df['z_score'] * df['ewma_vol_bps'].fillna(0)
    df['z_x_pc1'] = df['z_score'] * df['pc1_return']
    df['funding_abs'] = df['funding_rate'].abs()

    regime_dummies = pd.get_dummies(df['regime_state'], prefix='regime')
    df = pd.concat([df, regime_dummies], axis=1)

    # per-asset signal count in trailing window (proxy for how "active" this asset is)
    df['asset_code'] = df['asset'].astype('category').cat.codes

    return df

FEATURE_COLS = [
    'z_score', 'abs_z', 'residual', 'confidence',
    'pc1_return', 'pc2_return', 'pc1_momentum',
    'ewma_vol_bps', 'pc1_displacement_bps',
    'is_short', 'hour_utc', 'day_of_week',
    'funding_rate', 'premium', 'funding_abs',
    'z_x_vol', 'z_x_pc1', 'asset_code',
    # regime_state is encoded as dummies, not included raw
]

def main():
    print("Loading data from production...")
    df = load_data()
    print(f"Loaded {len(df)} signals")

    df = engineer_features(df)

    # Add regime dummies to features
    regime_cols = [c for c in df.columns if c.startswith('regime_')]
    feature_cols = FEATURE_COLS + regime_cols

    # Target: profitable trade
    df['target'] = (df['pnl_bps'] > 0).astype(int)

    # Time-series split: train on first 60%, test on last 40%
    split_idx = int(len(df) * 0.6)
    train = df.iloc[:split_idx].copy()
    test = df.iloc[split_idx:].copy()

    train_dates = f"{train['timestamp_dt'].min().date()} to {train['timestamp_dt'].max().date()}"
    test_dates = f"{test['timestamp_dt'].min().date()} to {test['timestamp_dt'].max().date()}"
    print(f"\nTrain: {len(train)} signals ({train_dates})")
    print(f"Test:  {len(test)} signals ({test_dates})")
    print(f"Train win rate: {train['target'].mean():.3f}")
    print(f"Test win rate:  {test['target'].mean():.3f}")

    exclude = {'regime_state', 'direction', 'asset', 'exit_reason'}
    available_features = [f for f in feature_cols if f in df.columns and f not in exclude]
    print(f"\nFeatures ({len(available_features)}): {available_features}")

    X_train = train[available_features].fillna(0)
    y_train = train['target']
    X_test = test[available_features].fillna(0)
    y_test = test['target']

    # XGBoost with conservative hyperparams to avoid overfit
    model = XGBClassifier(
        n_estimators=200,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.7,
        colsample_bytree=0.7,
        min_child_weight=20,
        reg_alpha=1.0,
        reg_lambda=2.0,
        random_state=42,
        eval_metric='logloss',
    )

    model.fit(
        X_train, y_train,
        eval_set=[(X_test, y_test)],
        verbose=False,
    )

    # Predictions
    y_pred_proba = model.predict_proba(X_test)[:, 1]
    y_pred = model.predict(X_test)

    print("\n" + "="*60)
    print("TEST SET RESULTS (out of sample)")
    print("="*60)
    print(classification_report(y_test, y_pred, target_names=['loss', 'win']))

    try:
        auc = roc_auc_score(y_test, y_pred_proba)
        print(f"AUC-ROC: {auc:.4f}")
    except:
        pass

    # P&L analysis at different probability thresholds
    test_with_pred = test.copy()
    test_with_pred['prob_win'] = y_pred_proba

    print("\n" + "="*60)
    print("P&L BY CONFIDENCE THRESHOLD")
    print("="*60)
    print(f"{'Threshold':>10} {'Trades':>8} {'AvgBps':>8} {'WinRate':>8} {'TotalPnL':>10} {'Sharpe':>8}")
    print("-"*60)

    for thresh in [0.0, 0.45, 0.50, 0.52, 0.55, 0.58, 0.60, 0.65, 0.70]:
        mask = test_with_pred['prob_win'] >= thresh
        subset = test_with_pred[mask]
        if len(subset) < 10:
            continue
        avg_bps = subset['pnl_bps'].mean()
        win_rate = (subset['pnl_bps'] > 0).mean()
        total_pnl = subset['pnl_usd'].sum()
        daily_pnl = subset.groupby(subset['timestamp_dt'].dt.date)['pnl_usd'].sum()
        sharpe = daily_pnl.mean() / daily_pnl.std() * np.sqrt(365) if daily_pnl.std() > 0 else 0
        print(f"{thresh:>10.2f} {len(subset):>8} {avg_bps:>8.2f} {win_rate:>8.1%} {total_pnl:>10.2f} {sharpe:>8.2f}")

    # Feature importance
    print("\n" + "="*60)
    print("FEATURE IMPORTANCE (top 15)")
    print("="*60)
    importance = dict(zip(available_features, model.feature_importances_))
    sorted_imp = sorted(importance.items(), key=lambda x: x[1], reverse=True)
    for feat, imp in sorted_imp[:15]:
        bar = "█" * int(imp * 100)
        print(f"  {feat:<25} {imp:.4f} {bar}")

    # Walk-forward validation (5 folds)
    print("\n" + "="*60)
    print("WALK-FORWARD VALIDATION (5 folds)")
    print("="*60)
    tscv = TimeSeriesSplit(n_splits=5)
    X_all = df[available_features].fillna(0)
    y_all = df['target']

    fold_results = []
    for i, (train_idx, test_idx) in enumerate(tscv.split(X_all)):
        X_tr, X_te = X_all.iloc[train_idx], X_all.iloc[test_idx]
        y_tr, y_te = y_all.iloc[train_idx], y_all.iloc[test_idx]
        pnl_te = df.iloc[test_idx]['pnl_bps']
        dates = df.iloc[test_idx]['timestamp_dt']

        fold_model = XGBClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            subsample=0.7, colsample_bytree=0.7, min_child_weight=20,
            reg_alpha=1.0, reg_lambda=2.0, random_state=42,
            eval_metric='logloss',
        )
        fold_model.fit(X_tr, y_tr, verbose=False)
        proba = fold_model.predict_proba(X_te)[:, 1]

        # filter to >0.55 confidence
        mask = proba >= 0.55
        if mask.sum() < 5:
            print(f"  Fold {i+1}: <5 trades above threshold, skipping")
            continue

        filtered_pnl = pnl_te[mask]
        avg_bps = filtered_pnl.mean()
        win_rate = (filtered_pnl > 0).mean()
        n = mask.sum()
        date_range = f"{dates.iloc[0].date()} - {dates.iloc[-1].date()}"
        print(f"  Fold {i+1}: n={n:>4}, avg={avg_bps:>7.2f}bps, wr={win_rate:.1%}  ({date_range})")
        fold_results.append({'n': n, 'avg_bps': avg_bps, 'win_rate': win_rate})

    if fold_results:
        avg_fold_bps = np.mean([f['avg_bps'] for f in fold_results])
        avg_fold_wr = np.mean([f['win_rate'] for f in fold_results])
        print(f"\n  Average across folds: {avg_fold_bps:.2f} bps, {avg_fold_wr:.1%} win rate")

    print("\nDone.")

if __name__ == '__main__':
    main()
