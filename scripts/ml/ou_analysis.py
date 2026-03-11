#!/usr/bin/env python3
"""
Ornstein-Uhlenbeck analysis of PCA residuals.
Tests whether mean-reversion speed (kappa) is statistically significant.

From Cartea/Jaimungal/Penalva Ch.7:
  dX_t = kappa * (theta - X_t) dt + sigma * dW_t

If kappa is significantly > 0, the residual mean-reverts and there's a real process to trade.
If kappa ~ 0, it's a random walk and any "mean reversion" is noise.
"""

import subprocess
import sys
import json
import numpy as np
import pandas as pd
from scipy import stats
from io import StringIO

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


def load_residuals() -> pd.DataFrame:
    sql = """
    COPY (
        SELECT id, timestamp, asset, z_score, residual,
               pnl_bps, position_size_usd,
               pc1_return, ewma_vol_bps
        FROM pca_signals
        WHERE pnl_bps IS NOT NULL
        ORDER BY timestamp
    ) TO STDOUT WITH CSV HEADER
    """
    raw = query_db(sql)
    return pd.read_csv(StringIO(raw))


def estimate_ou_params(x: np.ndarray, dt: float = 1.0):
    """
    MLE for OU process parameters.
    x: time series of residuals
    dt: time step (normalized to 1)

    Returns: kappa, theta, sigma, kappa_stderr, t_stat, p_value
    """
    n = len(x) - 1
    if n < 10:
        return None

    x_lag = x[:-1]
    x_now = x[1:]

    # AR(1) regression: x_{t+1} = a + b * x_t + eps
    slope, intercept, r_value, p_value_slope, std_err = stats.linregress(x_lag, x_now)

    if slope >= 1.0:
        # No mean reversion — unit root
        return {
            'kappa': 0.0, 'theta': 0.0, 'sigma': 0.0,
            'half_life': np.inf, 'ar1_coeff': slope,
            't_stat': 0.0, 'p_value': 1.0, 'n': n,
            'mean_reverts': False
        }

    # OU params from AR(1)
    kappa = -np.log(slope) / dt if slope > 0 else np.inf
    theta = intercept / (1 - slope)
    residuals = x_now - (intercept + slope * x_lag)
    sigma_eps = np.std(residuals)
    sigma = sigma_eps * np.sqrt(2 * kappa / (1 - slope**2)) if slope > 0 and slope < 1 else sigma_eps

    half_life = np.log(2) / kappa if kappa > 0 else np.inf

    # t-stat for mean reversion: test H0: slope = 1 (unit root)
    t_stat = (slope - 1.0) / std_err
    # one-sided p-value (we want slope < 1)
    p_val = stats.t.cdf(t_stat, n - 2)

    return {
        'kappa': kappa,
        'theta': theta,
        'sigma': sigma,
        'half_life': half_life,
        'ar1_coeff': slope,
        't_stat': t_stat,
        'p_value': p_val,
        'n': n,
        'mean_reverts': p_val < 0.05
    }


def analyze_signal_ou(df: pd.DataFrame):
    """
    For each signal, check if the residual was in an OU regime at entry time.
    Use trailing residuals to estimate kappa.
    """
    assets = df['asset'].unique()
    results = []

    for asset in assets:
        asset_df = df[df['asset'] == asset].sort_values('timestamp')
        if len(asset_df) < 30:
            continue

        zscores = asset_df['z_score'].values
        ou = estimate_ou_params(zscores)
        if ou is None:
            continue

        avg_pnl = asset_df['pnl_bps'].mean()
        win_rate = (asset_df['pnl_bps'] > 0).mean()

        results.append({
            'asset': asset,
            'n_signals': len(asset_df),
            **ou,
            'avg_pnl_bps': avg_pnl,
            'win_rate': win_rate,
        })

    return pd.DataFrame(results)


def main():
    print("Loading signal data...")
    df = load_residuals()
    print(f"Loaded {len(df)} signals across {df['asset'].nunique()} assets")

    # 1. Overall OU analysis per asset
    print("\n" + "="*80)
    print("OU PARAMETER ESTIMATION PER ASSET (z-scores)")
    print("="*80)

    results = analyze_signal_ou(df)
    results = results.sort_values('p_value')

    print(f"\n{'Asset':<10} {'n':>5} {'κ (kappa)':>10} {'Half-life':>10} {'AR(1)':>8} {'t-stat':>8} {'p-val':>8} {'MR?':>5} {'AvgPnL':>8} {'WR':>6}")
    print("-"*80)

    mr_count = 0
    for _, r in results.iterrows():
        hl = f"{r['half_life']:.1f}" if r['half_life'] < 1000 else "∞"
        mr = "YES" if r['mean_reverts'] else "no"
        if r['mean_reverts']:
            mr_count += 1
        print(f"{r['asset']:<10} {r['n_signals']:>5} {r['kappa']:>10.4f} {hl:>10} {r['ar1_coeff']:>8.4f} {r['t_stat']:>8.2f} {r['p_value']:>8.4f} {mr:>5} {r['avg_pnl_bps']:>8.2f} {r['win_rate']:>6.1%}")

    print(f"\n{mr_count}/{len(results)} assets show significant mean reversion (p < 0.05)")

    # 2. Key question: do assets with stronger mean reversion have better P&L?
    print("\n" + "="*80)
    print("DOES KAPPA PREDICT PROFITABILITY?")
    print("="*80)

    if len(results) > 10:
        corr_pnl, p_pnl = stats.spearmanr(results['kappa'], results['avg_pnl_bps'])
        corr_wr, p_wr = stats.spearmanr(results['kappa'], results['win_rate'])
        print(f"Spearman corr(kappa, avg_pnl): {corr_pnl:.4f} (p={p_pnl:.4f})")
        print(f"Spearman corr(kappa, win_rate): {corr_wr:.4f} (p={p_wr:.4f})")

        # Split into high-kappa vs low-kappa
        median_kappa = results['kappa'].median()
        high_k = results[results['kappa'] >= median_kappa]
        low_k = results[results['kappa'] < median_kappa]
        print(f"\nHigh-kappa assets (κ >= {median_kappa:.4f}): avg PnL = {high_k['avg_pnl_bps'].mean():.2f} bps, WR = {high_k['win_rate'].mean():.1%}")
        print(f"Low-kappa assets  (κ <  {median_kappa:.4f}): avg PnL = {low_k['avg_pnl_bps'].mean():.2f} bps, WR = {low_k['win_rate'].mean():.1%}")

    # 3. Time-varying kappa: does kappa change over time?
    print("\n" + "="*80)
    print("TIME-VARYING KAPPA (rolling 500-signal windows)")
    print("="*80)

    df_sorted = df.sort_values('timestamp')
    window = 500
    step = 250
    rolling_results = []

    for start in range(0, len(df_sorted) - window, step):
        chunk = df_sorted.iloc[start:start + window]
        ts_start = pd.to_datetime(chunk['timestamp'].iloc[0], unit='ms').date()
        ts_end = pd.to_datetime(chunk['timestamp'].iloc[-1], unit='ms').date()

        zscores = chunk['z_score'].values
        ou = estimate_ou_params(zscores)
        if ou is None:
            continue

        avg_pnl = chunk['pnl_bps'].mean()
        rolling_results.append({
            'period': f"{ts_start} to {ts_end}",
            'kappa': ou['kappa'],
            'half_life': ou['half_life'],
            'ar1': ou['ar1_coeff'],
            'p_value': ou['p_value'],
            'mean_reverts': ou['mean_reverts'],
            'avg_pnl_bps': avg_pnl,
        })

    print(f"\n{'Period':<30} {'κ':>8} {'HL':>8} {'AR(1)':>8} {'p-val':>8} {'MR?':>5} {'PnL':>8}")
    print("-"*80)
    for r in rolling_results:
        hl = f"{r['half_life']:.1f}" if r['half_life'] < 1000 else "∞"
        mr = "YES" if r['mean_reverts'] else "no"
        print(f"{r['period']:<30} {r['kappa']:>8.4f} {hl:>8} {r['ar1']:>8.4f} {r['p_value']:>8.4f} {mr:>5} {r['avg_pnl_bps']:>8.2f}")

    # 4. Optimal entry/exit from OU theory
    print("\n" + "="*80)
    print("OPTIMAL OU ENTRY/EXIT THRESHOLDS (Cartea/Jaimungal)")
    print("="*80)

    # For assets with significant MR, compute optimal thresholds
    mr_assets = results[results['mean_reverts']].sort_values('kappa', ascending=False)
    if len(mr_assets) > 0:
        print(f"\nFor {len(mr_assets)} mean-reverting assets:")
        print(f"{'Asset':<10} {'κ':>8} {'θ':>8} {'σ':>8} {'OptEntry':>10} {'OptExit':>10}")
        print("-"*60)

        for _, r in mr_assets.head(15).iterrows():
            kappa = r['kappa']
            sigma = r['sigma']
            theta = r['theta']
            if kappa <= 0 or sigma <= 0:
                continue
            # Simplified optimal threshold: enter at theta +/- c*sigma/sqrt(2*kappa)
            # From the free-boundary problem solution
            scale = sigma / np.sqrt(2 * kappa)
            # Approximate optimal entry ~1.5-2 scale units from theta
            opt_entry = 1.5 * scale
            opt_exit = 0.5 * scale
            print(f"{r['asset']:<10} {kappa:>8.4f} {theta:>8.4f} {sigma:>8.4f} {opt_entry:>10.4f}σ {opt_exit:>10.4f}σ")
    else:
        print("No assets show significant mean reversion!")

    print("\nDone.")


if __name__ == '__main__':
    main()
