#!/usr/bin/env python3
"""
Offline PCA stat-arb backtester using hourly candles.
Produces synthetic signals CSV for ML research.
"""

import json
import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from pathlib import Path
from datetime import datetime

DATA_DIR = Path(__file__).parent / "data"
CANDLES_PATH = DATA_DIR / "candles.json"
OUTPUT_PATH = DATA_DIR / "synthetic_signals.csv"

# Strategy params (match TS version)
PCA_WINDOW = 30
N_COMPONENTS = 2
EWMA_ALPHA = 0.06
Z_THRESHOLD = 2.0
MAX_HOLD = 60  # hours (hourly bars)
STOP_LOSS_BPS = 150
VOL_GATE_BPS = 0  # disabled for hourly — vol is feature, not gate (125bps calibrated for 1-min)


def load_candles():
    with open(CANDLES_PATH) as f:
        raw = json.load(f)

    assets = sorted(raw.keys())
    timestamps = sorted(set(int(c["t"]) for c in raw[assets[0]]))

    price_df = pd.DataFrame(index=timestamps)
    for asset in assets:
        ts_price = {int(c["t"]): float(c["c"]) for c in raw[asset]}
        price_df[asset] = price_df.index.map(lambda t, tp=ts_price: tp.get(t, np.nan))

    price_df.index = pd.to_datetime(price_df.index, unit="ms")
    price_df = price_df.dropna(axis=1, thresh=int(len(price_df) * 0.9))
    price_df = price_df.ffill().bfill()
    print(f"Loaded {len(price_df)} hourly bars for {len(price_df.columns)} assets")
    return price_df


def run_backtest(price_df):
    assets = list(price_df.columns)
    log_returns = np.log(price_df / price_df.shift(1))
    log_returns = log_returns.iloc[1:]  # drop first NaN row

    n_bars = len(log_returns)
    n_assets = len(assets)

    # EWMA state per asset
    ewma_mean = np.zeros(n_assets)
    ewma_var = np.zeros(n_assets)
    ewma_initialized = False

    # Position tracking: one position per asset at a time
    positions = {}  # asset_idx -> {direction, entry_price, entry_bar, z_score, residual, pc1_ret, pc2_ret, ewma_vol}

    signals = []
    pca = PCA(n_components=N_COMPONENTS)

    # PC1 momentum tracking
    pc1_history = []
    PC1_MOM_WINDOW = 12

    for bar_idx in range(PCA_WINDOW, n_bars):
        window = log_returns.iloc[bar_idx - PCA_WINDOW : bar_idx].values
        if np.any(np.isnan(window)):
            continue

        try:
            pca.fit(window)
        except Exception:
            continue

        loadings = pca.components_  # (n_components, n_assets)
        scores = window @ loadings.T  # (PCA_WINDOW, n_components)

        current_returns = log_returns.iloc[bar_idx].values
        current_scores = current_returns @ loadings.T
        reconstructed = current_scores @ loadings
        residuals = current_returns - reconstructed

        pc1_ret = current_scores[0]
        pc2_ret = current_scores[1]

        # PC1 momentum for regime
        pc1_history.append(pc1_ret)
        if len(pc1_history) > PC1_MOM_WINDOW:
            pc1_history = pc1_history[-PC1_MOM_WINDOW:]
        pc1_momentum = sum(pc1_history) / len(pc1_history)

        if pc1_momentum > 0.001:
            regime = "bullish"
        elif pc1_momentum < -0.001:
            regime = "bearish"
        else:
            regime = "neutral"

        # Update EWMA
        if not ewma_initialized:
            ewma_mean = residuals.copy()
            ewma_var = np.full(n_assets, 1e-6)
            ewma_initialized = True
        else:
            ewma_mean = EWMA_ALPHA * residuals + (1 - EWMA_ALPHA) * ewma_mean
            diff = residuals - ewma_mean
            ewma_var = EWMA_ALPHA * (diff ** 2) + (1 - EWMA_ALPHA) * ewma_var

        ewma_std = np.sqrt(ewma_var)
        ewma_std = np.maximum(ewma_std, 1e-8)
        z_scores = (residuals - ewma_mean) / ewma_std
        ewma_vol_bps = ewma_std * 10000

        current_prices = price_df.iloc[bar_idx + 1].values  # +1 because log_returns is shifted
        bar_time = log_returns.index[bar_idx]
        hour = bar_time.hour
        dow = bar_time.dayofweek

        # Check exits first
        for asset_idx in list(positions.keys()):
            pos = positions[asset_idx]
            price_now = current_prices[asset_idx]
            entry_price = pos["entry_price"]
            bars_held = bar_idx - pos["entry_bar"]

            if pos["direction"] == "short":
                pnl_bps = (entry_price - price_now) / entry_price * 10000
            else:
                pnl_bps = (price_now - entry_price) / entry_price * 10000

            z_now = z_scores[asset_idx]
            exit_reason = None

            # Zero cross exit
            if pos["direction"] == "short" and z_now <= 0:
                exit_reason = "zero_cross"
            elif pos["direction"] == "long" and z_now >= 0:
                exit_reason = "zero_cross"

            # Stop loss
            if pnl_bps <= -STOP_LOSS_BPS:
                exit_reason = "stop_loss"

            # Time stop
            if bars_held >= MAX_HOLD:
                exit_reason = "time_stop"

            if exit_reason:
                signals.append({
                    "asset": assets[asset_idx],
                    "direction": pos["direction"],
                    "z_score": pos["z_score"],
                    "residual": pos["residual"],
                    "pc1_return": pos["pc1_ret"],
                    "pc2_return": pos["pc2_ret"],
                    "entry_price": entry_price,
                    "exit_price": price_now,
                    "pnl_bps": round(pnl_bps, 2),
                    "hold_hours": bars_held,
                    "ewma_vol": round(pos["ewma_vol"], 2),
                    "regime_state": regime,
                    "exit_reason": exit_reason,
                    "hour": pos["hour"],
                    "dow": pos["dow"],
                    "ts": int(bar_time.timestamp()),
                })
                del positions[asset_idx]

        # Check entries
        for asset_idx in range(n_assets):
            if asset_idx in positions:
                continue

            z = z_scores[asset_idx]
            vol = ewma_vol_bps[asset_idx]

            if vol < VOL_GATE_BPS:
                continue

            direction = None
            if z >= Z_THRESHOLD:
                direction = "short"
            elif z <= -Z_THRESHOLD:
                direction = "long"

            if direction:
                positions[asset_idx] = {
                    "direction": direction,
                    "entry_price": current_prices[asset_idx],
                    "entry_bar": bar_idx,
                    "z_score": round(z, 4),
                    "residual": round(residuals[asset_idx], 8),
                    "pc1_ret": round(pc1_ret, 8),
                    "pc2_ret": round(pc2_ret, 8),
                    "ewma_vol": vol,
                    "hour": hour,
                    "dow": dow,
                }

    # Close remaining positions at last price
    for asset_idx, pos in positions.items():
        price_now = price_df.iloc[-1][assets[asset_idx]]
        entry_price = pos["entry_price"]
        bars_held = n_bars - 1 - pos["entry_bar"]
        if pos["direction"] == "short":
            pnl_bps = (entry_price - price_now) / entry_price * 10000
        else:
            pnl_bps = (price_now - entry_price) / entry_price * 10000
        signals.append({
            "asset": assets[asset_idx],
            "direction": pos["direction"],
            "z_score": pos["z_score"],
            "residual": pos["residual"],
            "pc1_return": pos["pc1_ret"],
            "pc2_return": pos["pc2_ret"],
            "entry_price": entry_price,
            "exit_price": price_now,
            "pnl_bps": round(pnl_bps, 2),
            "hold_hours": bars_held,
            "ewma_vol": pos["ewma_vol"],
            "regime_state": "unknown",
            "exit_reason": "end_of_data",
            "hour": pos["hour"],
            "dow": pos["dow"],
            "ts": int(log_returns.index[-1].timestamp()),
        })

    return pd.DataFrame(signals)


def print_summary(df):
    print(f"\n{'='*60}")
    print(f"BACKTEST SUMMARY")
    print(f"{'='*60}")
    print(f"Total signals: {len(df)}")
    print(f"Shorts: {len(df[df.direction=='short'])}, Longs: {len(df[df.direction=='long'])}")

    completed = df[df.exit_reason != "end_of_data"]
    print(f"Completed: {len(completed)}")

    if len(completed) == 0:
        return

    wins = completed[completed.pnl_bps > 0]
    wr = len(wins) / len(completed) * 100
    avg_pnl = completed.pnl_bps.mean()
    avg_win = wins.pnl_bps.mean() if len(wins) > 0 else 0
    losses = completed[completed.pnl_bps <= 0]
    avg_loss = losses.pnl_bps.mean() if len(losses) > 0 else 0

    print(f"Win rate: {wr:.1f}%")
    print(f"Avg PnL: {avg_pnl:.1f} bps")
    print(f"Avg win: {avg_win:.1f} bps, Avg loss: {avg_loss:.1f} bps")
    print(f"Total PnL: {completed.pnl_bps.sum():.0f} bps")
    print(f"Avg hold: {completed.hold_hours.mean():.1f} hours")

    print(f"\nExit reasons:")
    for reason, count in completed.exit_reason.value_counts().items():
        sub = completed[completed.exit_reason == reason]
        print(f"  {reason}: {count} ({len(sub[sub.pnl_bps>0])/len(sub)*100:.0f}% WR, {sub.pnl_bps.mean():.1f} avg)")

    print(f"\nPer-direction:")
    for d in ["short", "long"]:
        sub = completed[completed.direction == d]
        if len(sub) == 0:
            continue
        w = len(sub[sub.pnl_bps > 0]) / len(sub) * 100
        print(f"  {d}: {len(sub)} signals, {w:.1f}% WR, {sub.pnl_bps.mean():.1f} avg")

    print(f"\nTop 10 assets by signal count:")
    for asset, group in completed.groupby("asset"):
        pass
    top = completed.groupby("asset").agg(
        n=("pnl_bps", "count"),
        wr=("pnl_bps", lambda x: (x > 0).mean() * 100),
        avg=("pnl_bps", "mean"),
        total=("pnl_bps", "sum"),
    ).sort_values("n", ascending=False).head(10)
    print(top.to_string())

    print(f"\nZ-score distribution: mean={completed.z_score.abs().mean():.2f}, std={completed.z_score.abs().std():.2f}")
    print(f"EWMA vol distribution: mean={completed.ewma_vol.mean():.1f}, std={completed.ewma_vol.std():.1f}")


if __name__ == "__main__":
    price_df = load_candles()
    signals_df = run_backtest(price_df)
    print_summary(signals_df)
    signals_df.to_csv(OUTPUT_PATH, index=False)
    print(f"\nSaved {len(signals_df)} signals to {OUTPUT_PATH}")
