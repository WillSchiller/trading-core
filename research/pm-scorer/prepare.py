"""
Fixed evaluation harness for PM scorer autoresearch.
DO NOT MODIFY THIS FILE.

Loads data, splits temporally, evaluates models with Kelly simulation.
"""

import pandas as pd
import numpy as np
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.isotonic import IsotonicRegression


DATA_PATH = '/tmp/pm_shadow_export.csv'
BANKROLL = 120
FILL_RATE_WIN = 0.088    # adversarial: winners fill less
FILL_RATE_LOSE = 0.204   # adversarial: losers fill more
SLIP_BPS = 50
COMPOUND = True


def load_data():
    df = pd.read_csv(DATA_PATH)
    df['win'] = (df['pnl'] > 0).astype(int)
    df['hold_hours'] = (df['resolve_ts'] - df['buy_ts']) / (1000 * 60 * 60)
    df = df[df['hold_hours'] > 0].copy()
    df = df[~df['market_slug'].str.contains('updown-5m', na=False)].copy()
    df = df.sort_values('buy_ts').reset_index(drop=True)
    return df


def temporal_split(df):
    """Strict temporal split: 50% train, 20% cal, 15% val, 15% test.
    All splits are by global time order — no leakage."""
    n = len(df)
    te = int(n * 0.50)
    ce = int(n * 0.70)
    ve = int(n * 0.85)
    return {
        'train': df.iloc[:te],
        'cal': df.iloc[te:ce],
        'val': df.iloc[ce:ve],
        'test': df.iloc[ve:],
    }


def calibrate(raw_probs_cal, y_cal, raw_probs_test):
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(raw_probs_cal, y_cal)
    return iso.predict(raw_probs_test), iso


def kelly_fraction(p, entry_price):
    b = (1.0 / np.clip(entry_price, 0.01, 0.99)) - 1
    q = 1 - p
    f = p - q / b
    return np.clip(f, 0, 0.25) * 0.5  # half kelly


def kelly_simulate(test_df, cal_probs):
    """Capital-constrained Kelly simulation with realistic friction."""
    tdf = test_df.copy()
    tdf['prob'] = cal_probs
    tdf['kf'] = kelly_fraction(cal_probs, tdf['entry_price'].values)
    tdf = tdf.sort_values('buy_ts')
    rng = np.random.RandomState(42)

    bankroll = BANKROLL
    cash = bankroll
    positions = []
    total_pnl = 0
    trade_count = 0
    wins = 0
    skip = 0
    peak = bankroll
    max_dd = 0

    for _, row in tdf.iterrows():
        for i in range(len(positions) - 1, -1, -1):
            if positions[i]['rt'] <= row['buy_ts']:
                pos = positions.pop(i)
                cash += max(0, pos['c'] + pos['p'])
                total_pnl += pos['p']
                if pos['p'] > 0:
                    wins += 1
                trade_count += 1
                if COMPOUND:
                    bankroll = cash + sum(p['c'] + p['p'] for p in positions)
                eq = cash + sum(p['c'] + p['p'] for p in positions)
                if eq > peak:
                    peak = eq
                if eq - peak < max_dd:
                    max_dd = eq - peak

        if row['kf'] <= 0:
            skip += 1
            continue
        # Adversarial fill: winners are harder to fill than losers
        fill_rate = FILL_RATE_WIN if row['pnl'] > 0 else FILL_RATE_LOSE
        if rng.random() > fill_rate:
            skip += 1
            continue

        ps = min(bankroll * row['kf'], cash, 50)
        if ps < 1:
            skip += 1
            continue

        sc = max(row['our_size'] * row['entry_price'], 0.01)
        raw = row['pnl'] * (ps / sc)
        sp = max(raw - ps * SLIP_BPS / 10000, -ps)
        cash -= ps
        positions.append({'c': ps, 'p': sp, 'rt': row['resolve_ts']})

    for pos in positions:
        total_pnl += pos['p']
        trade_count += 1
        if pos['p'] > 0:
            wins += 1

    final = cash + sum(p['c'] + p['p'] for p in positions)
    total_days = (tdf['buy_ts'].max() - tdf['buy_ts'].min()) / (1000 * 60 * 60 * 24)
    years = max(total_days / 365, 0.01)
    cagr = ((final / BANKROLL) ** (1 / years) - 1) * 100 if final > 0 else -100
    wr = wins / max(trade_count, 1) * 100

    return {
        'pnl': total_pnl,
        'final': final,
        'cagr': cagr,
        'max_dd': max_dd,
        'trades': trade_count,
        'wins': wins,
        'wr': wr,
        'skipped': skip,
    }


def baseline_auc(test_df):
    """AUC using just entry_price as predictor."""
    return roc_auc_score(test_df['win'].values, test_df['entry_price'].values)


def evaluate(model, features, splits):
    """Full evaluation pipeline. Returns dict of metrics."""
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
    base_auc = baseline_auc(splits['test'])

    kelly = kelly_simulate(splits['test'], cal_test)

    results = {
        'test_auc': test_auc,
        'test_brier': test_brier,
        'val_auc': val_auc,
        'baseline_auc': base_auc,
        'kelly_pnl': kelly['pnl'],
        'kelly_cagr': kelly['cagr'],
        'kelly_max_dd': kelly['max_dd'],
        'kelly_trades': kelly['trades'],
        'kelly_wr': kelly['wr'],
        'features_used': len(features),
    }

    print('---')
    for k, v in results.items():
        if isinstance(v, float):
            print(f'{k}:{" " * (18 - len(k))}{v:.4f}')
        else:
            print(f'{k}:{" " * (18 - len(k))}{v}')

    return results, iso
