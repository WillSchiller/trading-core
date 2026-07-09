#!/usr/bin/env python3
"""
Round 2: Deep autoresearch on PCA stat-arb signal prediction.
24+ experiments covering regime, temporal, asset, signal quality,
regularization, alternative targets, ensembles, and robustness.
"""

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from xgboost import XGBClassifier, XGBRegressor
from pathlib import Path
import warnings
warnings.filterwarnings("ignore")

DATA_DIR = Path(__file__).parent / "data"
SIGNALS_PATH = DATA_DIR / "synthetic_signals.csv"
RESULTS_PATH = Path(__file__).parent / "backtest_results_r2.tsv"

ALL_RESULTS = []


def load_and_prepare():
    df = pd.read_csv(SIGNALS_PATH)
    df = df[df.exit_reason != "end_of_data"].copy()
    df = df.sort_values("ts").reset_index(drop=True)

    df["label"] = (df.pnl_bps > 0).astype(int)
    df["abs_z"] = df.z_score.abs()
    df["is_short"] = (df.direction == "short").astype(int)

    regime_map = {"bullish": 1, "bearish": -1, "neutral": 0, "unknown": 0}
    df["regime_enc"] = df.regime_state.map(regime_map).fillna(0)

    # Regime dummies
    df["regime_bullish"] = (df.regime_state == "bullish").astype(int)
    df["regime_bearish"] = (df.regime_state == "bearish").astype(int)
    df["regime_neutral"] = (df.regime_state == "neutral").astype(int)

    # Regime x direction interactions
    df["short_x_bearish"] = df.is_short * df.regime_bearish
    df["short_x_neutral"] = df.is_short * df.regime_neutral
    df["short_x_bullish"] = df.is_short * df.regime_bullish

    # Vol-based regime (rolling 20-signal ewma_vol quintile)
    df["vol_regime"] = pd.qcut(df.ewma_vol, 5, labels=False, duplicates="drop")

    # Trend regime: rolling PC1 sign over last 10 signals
    df["pc1_rolling_mean"] = df.pc1_return.rolling(10, min_periods=1).mean()
    df["trend_regime"] = np.where(df.pc1_rolling_mean > 0.001, 1,
                          np.where(df.pc1_rolling_mean < -0.001, -1, 0))

    # Hour dummies (buckets)
    df["session_asia"] = ((df.hour >= 0) & (df.hour < 8)).astype(int)
    df["session_europe"] = ((df.hour >= 8) & (df.hour < 16)).astype(int)
    df["session_us"] = ((df.hour >= 16) & (df.hour < 24)).astype(int)

    # Hour cyclical encoding
    df["hour_sin"] = np.sin(2 * np.pi * df.hour / 24)
    df["hour_cos"] = np.cos(2 * np.pi * df.hour / 24)

    # DOW dummies
    df["is_weekend"] = (df.dow >= 5).astype(int)

    # Hour x regime
    df["hour_x_regime"] = df.hour * df.regime_enc

    # Asset rolling WR with different lookbacks
    for lookback in [10, 20, 50]:
        col = f"asset_rolling_wr_{lookback}"
        wins = []
        asset_history = {}
        for _, row in df.iterrows():
            a = row["asset"]
            if a not in asset_history:
                asset_history[a] = []
            hist = asset_history[a]
            if len(hist) > 0:
                recent = hist[-lookback:]
                wins.append(sum(recent) / len(recent))
            else:
                wins.append(0.5)
            asset_history[a].append(row["label"])
        df[col] = wins

    # Asset volatility rank (percentile of ewma_vol within asset)
    df["asset_vol_rank"] = df.groupby("asset")["ewma_vol"].rank(pct=True)

    # Z-score velocity (diff of abs_z for same asset)
    df["z_velocity"] = 0.0
    asset_last_z = {}
    z_vel = []
    for _, row in df.iterrows():
        a = row["asset"]
        if a in asset_last_z:
            z_vel.append(row["abs_z"] - asset_last_z[a])
        else:
            z_vel.append(0.0)
        asset_last_z[a] = row["abs_z"]
    df["z_velocity"] = z_vel

    # Time since last signal on same asset (in hours, capped)
    asset_last_ts = {}
    time_since = []
    for _, row in df.iterrows():
        a = row["asset"]
        if a in asset_last_ts:
            delta_h = (row["ts"] - asset_last_ts[a]) / 3600
            time_since.append(min(delta_h, 168))  # cap at 1 week
        else:
            time_since.append(168)
        asset_last_ts[a] = row["ts"]
    df["time_since_last"] = time_since

    # Simultaneous signals (count of signals at same timestamp)
    ts_counts = df.groupby("ts").size().to_dict()
    df["simultaneous_signals"] = df.ts.map(ts_counts)

    # Residual relative to asset normal (expanding std per asset)
    asset_residual_std = df.groupby("asset")["residual"].transform(
        lambda x: x.expanding().std()
    )
    df["residual_relative"] = df.residual.abs() / asset_residual_std.clip(lower=0.0001)

    # Interaction features
    df["z_x_vol"] = df.abs_z * df.ewma_vol
    df["z_x_wr20"] = df.abs_z * df.asset_rolling_wr_20

    # Temporal split
    n = len(df)
    train_end = int(n * 0.6)
    val_end = int(n * 0.8)

    splits = {
        "train": df.iloc[:train_end].copy(),
        "val": df.iloc[train_end:val_end].copy(),
        "test": df.iloc[val_end:].copy(),
    }

    print(f"Total signals: {n}")
    for name, s in splits.items():
        wr = s.label.mean() * 100
        shorts = s.is_short.mean() * 100
        print(f"  {name}: {len(s)} signals, {wr:.1f}% base WR, {shorts:.0f}% shorts, avg_pnl={s.pnl_bps.mean():.1f}")

    return df, splits


def evaluate_threshold(probs, y, pnl, threshold=0.5):
    mask = probs >= threshold
    if mask.sum() == 0:
        return {"n": 0, "wr": 0, "avg_pnl": 0, "total_pnl": 0}
    return {
        "n": int(mask.sum()),
        "wr": y[mask].mean() * 100,
        "avg_pnl": pnl[mask].mean(),
        "total_pnl": pnl[mask].sum(),
    }


def log_result(name, auc_val, auc_test, thresh_test, notes=""):
    row = {
        "name": name,
        "val_auc": round(auc_val, 4),
        "test_auc": round(auc_test, 4),
        "n_signals": thresh_test["n"],
        "wr": round(thresh_test["wr"], 1),
        "avg_pnl_bps": round(thresh_test["avg_pnl"], 1),
        "total_pnl_bps": round(thresh_test["total_pnl"], 0),
        "notes": notes,
    }
    ALL_RESULTS.append(row)
    print(f"  {name}: val_auc={auc_val:.3f} test_auc={auc_test:.3f} "
          f"n={thresh_test['n']} wr={thresh_test['wr']:.1f}% "
          f"avg={thresh_test['avg_pnl']:.1f} total={thresh_test['total_pnl']:.0f}")
    return row


def get_auc(y, probs):
    try:
        return roc_auc_score(y, probs)
    except:
        return 0.5


def train_eval_xgb(train_X, train_y, val_X, val_y, val_pnl,
                    test_X, test_y, test_pnl, name,
                    threshold=0.60, notes="", **xgb_kwargs):
    defaults = dict(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8,
        eval_metric="logloss", verbosity=0,
    )
    defaults.update(xgb_kwargs)
    model = XGBClassifier(**defaults)
    model.fit(train_X, train_y)

    val_probs = model.predict_proba(val_X)[:, 1]
    test_probs = model.predict_proba(test_X)[:, 1]

    auc_val = get_auc(val_y, val_probs)
    auc_test = get_auc(test_y, test_probs)

    thresh_test = evaluate_threshold(test_probs, test_y, test_pnl, threshold)
    log_result(name, auc_val, auc_test, thresh_test, notes)
    return model, val_probs, test_probs


def run_all(df, splits):
    train, val, test = splits["train"], splits["val"], splits["test"]

    # Shorts-only subsets
    train_s = train[train.is_short == 1]
    val_s = val[val.is_short == 1]
    test_s = test[test.is_short == 1]

    BASE_FEATS = ["abs_z", "ewma_vol", "is_short", "asset_rolling_wr_20",
                  "regime_enc", "hour", "dow", "pc1_return", "pc2_return", "z_x_vol"]
    SHORTS_FEATS = ["abs_z", "ewma_vol", "asset_rolling_wr_20",
                    "regime_enc", "hour", "dow", "pc1_return", "pc2_return", "z_x_vol"]

    print("\n" + "="*80)
    print("REGIME DEEP-DIVE")
    print("="*80)

    # 1. Regime only
    train_eval_xgb(
        train_s[["regime_enc"]].values, train_s.label.values,
        val_s[["regime_enc"]].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[["regime_enc"]].values, test_s.label.values, test_s.pnl_bps.values,
        "01_regime_only", notes="How much edge is just regime?")

    # 2. Regime + direction interactions
    regime_dir_feats = ["regime_enc", "is_short", "short_x_bearish", "short_x_neutral", "short_x_bullish"]
    train_eval_xgb(
        train[regime_dir_feats].values, train.label.values,
        val[regime_dir_feats].values, val.label.values, val.pnl_bps.values,
        test[regime_dir_feats].values, test.label.values, test.pnl_bps.values,
        "02_regime_dir_interact", notes="Regime x direction interactions")

    # 3a. Vol-based regime
    vol_feats = SHORTS_FEATS + ["vol_regime"]
    train_eval_xgb(
        train_s[vol_feats].values, train_s.label.values,
        val_s[vol_feats].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[vol_feats].values, test_s.label.values, test_s.pnl_bps.values,
        "03a_vol_regime", notes="Vol quintile as regime")

    # 3b. Trend regime
    trend_feats = SHORTS_FEATS + ["trend_regime"]
    train_eval_xgb(
        train_s[trend_feats].values, train_s.label.values,
        val_s[trend_feats].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[trend_feats].values, test_s.label.values, test_s.pnl_bps.values,
        "03b_trend_regime", notes="PC1 rolling trend as regime")

    # 3c. Regime dummies instead of encoding
    regime_dummy_feats = ["abs_z", "ewma_vol", "asset_rolling_wr_20",
                          "regime_bullish", "regime_bearish", "regime_neutral",
                          "hour", "dow", "pc1_return", "pc2_return", "z_x_vol"]
    train_eval_xgb(
        train_s[regime_dummy_feats].values, train_s.label.values,
        val_s[regime_dummy_feats].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[regime_dummy_feats].values, test_s.label.values, test_s.pnl_bps.values,
        "03c_regime_dummies", notes="Regime as separate dummies")

    print("\n" + "="*80)
    print("TEMPORAL PATTERNS")
    print("="*80)

    # 4. Session dummies
    session_feats = SHORTS_FEATS + ["session_asia", "session_europe", "session_us"]
    train_eval_xgb(
        train_s[session_feats].values, train_s.label.values,
        val_s[session_feats].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[session_feats].values, test_s.label.values, test_s.pnl_bps.values,
        "04_session_dummies", notes="Asia/Europe/US session dummies")

    # 5. Cyclical hour encoding
    cyc_feats = SHORTS_FEATS + ["hour_sin", "hour_cos"]
    # Remove 'hour' from base and add cyclical
    cyc_feats_noh = [f for f in SHORTS_FEATS if f != "hour"] + ["hour_sin", "hour_cos"]
    train_eval_xgb(
        train_s[cyc_feats_noh].values, train_s.label.values,
        val_s[cyc_feats_noh].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[cyc_feats_noh].values, test_s.label.values, test_s.pnl_bps.values,
        "05_cyclical_hour", notes="Sin/cos hour encoding")

    # 6. Hour x regime interaction
    hr_regime_feats = SHORTS_FEATS + ["hour_x_regime"]
    train_eval_xgb(
        train_s[hr_regime_feats].values, train_s.label.values,
        val_s[hr_regime_feats].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[hr_regime_feats].values, test_s.label.values, test_s.pnl_bps.values,
        "06_hour_x_regime", notes="Hour x regime interaction")

    # 7. Weekend flag
    wknd_feats = SHORTS_FEATS + ["is_weekend"]
    train_eval_xgb(
        train_s[wknd_feats].values, train_s.label.values,
        val_s[wknd_feats].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[wknd_feats].values, test_s.label.values, test_s.pnl_bps.values,
        "07_weekend_flag", notes="Weekend binary flag")

    print("\n" + "="*80)
    print("ASSET-SPECIFIC")
    print("="*80)

    # 8. Rolling WR with different lookbacks
    for lb in [10, 20, 50]:
        feats = [f for f in SHORTS_FEATS if "wr" not in f] + [f"asset_rolling_wr_{lb}"]
        train_eval_xgb(
            train_s[feats].values, train_s.label.values,
            val_s[feats].values, val_s.label.values, val_s.pnl_bps.values,
            test_s[feats].values, test_s.label.values, test_s.pnl_bps.values,
            f"08_wr_lookback_{lb}", notes=f"Asset rolling WR lookback={lb}")

    # 9. Asset vol rank
    volrank_feats = SHORTS_FEATS + ["asset_vol_rank"]
    train_eval_xgb(
        train_s[volrank_feats].values, train_s.label.values,
        val_s[volrank_feats].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[volrank_feats].values, test_s.label.values, test_s.pnl_bps.values,
        "09_asset_vol_rank", notes="Asset vol percentile rank")

    print("\n" + "="*80)
    print("SIGNAL QUALITY")
    print("="*80)

    # 11. Z-score velocity
    zvel_feats = SHORTS_FEATS + ["z_velocity"]
    train_eval_xgb(
        train_s[zvel_feats].values, train_s.label.values,
        val_s[zvel_feats].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[zvel_feats].values, test_s.label.values, test_s.pnl_bps.values,
        "11_z_velocity", notes="Z-score change since last signal")

    # 12. Time since last signal
    tsl_feats = SHORTS_FEATS + ["time_since_last"]
    train_eval_xgb(
        train_s[tsl_feats].values, train_s.label.values,
        val_s[tsl_feats].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[tsl_feats].values, test_s.label.values, test_s.pnl_bps.values,
        "12_time_since_last", notes="Hours since last signal on asset")

    # 13. Simultaneous signals
    sim_feats = SHORTS_FEATS + ["simultaneous_signals"]
    train_eval_xgb(
        train_s[sim_feats].values, train_s.label.values,
        val_s[sim_feats].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[sim_feats].values, test_s.label.values, test_s.pnl_bps.values,
        "13_simultaneous_sigs", notes="Count of signals at same timestamp")

    # 14. Residual relative to asset norm
    resrel_feats = SHORTS_FEATS + ["residual_relative"]
    train_eval_xgb(
        train_s[resrel_feats].values, train_s.label.values,
        val_s[resrel_feats].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[resrel_feats].values, test_s.label.values, test_s.pnl_bps.values,
        "14_residual_relative", notes="Residual / asset residual std")

    print("\n" + "="*80)
    print("REGULARIZATION SWEEP")
    print("="*80)

    # 15. Heavy regularization
    train_eval_xgb(
        train_s[SHORTS_FEATS].values, train_s.label.values,
        val_s[SHORTS_FEATS].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[SHORTS_FEATS].values, test_s.label.values, test_s.pnl_bps.values,
        "15_heavy_reg",
        min_child_weight=50, gamma=2.0, reg_alpha=1.0, reg_lambda=5.0,
        notes="Very heavy regularization")

    # 16. Shallow + more trees
    train_eval_xgb(
        train_s[SHORTS_FEATS].values, train_s.label.values,
        val_s[SHORTS_FEATS].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[SHORTS_FEATS].values, test_s.label.values, test_s.pnl_bps.values,
        "16_shallow_more_trees",
        n_estimators=500, max_depth=3, learning_rate=0.03,
        notes="Depth=3, 500 trees, lr=0.03")

    # 17. Low LR + many trees
    train_eval_xgb(
        train_s[SHORTS_FEATS].values, train_s.label.values,
        val_s[SHORTS_FEATS].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[SHORTS_FEATS].values, test_s.label.values, test_s.pnl_bps.values,
        "17_low_lr_2000",
        n_estimators=2000, max_depth=3, learning_rate=0.01,
        min_child_weight=10, gamma=0.5,
        notes="LR=0.01, 2000 trees, depth=3")

    print("\n" + "="*80)
    print("ALTERNATIVE TARGETS")
    print("="*80)

    # 18. pnl > 5 bps target
    train_s5 = train_s.copy()
    val_s5 = val_s.copy()
    test_s5 = test_s.copy()
    train_s5["label5"] = (train_s5.pnl_bps > 5).astype(int)
    val_s5["label5"] = (val_s5.pnl_bps > 5).astype(int)
    test_s5["label5"] = (test_s5.pnl_bps > 5).astype(int)

    model18 = XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.05,
                            subsample=0.8, colsample_bytree=0.8, eval_metric="logloss", verbosity=0)
    model18.fit(train_s5[SHORTS_FEATS].values, train_s5.label5.values)
    val_p18 = model18.predict_proba(val_s5[SHORTS_FEATS].values)[:, 1]
    test_p18 = model18.predict_proba(test_s5[SHORTS_FEATS].values)[:, 1]
    # But evaluate on actual PnL with original labels
    auc_v18 = get_auc(val_s5.label5.values, val_p18)
    auc_t18 = get_auc(test_s5.label5.values, test_p18)
    # Use probs to filter, but measure actual PnL
    thresh18 = evaluate_threshold(test_p18, test_s.label.values, test_s.pnl_bps.values, 0.60)
    log_result("18_target_5bps", auc_v18, auc_t18, thresh18, "Predict pnl>5 bps")

    # 19. pnl > 10 bps target
    train_s10 = train_s.copy()
    val_s10 = val_s.copy()
    test_s10 = test_s.copy()
    train_s10["label10"] = (train_s10.pnl_bps > 10).astype(int)
    val_s10["label10"] = (val_s10.pnl_bps > 10).astype(int)
    test_s10["label10"] = (test_s10.pnl_bps > 10).astype(int)

    model19 = XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.05,
                            subsample=0.8, colsample_bytree=0.8, eval_metric="logloss", verbosity=0)
    model19.fit(train_s10[SHORTS_FEATS].values, train_s10.label10.values)
    val_p19 = model19.predict_proba(val_s10[SHORTS_FEATS].values)[:, 1]
    test_p19 = model19.predict_proba(test_s10[SHORTS_FEATS].values)[:, 1]
    auc_v19 = get_auc(val_s10.label10.values, val_p19)
    auc_t19 = get_auc(test_s10.label10.values, test_p19)
    thresh19 = evaluate_threshold(test_p19, test_s.label.values, test_s.pnl_bps.values, 0.60)
    log_result("19_target_10bps", auc_v19, auc_t19, thresh19, "Predict pnl>10 bps")

    # 20. Regression: predict actual pnl_bps
    reg_model = XGBRegressor(n_estimators=200, max_depth=4, learning_rate=0.05,
                             subsample=0.8, colsample_bytree=0.8, verbosity=0)
    reg_model.fit(train_s[SHORTS_FEATS].values, train_s.pnl_bps.values)
    val_pred_pnl = reg_model.predict(val_s[SHORTS_FEATS].values)
    test_pred_pnl = reg_model.predict(test_s[SHORTS_FEATS].values)
    # Convert to "probability-like" for AUC: normalize predictions
    val_pnl_norm = (val_pred_pnl - val_pred_pnl.min()) / (val_pred_pnl.max() - val_pred_pnl.min() + 1e-8)
    test_pnl_norm = (test_pred_pnl - test_pred_pnl.min()) / (test_pred_pnl.max() - test_pred_pnl.min() + 1e-8)
    auc_v20 = get_auc(val_s.label.values, val_pnl_norm)
    auc_t20 = get_auc(test_s.label.values, test_pnl_norm)
    # Use predicted pnl > 0 as filter
    thresh20 = evaluate_threshold((test_pred_pnl > 0).astype(float), test_s.label.values, test_s.pnl_bps.values, 0.5)
    log_result("20_regression", auc_v20, auc_t20, thresh20, "XGBRegressor on pnl_bps, filter pred>0")

    # 20b: Regression with higher threshold
    thresh20b = evaluate_threshold((test_pred_pnl > 10).astype(float), test_s.label.values, test_s.pnl_bps.values, 0.5)
    log_result("20b_reg_thresh10", auc_v20, auc_t20, thresh20b, "Regression filter pred>10 bps")

    print("\n" + "="*80)
    print("KITCHEN SINK MODEL")
    print("="*80)

    # All features together (shorts only)
    KITCHEN_FEATS = SHORTS_FEATS + [
        "vol_regime", "trend_regime", "session_asia", "session_europe",
        "hour_sin", "hour_cos", "is_weekend", "hour_x_regime",
        "asset_vol_rank", "z_velocity", "time_since_last",
        "simultaneous_signals", "residual_relative", "z_x_wr20",
    ]
    train_eval_xgb(
        train_s[KITCHEN_FEATS].values, train_s.label.values,
        val_s[KITCHEN_FEATS].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[KITCHEN_FEATS].values, test_s.label.values, test_s.pnl_bps.values,
        "21_kitchen_sink", notes="All features, default hyperparams")

    # Kitchen sink with heavy reg
    train_eval_xgb(
        train_s[KITCHEN_FEATS].values, train_s.label.values,
        val_s[KITCHEN_FEATS].values, val_s.label.values, val_s.pnl_bps.values,
        test_s[KITCHEN_FEATS].values, test_s.label.values, test_s.pnl_bps.values,
        "21b_kitchen_reg",
        min_child_weight=20, gamma=1.0, max_depth=3, n_estimators=500, learning_rate=0.02,
        notes="All features + heavy regularization")

    print("\n" + "="*80)
    print("ENSEMBLE")
    print("="*80)

    # Train 3 different models, average probabilities
    ensemble_probs_val = []
    ensemble_probs_test = []

    # Model A: base shorts
    mA = XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.05,
                       subsample=0.8, colsample_bytree=0.8, eval_metric="logloss", verbosity=0)
    mA.fit(train_s[SHORTS_FEATS].values, train_s.label.values)
    ensemble_probs_val.append(mA.predict_proba(val_s[SHORTS_FEATS].values)[:, 1])
    ensemble_probs_test.append(mA.predict_proba(test_s[SHORTS_FEATS].values)[:, 1])

    # Model B: kitchen sink regularized
    mB = XGBClassifier(n_estimators=500, max_depth=3, learning_rate=0.02,
                       min_child_weight=20, gamma=1.0, subsample=0.8, colsample_bytree=0.8,
                       eval_metric="logloss", verbosity=0)
    mB.fit(train_s[KITCHEN_FEATS].values, train_s.label.values)
    ensemble_probs_val.append(mB.predict_proba(val_s[KITCHEN_FEATS].values)[:, 1])
    ensemble_probs_test.append(mB.predict_proba(test_s[KITCHEN_FEATS].values)[:, 1])

    # Model C: shallow, more trees
    mC = XGBClassifier(n_estimators=1000, max_depth=2, learning_rate=0.01,
                       min_child_weight=30, subsample=0.8, colsample_bytree=0.8,
                       eval_metric="logloss", verbosity=0)
    mC.fit(train_s[SHORTS_FEATS].values, train_s.label.values)
    ensemble_probs_val.append(mC.predict_proba(val_s[SHORTS_FEATS].values)[:, 1])
    ensemble_probs_test.append(mC.predict_proba(test_s[SHORTS_FEATS].values)[:, 1])

    # Average ensemble
    ens_val = np.mean(ensemble_probs_val, axis=0)
    ens_test = np.mean(ensemble_probs_test, axis=0)
    auc_v_ens = get_auc(val_s.label.values, ens_val)
    auc_t_ens = get_auc(test_s.label.values, ens_test)
    thresh_ens = evaluate_threshold(ens_test, test_s.label.values, test_s.pnl_bps.values, 0.60)
    log_result("22_ensemble_avg3", auc_v_ens, auc_t_ens, thresh_ens, "Average of 3 XGB models")

    # Stacking meta-learner
    meta_train_X = np.column_stack([
        mA.predict_proba(train_s[SHORTS_FEATS].values)[:, 1],
        mB.predict_proba(train_s[KITCHEN_FEATS].values)[:, 1],
        mC.predict_proba(train_s[SHORTS_FEATS].values)[:, 1],
    ])
    meta_val_X = np.column_stack(ensemble_probs_val)
    meta_test_X = np.column_stack(ensemble_probs_test)

    meta_lr = LogisticRegression(C=0.1, max_iter=200)
    meta_lr.fit(meta_train_X, train_s.label.values)
    meta_val_probs = meta_lr.predict_proba(meta_val_X)[:, 1]
    meta_test_probs = meta_lr.predict_proba(meta_test_X)[:, 1]

    auc_v_stack = get_auc(val_s.label.values, meta_val_probs)
    auc_t_stack = get_auc(test_s.label.values, meta_test_probs)
    thresh_stack = evaluate_threshold(meta_test_probs, test_s.label.values, test_s.pnl_bps.values, 0.60)
    log_result("23_stacking_meta", auc_v_stack, auc_t_stack, thresh_stack, "Stacked meta-learner (LR on 3 XGB probs)")

    print("\n" + "="*80)
    print("ROBUSTNESS")
    print("="*80)

    # 24. 3 random seeds
    seed_probs_test = []
    seed_aucs_val = []
    seed_aucs_test = []
    for seed in [42, 123, 999]:
        ms = XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.05,
                           subsample=0.8, colsample_bytree=0.8,
                           eval_metric="logloss", verbosity=0, random_state=seed)
        ms.fit(train_s[SHORTS_FEATS].values, train_s.label.values)
        vp = ms.predict_proba(val_s[SHORTS_FEATS].values)[:, 1]
        tp = ms.predict_proba(test_s[SHORTS_FEATS].values)[:, 1]
        seed_aucs_val.append(get_auc(val_s.label.values, vp))
        seed_aucs_test.append(get_auc(test_s.label.values, tp))
        seed_probs_test.append(tp)

        t = evaluate_threshold(tp, test_s.label.values, test_s.pnl_bps.values, 0.60)
        log_result(f"24_seed_{seed}", seed_aucs_val[-1], seed_aucs_test[-1], t,
                   f"Seed={seed}")

    print(f"\n  Seed robustness: val_auc {np.mean(seed_aucs_val):.3f} +/- {np.std(seed_aucs_val):.3f}, "
          f"test_auc {np.mean(seed_aucs_test):.3f} +/- {np.std(seed_aucs_test):.3f}")

    # 25. Rolling window CV (5 folds)
    print("\n  Rolling window CV (5 folds):")
    n = len(df[df.is_short == 1])
    shorts_df = df[df.is_short == 1].reset_index(drop=True)
    fold_size = n // 6
    cv_aucs = []
    cv_wrs = []
    cv_pnls = []
    for fold in range(5):
        cv_train_end = fold_size * (fold + 1)
        cv_test_start = cv_train_end
        cv_test_end = cv_train_end + fold_size
        if cv_test_end > n:
            break
        cv_train = shorts_df.iloc[:cv_train_end]
        cv_test = shorts_df.iloc[cv_test_start:cv_test_end]
        if len(cv_train) < 100 or len(cv_test) < 50:
            continue

        m = XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.05,
                          subsample=0.8, colsample_bytree=0.8,
                          eval_metric="logloss", verbosity=0)
        m.fit(cv_train[SHORTS_FEATS].values, cv_train.label.values)
        p = m.predict_proba(cv_test[SHORTS_FEATS].values)[:, 1]
        auc = get_auc(cv_test.label.values, p)
        cv_aucs.append(auc)

        t = evaluate_threshold(p, cv_test.label.values, cv_test.pnl_bps.values, 0.60)
        cv_wrs.append(t["wr"])
        cv_pnls.append(t["total_pnl"])
        print(f"    Fold {fold}: train={len(cv_train)}, test={len(cv_test)}, "
              f"AUC={auc:.3f}, n_filtered={t['n']}, WR={t['wr']:.1f}%, total_pnl={t['total_pnl']:.0f}")

    if cv_aucs:
        print(f"    CV AUC: {np.mean(cv_aucs):.3f} +/- {np.std(cv_aucs):.3f}")
        print(f"    CV WR:  {np.mean(cv_wrs):.1f}% +/- {np.std(cv_wrs):.1f}%")
        log_result("25_rolling_cv", np.mean(cv_aucs), np.mean(cv_aucs),
                   {"n": 0, "wr": np.mean(cv_wrs), "avg_pnl": 0, "total_pnl": np.mean(cv_pnls)},
                   f"5-fold rolling CV, AUC std={np.std(cv_aucs):.3f}")

    print("\n" + "="*80)
    print("THRESHOLD SWEEP ON BEST MODELS")
    print("="*80)

    # Retrain top model (shorts, base feats) on train+val, sweep on test
    train_val_s = pd.concat([train_s, val_s])
    best_model = XGBClassifier(n_estimators=200, max_depth=4, learning_rate=0.05,
                               subsample=0.8, colsample_bytree=0.8,
                               eval_metric="logloss", verbosity=0)
    best_model.fit(train_val_s[SHORTS_FEATS].values, train_val_s.label.values)
    best_probs = best_model.predict_proba(test_s[SHORTS_FEATS].values)[:, 1]

    print("\n  Shorts-only XGBoost (retrained on train+val), test set threshold sweep:")
    for t in [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75]:
        res = evaluate_threshold(best_probs, test_s.label.values, test_s.pnl_bps.values, t)
        print(f"    p >= {t:.2f}: n={res['n']:4d}, WR={res['wr']:.1f}%, "
              f"avg={res['avg_pnl']:.1f} bps, total={res['total_pnl']:.0f} bps")

    # Feature importance
    print("\n  Feature importance (retrained best model):")
    imp = best_model.feature_importances_
    for feat, score in sorted(zip(SHORTS_FEATS, imp), key=lambda x: -x[1]):
        print(f"    {feat:25s}: {score:.4f}")

    # Also sweep the ensemble
    ens_retrain_val = []
    ens_retrain_test = []
    for mdef in [
        (SHORTS_FEATS, dict(n_estimators=200, max_depth=4, learning_rate=0.05)),
        (KITCHEN_FEATS, dict(n_estimators=500, max_depth=3, learning_rate=0.02, min_child_weight=20, gamma=1.0)),
        (SHORTS_FEATS, dict(n_estimators=1000, max_depth=2, learning_rate=0.01, min_child_weight=30)),
    ]:
        feats, params = mdef
        m = XGBClassifier(subsample=0.8, colsample_bytree=0.8, eval_metric="logloss", verbosity=0, **params)
        m.fit(train_val_s[feats].values, train_val_s.label.values)
        ens_retrain_test.append(m.predict_proba(test_s[feats].values)[:, 1])

    ens_test_final = np.mean(ens_retrain_test, axis=0)
    print("\n  Ensemble (retrained on train+val), test set threshold sweep:")
    for t in [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75]:
        res = evaluate_threshold(ens_test_final, test_s.label.values, test_s.pnl_bps.values, t)
        print(f"    p >= {t:.2f}: n={res['n']:4d}, WR={res['wr']:.1f}%, "
              f"avg={res['avg_pnl']:.1f} bps, total={res['total_pnl']:.0f} bps")

    # Save all results
    print("\n" + "="*80)
    print("ALL RESULTS SUMMARY")
    print("="*80)
    res_df = pd.DataFrame(ALL_RESULTS)
    res_df = res_df.sort_values("test_auc", ascending=False)
    print(res_df.to_string(index=False))
    res_df.to_csv(RESULTS_PATH, sep="\t", index=False)
    print(f"\nSaved to {RESULTS_PATH}")

    return res_df


if __name__ == "__main__":
    df, splits = load_and_prepare()
    run_all(df, splits)
