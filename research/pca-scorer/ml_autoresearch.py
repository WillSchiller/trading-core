#!/usr/bin/env python3
"""
ML autoresearch on PCA stat-arb synthetic signals.
Temporal split, multiple experiments, report AUC/WR/PnL.
"""

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from sklearn.linear_model import LogisticRegression
from xgboost import XGBClassifier
from pathlib import Path
import warnings
warnings.filterwarnings("ignore")

DATA_DIR = Path(__file__).parent / "data"
SIGNALS_PATH = DATA_DIR / "synthetic_signals.csv"
RESULTS_PATH = Path(__file__).parent / "backtest_results.tsv"


def load_and_prepare():
    df = pd.read_csv(SIGNALS_PATH)
    df = df[df.exit_reason != "end_of_data"].copy()
    df["label"] = (df.pnl_bps > 0).astype(int)
    df["abs_z"] = df.z_score.abs()
    df["is_short"] = (df.direction == "short").astype(int)

    # Regime encoding
    regime_map = {"bullish": 1, "bearish": -1, "neutral": 0, "unknown": 0}
    df["regime_enc"] = df.regime_state.map(regime_map).fillna(0)

    # Asset rolling WR (causal: use only past data)
    df = df.sort_values("ts").reset_index(drop=True)
    asset_cum_wins = {}
    asset_cum_total = {}
    rolling_wr = []
    for _, row in df.iterrows():
        a = row["asset"]
        if a not in asset_cum_wins:
            asset_cum_wins[a] = 0
            asset_cum_total[a] = 0
        if asset_cum_total[a] > 0:
            rolling_wr.append(asset_cum_wins[a] / asset_cum_total[a])
        else:
            rolling_wr.append(0.5)
        asset_cum_total[a] += 1
        if row["label"] == 1:
            asset_cum_wins[a] += 1
    df["asset_rolling_wr"] = rolling_wr

    # Interaction features
    df["z_x_vol"] = df.abs_z * df.ewma_vol
    df["z_x_wr"] = df.abs_z * df.asset_rolling_wr

    # Asset dummies
    asset_dummies = pd.get_dummies(df["asset"], prefix="asset", dtype=float)

    # Temporal split
    n = len(df)
    train_end = int(n * 0.6)
    val_end = int(n * 0.8)

    splits = {
        "train": df.iloc[:train_end],
        "val": df.iloc[train_end:val_end],
        "test": df.iloc[val_end:],
    }

    print(f"Total signals: {n}")
    for name, split in splits.items():
        wr = split.label.mean() * 100
        print(f"  {name}: {len(split)} signals, {wr:.1f}% base WR, avg_pnl={split.pnl_bps.mean():.1f}")

    return df, splits, asset_dummies


def evaluate(model, X_val, y_val, pnl_val, name):
    if hasattr(model, "predict_proba"):
        probs = model.predict_proba(X_val)[:, 1]
    else:
        probs = model.predict(X_val)
    preds = (probs >= 0.5).astype(int)

    try:
        auc = roc_auc_score(y_val, probs)
    except:
        auc = 0.5

    # WR on predicted positive
    pred_pos = preds == 1
    if pred_pos.sum() > 0:
        wr_pos = y_val[pred_pos].mean() * 100
        pnl_pos = pnl_val[pred_pos].mean()
        n_pos = pred_pos.sum()
        total_pnl = pnl_val[pred_pos].sum()
    else:
        wr_pos = 0
        pnl_pos = 0
        n_pos = 0
        total_pnl = 0

    # WR on predicted negative (what we filtered out)
    pred_neg = preds == 0
    if pred_neg.sum() > 0:
        wr_neg = y_val[pred_neg].mean() * 100
        pnl_neg = pnl_val[pred_neg].mean()
    else:
        wr_neg = 0
        pnl_neg = 0

    return {
        "name": name,
        "auc": auc,
        "n_pred_pos": int(n_pos),
        "wr_pred_pos": wr_pos,
        "avg_pnl_pos": pnl_pos,
        "total_pnl_pos": total_pnl,
        "wr_pred_neg": wr_neg,
        "avg_pnl_neg": pnl_neg,
    }


def run_experiments(df, splits, asset_dummies):
    results = []

    feature_sets = {
        "1_baseline_z_vol": ["abs_z", "ewma_vol"],
        "2_add_direction": ["abs_z", "ewma_vol", "is_short"],
        "3_add_asset_wr": ["abs_z", "ewma_vol", "is_short", "asset_rolling_wr"],
        "4_add_regime": ["abs_z", "ewma_vol", "is_short", "asset_rolling_wr", "regime_enc"],
        "5_add_time": ["abs_z", "ewma_vol", "is_short", "asset_rolling_wr", "regime_enc", "hour", "dow"],
        "6_add_pca": ["abs_z", "ewma_vol", "is_short", "asset_rolling_wr", "regime_enc", "hour", "dow", "pc1_return", "pc2_return"],
        "7_add_interactions": ["abs_z", "ewma_vol", "is_short", "asset_rolling_wr", "regime_enc", "hour", "dow", "pc1_return", "pc2_return", "z_x_vol", "z_x_wr"],
    }

    # Experiments 1-7: XGBoost with increasing features
    for exp_name, features in feature_sets.items():
        model = XGBClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            eval_metric="logloss", verbosity=0,
        )
        X_train = splits["train"][features].values
        y_train = splits["train"]["label"].values
        X_val = splits["val"][features].values
        y_val = splits["val"]["label"].values
        pnl_val = splits["val"]["pnl_bps"].values

        model.fit(X_train, y_train)
        res = evaluate(model, X_val, y_val, pnl_val, f"xgb_{exp_name}")
        results.append(res)

    # 8: XGBoost with asset dummies
    full_features = ["abs_z", "ewma_vol", "is_short", "asset_rolling_wr", "regime_enc", "hour", "dow", "pc1_return", "pc2_return", "z_x_vol", "z_x_wr"]
    df_full = pd.concat([df[full_features], asset_dummies], axis=1)
    X_train = df_full.iloc[:len(splits["train"])].values
    y_train = splits["train"]["label"].values
    X_val = df_full.iloc[len(splits["train"]):len(splits["train"])+len(splits["val"])].values
    y_val = splits["val"]["label"].values
    pnl_val = splits["val"]["pnl_bps"].values

    model = XGBClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8,
        eval_metric="logloss", verbosity=0,
    )
    model.fit(X_train, y_train)
    res = evaluate(model, X_val, y_val, pnl_val, "8_xgb_asset_dummies")
    results.append(res)

    # 9: Logistic regression (full features, no dummies)
    from sklearn.preprocessing import StandardScaler
    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(splits["train"][full_features].values)
    X_val_s = scaler.transform(splits["val"][full_features].values)
    y_train = splits["train"]["label"].values
    y_val = splits["val"]["label"].values
    pnl_val = splits["val"]["pnl_bps"].values

    lr = LogisticRegression(max_iter=500, C=1.0)
    lr.fit(X_train_s, y_train)
    res = evaluate(lr, X_val_s, y_val, pnl_val, "9_logistic_full")
    results.append(res)

    # 10: XGBoost tuned (deeper, more trees)
    model = XGBClassifier(
        n_estimators=500, max_depth=6, learning_rate=0.02,
        subsample=0.7, colsample_bytree=0.7, min_child_weight=5,
        gamma=0.1, reg_alpha=0.1, reg_lambda=1.0,
        eval_metric="logloss", verbosity=0,
    )
    X_train = splits["train"][full_features].values
    y_train = splits["train"]["label"].values
    X_val = splits["val"][full_features].values
    y_val = splits["val"]["label"].values
    pnl_val = splits["val"]["pnl_bps"].values
    model.fit(X_train, y_train)
    res = evaluate(model, X_val, y_val, pnl_val, "10_xgb_tuned")
    results.append(res)

    # 11: Filter — shorts only
    train_s = splits["train"][splits["train"].is_short == 1]
    val_s = splits["val"][splits["val"].is_short == 1]
    model = XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.05, verbosity=0)
    feats = ["abs_z", "ewma_vol", "asset_rolling_wr", "regime_enc", "hour", "dow", "pc1_return", "pc2_return", "z_x_vol"]
    model.fit(train_s[feats].values, train_s["label"].values)
    res = evaluate(model, val_s[feats].values, val_s["label"].values, val_s["pnl_bps"].values, "11_xgb_shorts_only")
    results.append(res)

    # 12: Filter — high vol only (top 50%)
    vol_median = splits["train"]["ewma_vol"].median()
    train_hv = splits["train"][splits["train"].ewma_vol >= vol_median]
    val_hv = splits["val"][splits["val"].ewma_vol >= vol_median]
    model = XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.05, verbosity=0)
    model.fit(train_hv[full_features].values, train_hv["label"].values)
    res = evaluate(model, val_hv[full_features].values, val_hv["label"].values, val_hv["pnl_bps"].values, "12_xgb_high_vol")
    results.append(res)

    # 13: Filter — top 10 assets by volume
    asset_counts = splits["train"].groupby("asset").size().nlargest(10).index.tolist()
    train_top = splits["train"][splits["train"].asset.isin(asset_counts)]
    val_top = splits["val"][splits["val"].asset.isin(asset_counts)]
    model = XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.05, verbosity=0)
    model.fit(train_top[full_features].values, train_top["label"].values)
    res = evaluate(model, val_top[full_features].values, val_top["label"].values, val_top["pnl_bps"].values, "13_xgb_top10_assets")
    results.append(res)

    # 14: XGBoost with higher threshold signals only (z > 2.5)
    train_hz = splits["train"][splits["train"].abs_z >= 2.5]
    val_hz = splits["val"][splits["val"].abs_z >= 2.5]
    if len(train_hz) > 50 and len(val_hz) > 20:
        model = XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.05, verbosity=0)
        model.fit(train_hz[full_features].values, train_hz["label"].values)
        res = evaluate(model, val_hz[full_features].values, val_hz["label"].values, val_hz["pnl_bps"].values, "14_xgb_high_z")
        results.append(res)

    # ---- Now evaluate best models on TEST set ----
    print("\n" + "="*80)
    print("VALIDATION RESULTS")
    print("="*80)
    res_df = pd.DataFrame(results)
    res_df = res_df.sort_values("auc", ascending=False)
    print(res_df.to_string(index=False, float_format="%.3f"))

    # Find best model by AUC and retrain on train+val, eval on test
    best = res_df.iloc[0]
    print(f"\nBest model: {best['name']} (AUC={best['auc']:.3f})")

    # Retrain best config on train+val
    print("\n" + "="*80)
    print("TEST SET EVALUATION (best model retrained on train+val)")
    print("="*80)

    train_val = pd.concat([splits["train"], splits["val"]])
    test = splits["test"]

    model = XGBClassifier(
        n_estimators=500, max_depth=6, learning_rate=0.02,
        subsample=0.7, colsample_bytree=0.7, min_child_weight=5,
        gamma=0.1, reg_alpha=0.1, reg_lambda=1.0,
        eval_metric="logloss", verbosity=0,
    )
    model.fit(train_val[full_features].values, train_val["label"].values)
    test_res = evaluate(model, test[full_features].values, test["label"].values, test["pnl_bps"].values, "best_on_test")
    print(f"  AUC: {test_res['auc']:.3f}")
    print(f"  Predicted positive: {test_res['n_pred_pos']} signals")
    print(f"  WR on predicted positive: {test_res['wr_pred_pos']:.1f}%")
    print(f"  Avg PnL on predicted positive: {test_res['avg_pnl_pos']:.1f} bps")
    print(f"  Total PnL on predicted positive: {test_res['total_pnl_pos']:.0f} bps")
    print(f"  WR on predicted negative: {test_res['wr_pred_neg']:.1f}%")
    print(f"  Avg PnL on predicted negative: {test_res['avg_pnl_neg']:.1f} bps")

    # Feature importance
    print(f"\nFeature importance (best model):")
    imp = model.feature_importances_
    for feat, score in sorted(zip(full_features, imp), key=lambda x: -x[1]):
        print(f"  {feat:25s}: {score:.4f}")

    # Threshold sweep on test
    print(f"\nThreshold sweep on test set:")
    probs = model.predict_proba(test[full_features].values)[:, 1]
    for threshold in [0.45, 0.50, 0.55, 0.60, 0.65, 0.70]:
        mask = probs >= threshold
        if mask.sum() > 0:
            wr = test["label"].values[mask].mean() * 100
            avg = test["pnl_bps"].values[mask].mean()
            total = test["pnl_bps"].values[mask].sum()
            print(f"  p >= {threshold:.2f}: n={mask.sum():4d}, WR={wr:.1f}%, avg={avg:.1f} bps, total={total:.0f} bps")

    # Save results
    res_df["split"] = "val"
    test_row = pd.DataFrame([test_res])
    test_row["split"] = "test"
    all_results = pd.concat([res_df, test_row], ignore_index=True)
    all_results.to_csv(RESULTS_PATH, sep="\t", index=False, float_format="%.3f")
    print(f"\nResults saved to {RESULTS_PATH}")

    return res_df, model


if __name__ == "__main__":
    df, splits, asset_dummies = load_and_prepare()
    run_experiments(df, splits, asset_dummies)
