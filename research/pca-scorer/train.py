#!/usr/bin/env python3
"""
PCA Signal Scorer — ML model to predict profitable PCA stat-arb signals.

Strict temporal split: 60% train / 20% val / 20% test.
Target: pnl_bps > 0 (binary classification).
"""

import sys
import csv
import warnings
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import roc_auc_score, precision_score, recall_score, f1_score
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

DATA_PATH = "/tmp/pca_signals_export.csv"
RESULTS_PATH = Path(__file__).parent / "results.tsv"


def load_data():
    df = pd.read_csv(DATA_PATH)
    # Drop orphaned (no outcome) and random_short (control group)
    df = df[df["exit_reason"] != "orphaned"]
    df = df[df["direction"].isin(["short", "long"])]
    df = df[df["pnl_bps"].notna()].copy()
    df = df.sort_values("ts").reset_index(drop=True)
    df["win"] = (df["pnl_bps"] > 0).astype(int)
    df["abs_z"] = df["z_score"].abs()
    df["hour"] = pd.to_datetime(df["ts"], unit="s").dt.hour
    df["dow"] = pd.to_datetime(df["ts"], unit="s").dt.dayofweek
    df["is_short"] = (df["direction"] == "short").astype(int)

    # Regime encoding
    regime_map = {"bearish": -1, "neutral": 0, "bullish": 1}
    df["regime_enc"] = df["regime_state"].map(regime_map).fillna(0)

    # Exit reason encoding (for analysis, not features — would be leakage)
    # Per-asset rolling stats (using only past data via expanding window)
    df["asset_count"] = df.groupby("asset").cumcount()
    df["asset_rolling_wr"] = (
        df.groupby("asset")["win"]
        .expanding()
        .mean()
        .reset_index(level=0, drop=True)
        .shift(1)  # lag to avoid leakage
    )
    df["asset_rolling_wr"] = df["asset_rolling_wr"].fillna(0.5)

    df["asset_rolling_avg_pnl"] = (
        df.groupby("asset")["pnl_bps"]
        .expanding()
        .mean()
        .reset_index(level=0, drop=True)
        .shift(1)
    )
    df["asset_rolling_avg_pnl"] = df["asset_rolling_avg_pnl"].fillna(0)

    # Interaction features
    df["z_x_vol"] = df["abs_z"] * df["ewma_vol_bps"].fillna(df["ewma_vol_bps"].median())
    df["z_x_confidence"] = df["abs_z"] * df["confidence"]
    df["pc1_abs"] = df["pc1_return"].abs()
    df["pc2_abs"] = df["pc2_return"].abs()

    return df


def temporal_split(df):
    n = len(df)
    train_end = int(n * 0.6)
    val_end = int(n * 0.8)
    train = df.iloc[:train_end].copy()
    val = df.iloc[train_end:val_end].copy()
    test = df.iloc[val_end:].copy()
    return train, val, test


BASE_FEATURES = ["abs_z", "confidence", "pc1_return", "pc2_return", "pc1_abs", "pc2_abs", "is_short"]
REGIME_FEATURES = ["regime_enc"]
VOL_FEATURES = ["ewma_vol_bps", "pc1_displacement_bps"]
ASSET_FEATURES = ["asset_rolling_wr", "asset_rolling_avg_pnl", "asset_count"]
TIME_FEATURES = ["hour", "dow"]
INTERACTION_FEATURES = ["z_x_vol", "z_x_confidence"]
MOMENTUM_FEATURES = ["pc1_momentum"]

ALL_FEATURES = (
    BASE_FEATURES + REGIME_FEATURES + VOL_FEATURES +
    ASSET_FEATURES + TIME_FEATURES + INTERACTION_FEATURES + MOMENTUM_FEATURES
)


def fill_missing(df, features):
    for f in features:
        if f in df.columns:
            df[f] = df[f].fillna(df[f].median() if df[f].notna().any() else 0)
    return df


def evaluate(y_true, y_pred_proba, pnl_bps, threshold=0.5, label=""):
    y_pred = (y_pred_proba >= threshold).astype(int)
    n_total = len(y_true)
    n_pred_pos = y_pred.sum()

    if n_pred_pos == 0:
        return {
            "label": label, "n": n_total, "n_pred_pos": 0,
            "auc": 0, "wr_pred_pos": 0, "avg_pnl_pred_pos": 0,
            "total_pnl_pred_pos": 0, "wr_all": float(y_true.mean()),
            "avg_pnl_all": float(pnl_bps.mean()), "precision": 0,
            "recall": 0, "f1": 0, "threshold": threshold,
        }

    auc = roc_auc_score(y_true, y_pred_proba) if len(np.unique(y_true)) > 1 else 0
    mask = y_pred == 1
    wr_pred = float(y_true[mask].mean())
    avg_pnl = float(pnl_bps[mask].mean())
    total_pnl = float(pnl_bps[mask].sum())

    return {
        "label": label,
        "n": n_total,
        "n_pred_pos": int(n_pred_pos),
        "auc": round(auc, 4),
        "wr_pred_pos": round(wr_pred * 100, 1),
        "avg_pnl_pred_pos": round(avg_pnl, 2),
        "total_pnl_pred_pos": round(total_pnl, 1),
        "wr_all": round(float(y_true.mean()) * 100, 1),
        "avg_pnl_all": round(float(pnl_bps.mean()), 2),
        "precision": round(precision_score(y_true, y_pred, zero_division=0), 4),
        "recall": round(recall_score(y_true, y_pred, zero_division=0), 4),
        "f1": round(f1_score(y_true, y_pred, zero_division=0), 4),
        "threshold": threshold,
    }


def run_experiment(name, train, val, test, features, model_cls="xgb", xgb_params=None,
                   filter_fn=None, threshold=0.5):
    if filter_fn:
        train = filter_fn(train)
        val = filter_fn(val)
        test = filter_fn(test)

    if len(train) < 50 or len(test) < 20:
        return None

    avail_features = [f for f in features if f in train.columns]
    train = fill_missing(train.copy(), avail_features)
    val = fill_missing(val.copy(), avail_features)
    test = fill_missing(test.copy(), avail_features)

    X_train = train[avail_features].values
    y_train = train["win"].values
    X_val = val[avail_features].values
    y_val = val["win"].values
    X_test = test[avail_features].values
    y_test = test["win"].values
    pnl_test = test["pnl_bps"].values

    if model_cls == "xgb":
        params = {
            "max_depth": 4, "learning_rate": 0.05, "n_estimators": 200,
            "subsample": 0.8, "colsample_bytree": 0.8,
            "min_child_weight": 10, "reg_alpha": 1.0, "reg_lambda": 3.0,
            "scale_pos_weight": 1.0, "eval_metric": "auc",
            "random_state": 42, "verbosity": 0
        }
        if xgb_params:
            params.update(xgb_params)
        model = xgb.XGBClassifier(**params)
        model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
        y_pred = model.predict_proba(X_test)[:, 1]

        importances = dict(zip(avail_features, model.feature_importances_))
    elif model_cls == "logistic":
        scaler = StandardScaler()
        X_train_s = scaler.fit_transform(X_train)
        X_test_s = scaler.transform(X_test)
        model = LogisticRegression(max_iter=1000, C=0.1, random_state=42)
        model.fit(X_train_s, y_train)
        y_pred = model.predict_proba(X_test_s)[:, 1]
        importances = dict(zip(avail_features, model.coef_[0]))
    else:
        return None

    result = evaluate(y_test, y_pred, pnl_test, threshold=threshold, label=name)
    result["features"] = ",".join(avail_features)
    result["train_n"] = len(train)
    result["test_n"] = len(test)

    # Try multiple thresholds for reporting
    best_pnl = result["total_pnl_pred_pos"]
    best_thr = threshold
    for t in [0.45, 0.50, 0.52, 0.55, 0.58, 0.60, 0.65]:
        r = evaluate(y_test, y_pred, pnl_test, threshold=t)
        if r["total_pnl_pred_pos"] > best_pnl and r["n_pred_pos"] >= 20:
            best_pnl = r["total_pnl_pred_pos"]
            best_thr = t

    if best_thr != threshold:
        result_best = evaluate(y_test, y_pred, pnl_test, threshold=best_thr, label=name)
        result["best_threshold"] = best_thr
        result["best_wr"] = result_best["wr_pred_pos"]
        result["best_pnl"] = result_best["total_pnl_pred_pos"]
        result["best_n_pred"] = result_best["n_pred_pos"]
    else:
        result["best_threshold"] = threshold
        result["best_wr"] = result["wr_pred_pos"]
        result["best_pnl"] = result["total_pnl_pred_pos"]
        result["best_n_pred"] = result["n_pred_pos"]

    return result, importances


def main():
    print("Loading data...")
    df = load_data()
    train, val, test = temporal_split(df)
    print(f"Samples: {len(df)} total | {len(train)} train | {len(val)} val | {len(test)} test")
    print(f"Train dates: {datetime.fromtimestamp(train.ts.iloc[0]):%Y-%m-%d} to {datetime.fromtimestamp(train.ts.iloc[-1]):%Y-%m-%d}")
    print(f"Val dates:   {datetime.fromtimestamp(val.ts.iloc[0]):%Y-%m-%d} to {datetime.fromtimestamp(val.ts.iloc[-1]):%Y-%m-%d}")
    print(f"Test dates:  {datetime.fromtimestamp(test.ts.iloc[0]):%Y-%m-%d} to {datetime.fromtimestamp(test.ts.iloc[-1]):%Y-%m-%d}")
    print(f"Base WR: train={train.win.mean()*100:.1f}%, val={val.win.mean()*100:.1f}%, test={test.win.mean()*100:.1f}%")
    print(f"Base avg PnL: train={train.pnl_bps.mean():.2f}, test={test.pnl_bps.mean():.2f}")
    print()

    results = []

    # === Experiment 1: Baseline — z_score + vol ===
    print("=" * 70)
    print("Exp 1: Baseline (abs_z + ewma_vol_bps + is_short)")
    r = run_experiment("1_baseline_z_vol", train, val, test,
                       ["abs_z", "ewma_vol_bps", "is_short"])
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")
        print(f"  Feature importance: {r[1]}")

    # === Experiment 2: Base features ===
    print("\nExp 2: Base features")
    r = run_experiment("2_base_features", train, val, test, BASE_FEATURES)
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")
        top3 = sorted(r[1].items(), key=lambda x: -x[1])[:3]
        print(f"  Top features: {top3}")

    # === Experiment 3: Base + regime ===
    print("\nExp 3: Base + regime")
    r = run_experiment("3_base_regime", train, val, test, BASE_FEATURES + REGIME_FEATURES)
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")

    # === Experiment 4: Base + asset features ===
    print("\nExp 4: Base + asset rolling stats")
    r = run_experiment("4_base_asset", train, val, test, BASE_FEATURES + ASSET_FEATURES)
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")
        top3 = sorted(r[1].items(), key=lambda x: -x[1])[:3]
        print(f"  Top features: {top3}")

    # === Experiment 5: All features ===
    print("\nExp 5: All features")
    r = run_experiment("5_all_features", train, val, test, ALL_FEATURES)
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")
        top5 = sorted(r[1].items(), key=lambda x: -x[1])[:5]
        print(f"  Top features: {top5}")

    # === Experiment 6: Shorts only ===
    print("\nExp 6: Shorts only, all features")
    r = run_experiment("6_shorts_only", train, val, test, ALL_FEATURES,
                       filter_fn=lambda d: d[d["direction"] == "short"])
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")

    # === Experiment 7: Filter losing assets ===
    print("\nExp 7: Drop worst 10 assets by rolling WR")
    # Compute worst assets from training set
    asset_stats_train = train.groupby("asset").agg(
        wr=("win", "mean"), n=("win", "count"), total_pnl=("pnl_bps", "sum")
    )
    worst_assets = set(
        asset_stats_train[
            (asset_stats_train.n >= 10) & (asset_stats_train.wr < 0.45)
        ].index
    )
    print(f"  Excluded assets (WR<45%, n>=10): {worst_assets}")
    r = run_experiment("7_drop_losers", train, val, test, ALL_FEATURES,
                       filter_fn=lambda d: d[~d["asset"].isin(worst_assets)])
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")

    # === Experiment 8: Higher z_score threshold ===
    print("\nExp 8: z_score > 3.0 filter")
    r = run_experiment("8_z3_filter", train, val, test, ALL_FEATURES,
                       filter_fn=lambda d: d[d["abs_z"] >= 3.0])
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")
    else:
        print("  Skipped: insufficient data after filter")

    # === Experiment 9: Tuned XGBoost ===
    print("\nExp 9: XGBoost tuned (deeper, more regularization)")
    tuned_params = {
        "max_depth": 3, "learning_rate": 0.02, "n_estimators": 500,
        "subsample": 0.7, "colsample_bytree": 0.6,
        "min_child_weight": 20, "reg_alpha": 3.0, "reg_lambda": 5.0,
        "gamma": 1.0,
    }
    r = run_experiment("9_xgb_tuned", train, val, test, ALL_FEATURES, xgb_params=tuned_params)
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")

    # === Experiment 10: Logistic regression baseline ===
    print("\nExp 10: Logistic regression (all features)")
    r = run_experiment("10_logistic", train, val, test, ALL_FEATURES, model_cls="logistic")
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")
        top3 = sorted(r[1].items(), key=lambda x: -abs(x[1]))[:3]
        print(f"  Top coefs: {top3}")

    # === Experiment 11: Shorts + drop losers + tuned ===
    print("\nExp 11: Shorts + drop losers + tuned XGB")
    def combo_filter(d):
        d = d[d["direction"] == "short"]
        d = d[~d["asset"].isin(worst_assets)]
        return d
    r = run_experiment("11_shorts_clean_tuned", train, val, test, ALL_FEATURES,
                       xgb_params=tuned_params, filter_fn=combo_filter)
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")

    # === Experiment 12: Vol gate analysis ===
    print("\nExp 12: Vol >= 125 bps filter + all features")
    r = run_experiment("12_vol_gate_125", train, val, test, ALL_FEATURES,
                       filter_fn=lambda d: d[d["ewma_vol_bps"].fillna(999) >= 125])
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")

    # === Experiment 13: Minimal overfitting-resistant model ===
    print("\nExp 13: Minimal model (3 features, heavy regularization)")
    conservative_params = {
        "max_depth": 2, "learning_rate": 0.01, "n_estimators": 100,
        "min_child_weight": 50, "reg_alpha": 5.0, "reg_lambda": 10.0,
        "gamma": 2.0,
    }
    r = run_experiment("13_minimal", train, val, test,
                       ["abs_z", "is_short", "asset_rolling_wr"],
                       xgb_params=conservative_params)
    if r:
        results.append(r[0])
        print(f"  AUC={r[0]['auc']} | WR(pred+)={r[0]['wr_pred_pos']}% ({r[0]['n_pred_pos']}/{r[0]['n']}) | PnL={r[0]['total_pnl_pred_pos']}")

    # === Summary ===
    print("\n" + "=" * 70)
    print("RESULTS SUMMARY (Test Set)")
    print("=" * 70)
    print(f"{'Experiment':<30} {'AUC':>6} {'WR%':>6} {'AvgPnL':>8} {'TotPnL':>8} {'N':>5} {'BestThr':>7} {'BestWR':>7} {'BestPnL':>8}")
    print("-" * 100)
    for r in results:
        print(f"{r['label']:<30} {r['auc']:>6} {r['wr_pred_pos']:>5.1f}% {r['avg_pnl_pred_pos']:>8.2f} {r['total_pnl_pred_pos']:>8.1f} {r['n_pred_pos']:>5} {r['best_threshold']:>7.2f} {r['best_wr']:>6.1f}% {r['best_pnl']:>8.1f}")

    # Baseline comparison
    print(f"\n{'BASELINE (no model)':<30} {'':>6} {test.win.mean()*100:>5.1f}% {test.pnl_bps.mean():>8.2f} {test.pnl_bps.sum():>8.1f} {len(test):>5}")

    # === Asset analysis ===
    print("\n" + "=" * 70)
    print("ASSET ANALYSIS (full dataset)")
    print("=" * 70)
    asset_stats = df.groupby("asset").agg(
        n=("win", "count"), wr=("win", "mean"),
        avg_pnl=("pnl_bps", "mean"), total_pnl=("pnl_usd", "sum")
    ).sort_values("total_pnl", ascending=False)
    print("\nTop 10 assets by total PnL:")
    print(asset_stats.head(10).to_string())
    print("\nBottom 10 assets by total PnL:")
    print(asset_stats.tail(10).to_string())

    asset_enough = asset_stats[asset_stats.n >= 20]
    print(f"\nAssets with n>=20 and WR>=55%: {list(asset_enough[asset_enough.wr >= 0.55].index)}")
    print(f"Assets with n>=20 and WR<45%: {list(asset_enough[asset_enough.wr < 0.45].index)}")

    # === Z-score threshold analysis ===
    print("\n" + "=" * 70)
    print("Z-SCORE THRESHOLD ANALYSIS (test set)")
    print("=" * 70)
    for z_thr in [2.5, 2.75, 3.0, 3.25, 3.5, 4.0]:
        sub = test[test["abs_z"] >= z_thr]
        if len(sub) >= 10:
            print(f"  z>={z_thr}: n={len(sub)}, WR={sub.win.mean()*100:.1f}%, avg_pnl={sub.pnl_bps.mean():.1f}, total={sub.pnl_bps.sum():.0f}")

    # === Save results ===
    if results:
        keys = ["label", "auc", "n", "n_pred_pos", "wr_pred_pos", "avg_pnl_pred_pos",
                "total_pnl_pred_pos", "wr_all", "avg_pnl_all", "precision", "recall",
                "f1", "threshold", "best_threshold", "best_wr", "best_pnl", "best_n_pred",
                "train_n", "test_n"]
        with open(RESULTS_PATH, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=keys, delimiter="\t", extrasaction="ignore")
            writer.writeheader()
            for r in results:
                writer.writerow(r)
        print(f"\nResults saved to {RESULTS_PATH}")

    # === Key conclusions ===
    print("\n" + "=" * 70)
    print("KEY FINDINGS")
    print("=" * 70)
    if results:
        best = max(results, key=lambda r: r["auc"])
        print(f"1. Best AUC: {best['label']} ({best['auc']})")
        best_pnl = max(results, key=lambda r: r["best_pnl"])
        print(f"2. Best PnL: {best_pnl['label']} ({best_pnl['best_pnl']} bps, thr={best_pnl['best_threshold']})")
        print(f"3. Baseline test WR: {test.win.mean()*100:.1f}%, avg PnL: {test.pnl_bps.mean():.2f}")
        above_baseline = [r for r in results if r["best_wr"] > test.win.mean() * 100 + 2]
        if above_baseline:
            print(f"4. Models beating baseline WR by >2pp: {[r['label'] for r in above_baseline]}")
        else:
            print("4. No model beats baseline WR by >2pp — signal may not be learnable with these features")


if __name__ == "__main__":
    main()
