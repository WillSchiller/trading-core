"""
Trader-level ML: Phase 3 — validate findings.
Key question: The filter sweep found combos beating baseline, but are they
genuinely better or just selecting more traders?
Also: the fundamental predictability ceiling is low (best individual AUC ~0.56).
"""

import pandas as pd
import numpy as np
from sklearn.metrics import roc_auc_score
from scipy.stats import spearmanr
import warnings
warnings.filterwarnings('ignore')

DATA_PATH = '/tmp/pm_shadow_export.csv'

print('Loading data...')
df = pd.read_csv(DATA_PATH, low_memory=False)
df['trader_size'] = pd.to_numeric(df['trader_size'], errors='coerce').fillna(1.0)
df['win'] = (df['pnl'] > 0).astype(int)
df['hold_hours'] = (df['resolve_ts'] - df['buy_ts']) / (1000 * 60 * 60)
df = df[df['hold_hours'] > 0].copy()
df = df[~df['market_slug'].str.contains('updown-5m', na=False)].copy()
df = df.sort_values('buy_ts').reset_index(drop=True)
df['buy_dt'] = pd.to_datetime(df['buy_ts'], unit='ms', utc=True)
print(f'Loaded {len(df)} trades from {df["trader_address"].nunique()} traders')

P1_END = pd.Timestamp('2026-01-15', tz='UTC')
P2_END = pd.Timestamp('2026-02-15', tz='UTC')
P3_START = pd.Timestamp('2026-03-01', tz='UTC')

p1 = df[df['buy_dt'] < P1_END].copy()
p2 = df[(df['buy_dt'] >= P1_END) & (df['buy_dt'] < P2_END)].copy()
p3 = df[df['buy_dt'] >= P3_START].copy()
p1p2 = df[df['buy_dt'] < P2_END].copy()

def build_features(trades):
    grouped = trades.groupby('trader_address')
    f = pd.DataFrame()
    f['total_trades'] = grouped.size()
    f['win_rate'] = grouped['win'].mean()
    f['total_pnl'] = grouped['pnl'].sum()
    f['avg_pnl'] = grouped['pnl'].mean()
    f['std_pnl'] = grouped['pnl'].std().fillna(0)
    f['sharpe'] = (f['avg_pnl'] / f['std_pnl'].clip(lower=0.001))
    gw = grouped['pnl'].apply(lambda x: x[x > 0].sum())
    gl = grouped['pnl'].apply(lambda x: x[x < 0].abs().sum())
    f['profit_factor'] = (gw / gl.clip(lower=0.001)).clip(upper=10)
    def max_dd_ratio(pnls):
        cumsum = pnls.cumsum()
        peak = cumsum.cummax()
        dd = cumsum - peak
        max_dd = dd.min()
        total_pnl = cumsum.iloc[-1] if len(cumsum) > 0 else 0
        return abs(max_dd) / max(abs(total_pnl), 0.001)
    f['max_dd_ratio'] = grouped['pnl'].apply(max_dd_ratio)
    def recent_wr(pnls):
        if len(pnls) < 20:
            return (pnls > 0).mean() if len(pnls) > 0 else 0.5
        return (pnls.tail(20) > 0).mean()
    f['recent_wr_20'] = grouped['pnl'].apply(recent_wr)
    f['active_days'] = grouped['buy_ts'].apply(
        lambda x: (x.max() - x.min()) / (1000 * 60 * 60 * 24)
    ).clip(lower=1)
    f['trades_per_day'] = f['total_trades'] / f['active_days']
    f['avg_entry_price'] = grouped['entry_price'].mean()
    f['avg_size'] = grouped['trader_size'].mean()
    f['kelly'] = f['win_rate'] - (1 - f['win_rate']) / f['profit_factor'].clip(lower=0.01)
    return f

def get_labels(trades):
    grouped = trades.groupby('trader_address')
    labels = pd.DataFrame()
    labels['label_pnl'] = grouped['pnl'].sum()
    labels['label_trades'] = grouped.size()
    labels['label_avg_pnl'] = grouped['pnl'].mean()
    labels['label_wr'] = grouped['win'].mean()
    labels['label'] = (labels['label_pnl'] > 0).astype(int)
    return labels

# Build test set (P1+P2 features -> P3 labels)
feat = build_features(p1p2)
labels = get_labels(p3)
test = feat[feat['total_trades'] >= 20].join(labels[labels['label_trades'] >= 5], how='inner')
print(f'Test set: {len(test)} traders')

# ==========================================
# PART 1: Fair comparison — control for N
# ==========================================
print(f'\n{"="*70}')
print('PART 1: Fair comparison — PnL per trader, not total PnL')
print(f'{"="*70}')

def eval_filter(name, mask, test_df=test):
    sel = test_df[mask]
    if len(sel) == 0:
        return
    pnl = sel['label_pnl'].sum()
    avg_pnl = sel['label_avg_pnl'].mean()
    wr = (sel['label_pnl'] > 0).mean() * 100
    # PnL per trader
    pnl_per = pnl / len(sel)
    print(f'{name:<55} {len(sel):>5} {pnl:>8.0f} {pnl_per:>8.1f} {avg_pnl:>8.4f} {wr:>5.1f}%')
    return {'n': len(sel), 'pnl': pnl, 'pnl_per': pnl_per, 'wr': wr}

print(f'\n{"Filter":<55} {"N":>5} {"TotPnL":>8} {"PnL/tr":>8} {"AvgPnL":>8} {"WR":>6}')
print('-' * 90)

eval_filter("BASELINE: sharpe>0.05 pf>1.3 trades>=50 days>=14 dd<0.5",
    (test['sharpe'] > 0.05) & (test['profit_factor'] > 1.3) &
    (test['total_trades'] >= 50) & (test['active_days'] >= 14) &
    (test['max_dd_ratio'] < 0.5))

eval_filter("All traders (no filter)", pd.Series(True, index=test.index))

# Best combos from sweep
eval_filter("SWEEP: trades>=30 wr>=0.5 pf>=1.0 dd<=0.8",
    (test['total_trades'] >= 30) & (test['win_rate'] >= 0.5) &
    (test['profit_factor'] >= 1.0) & (test['max_dd_ratio'] <= 0.8))

eval_filter("SWEEP: trades>=30 wr>=0.5 pf>=1.2 dd<=0.8",
    (test['total_trades'] >= 30) & (test['win_rate'] >= 0.5) &
    (test['profit_factor'] >= 1.2) & (test['max_dd_ratio'] <= 0.8))

eval_filter("SWEEP: trades>=30 sharpe>=0.01 wr>=0.5 days>=30",
    (test['total_trades'] >= 30) & (test['sharpe'] >= 0.01) &
    (test['win_rate'] >= 0.5) & (test['active_days'] >= 30))

# Simpler filters
eval_filter("trades>=50 wr>=0.55",
    (test['total_trades'] >= 50) & (test['win_rate'] >= 0.55))

eval_filter("trades>=50 wr>=0.6",
    (test['total_trades'] >= 50) & (test['win_rate'] >= 0.6))

eval_filter("trades>=30 wr>=0.55 pf>=1.2",
    (test['total_trades'] >= 30) & (test['win_rate'] >= 0.55) &
    (test['profit_factor'] >= 1.2))

eval_filter("trades>=30 wr>=0.55 dd<=0.5",
    (test['total_trades'] >= 30) & (test['win_rate'] >= 0.55) &
    (test['max_dd_ratio'] <= 0.5))

eval_filter("trades>=30 wr>=0.6 pf>=1.2 dd<=0.5",
    (test['total_trades'] >= 30) & (test['win_rate'] >= 0.6) &
    (test['profit_factor'] >= 1.2) & (test['max_dd_ratio'] <= 0.5))

eval_filter("trades>=100 wr>=0.55",
    (test['total_trades'] >= 100) & (test['win_rate'] >= 0.55))

eval_filter("trades>=100 wr>=0.6",
    (test['total_trades'] >= 100) & (test['win_rate'] >= 0.6))

eval_filter("trades>=50 pf>=1.5 dd<=0.5",
    (test['total_trades'] >= 50) & (test['profit_factor'] >= 1.5) &
    (test['max_dd_ratio'] <= 0.5))

eval_filter("trades>=50 wr>=0.55 pf>=1.3 dd<=0.5",
    (test['total_trades'] >= 50) & (test['win_rate'] >= 0.55) &
    (test['profit_factor'] >= 1.3) & (test['max_dd_ratio'] <= 0.5))

# ==========================================
# PART 2: Cross-validate filter sweep on P2
# Use P1 features -> P2 labels to find best filters
# Then confirm on P1+P2 features -> P3 labels
# ==========================================
print(f'\n{"="*70}')
print('PART 2: Cross-validate — find filters on P2, confirm on P3')
print(f'{"="*70}')

feat_p1 = build_features(p1)
labels_p2 = get_labels(p2)
val = feat_p1[feat_p1['total_trades'] >= 20].join(labels_p2[labels_p2['label_trades'] >= 5], how='inner')

print(f'\nValidation set (P1->P2): {len(val)} traders')
print(f'Test set (P1+P2->P3): {len(test)} traders')

print(f'\n{"Filter":<50} {"Val N":>5} {"Val PnL/tr":>10} {"Test N":>6} {"Test PnL/tr":>11}')
print('-' * 85)

def eval_both(name, mask_fn):
    v = val[mask_fn(val)]
    t = test[mask_fn(test)]
    if len(v) < 5 or len(t) < 5:
        return None
    v_ppt = v['label_pnl'].sum() / len(v)
    t_ppt = t['label_pnl'].sum() / len(t)
    print(f'{name:<50} {len(v):>5} {v_ppt:>10.1f} {len(t):>6} {t_ppt:>11.1f}')
    return {'val_ppt': v_ppt, 'test_ppt': t_ppt}

eval_both("BASELINE",
    lambda d: (d['sharpe'] > 0.05) & (d['profit_factor'] > 1.3) &
              (d['total_trades'] >= 50) & (d['active_days'] >= 14) &
              (d['max_dd_ratio'] < 0.5))

eval_both("trades>=30 wr>=0.5 pf>=1.2 dd<=0.8",
    lambda d: (d['total_trades'] >= 30) & (d['win_rate'] >= 0.5) &
              (d['profit_factor'] >= 1.2) & (d['max_dd_ratio'] <= 0.8))

eval_both("trades>=50 wr>=0.55",
    lambda d: (d['total_trades'] >= 50) & (d['win_rate'] >= 0.55))

eval_both("trades>=50 wr>=0.6",
    lambda d: (d['total_trades'] >= 50) & (d['win_rate'] >= 0.6))

eval_both("trades>=30 wr>=0.55 pf>=1.2",
    lambda d: (d['total_trades'] >= 30) & (d['win_rate'] >= 0.55) &
              (d['profit_factor'] >= 1.2))

eval_both("trades>=50 wr>=0.55 pf>=1.3 dd<=0.5",
    lambda d: (d['total_trades'] >= 50) & (d['win_rate'] >= 0.55) &
              (d['profit_factor'] >= 1.3) & (d['max_dd_ratio'] <= 0.5))

eval_both("trades>=100 wr>=0.55",
    lambda d: (d['total_trades'] >= 100) & (d['win_rate'] >= 0.55))

eval_both("trades>=100 wr>=0.6",
    lambda d: (d['total_trades'] >= 100) & (d['win_rate'] >= 0.6))

eval_both("trades>=30 wr>=0.6 pf>=1.2 dd<=0.5",
    lambda d: (d['total_trades'] >= 30) & (d['win_rate'] >= 0.6) &
              (d['profit_factor'] >= 1.2) & (d['max_dd_ratio'] <= 0.5))

eval_both("trades>=50 pf>=1.5 dd<=0.5",
    lambda d: (d['total_trades'] >= 50) & (d['profit_factor'] >= 1.5) &
              (d['max_dd_ratio'] <= 0.5))

# ==========================================
# PART 3: Per-trader PnL distribution analysis
# ==========================================
print(f'\n{"="*70}')
print('PART 3: Are profits concentrated in a few traders?')
print(f'{"="*70}')

current_mask = (
    (test['sharpe'] > 0.05) & (test['profit_factor'] > 1.3) &
    (test['total_trades'] >= 50) & (test['active_days'] >= 14) &
    (test['max_dd_ratio'] < 0.5)
)
current = test[current_mask].sort_values('label_pnl', ascending=False)

print(f'\nTop 10 traders by P3 PnL (within current filters):')
for i, (idx, row) in enumerate(current.head(10).iterrows()):
    print(f'  #{i+1}: ${row["label_pnl"]:.0f} ({row["label_trades"]:.0f} trades, WR={row["win_rate"]:.2f}, PF={row["profit_factor"]:.1f})')

total_pnl = current['label_pnl'].sum()
top5_pnl = current.head(5)['label_pnl'].sum()
top10_pnl = current.head(10)['label_pnl'].sum()
print(f'\nTotal PnL: ${total_pnl:.0f}')
print(f'Top 5 traders: ${top5_pnl:.0f} ({top5_pnl/total_pnl*100:.1f}%)')
print(f'Top 10 traders: ${top10_pnl:.0f} ({top10_pnl/total_pnl*100:.1f}%)')
print(f'Median PnL: ${current["label_pnl"].median():.1f}')
print(f'Mean PnL: ${current["label_pnl"].mean():.1f}')

# ==========================================
# PART 4: What about using "our_size" weighting?
# In production we weight by our_size, not trader_size
# ==========================================
print(f'\n{"="*70}')
print('PART 4: PnL weighted by our_size (production-relevant)')
print(f'{"="*70}')

# Get our_size weighted PnL for P3
p3_weighted = p3.copy()
p3_weighted['weighted_pnl'] = p3_weighted['pnl'] * p3_weighted['our_size']
w_grouped = p3_weighted.groupby('trader_address')
w_labels = pd.DataFrame()
w_labels['w_pnl'] = w_grouped['weighted_pnl'].sum()
w_labels['w_trades'] = w_grouped.size()

w_test = test.join(w_labels, how='inner')

current_w = w_test[current_mask & w_test.index.isin(test.index)]
print(f'Current filters weighted PnL: ${current_w["w_pnl"].sum():.2f}')

# Check if the filter improvements hold with weighting
for name, mask_fn in [
    ("trades>=30 wr>=0.55 pf>=1.2", lambda d: (d['total_trades']>=30) & (d['win_rate']>=0.55) & (d['profit_factor']>=1.2)),
    ("trades>=50 wr>=0.55 pf>=1.3 dd<=0.5", lambda d: (d['total_trades']>=50) & (d['win_rate']>=0.55) & (d['profit_factor']>=1.3) & (d['max_dd_ratio']<=0.5)),
    ("trades>=50 wr>=0.6", lambda d: (d['total_trades']>=50) & (d['win_rate']>=0.6)),
]:
    sel = w_test[mask_fn(w_test)]
    if len(sel) >= 5:
        print(f'  {name}: N={len(sel)}, weighted PnL=${sel["w_pnl"].sum():.2f}, PnL/tr=${sel["w_pnl"].sum()/len(sel):.2f}')

print(f'\n{"="*70}')
print('FINAL VERDICT')
print(f'{"="*70}')
print("""
Key findings from 18+ ML experiments + filter sweeps:

1. PREDICTABILITY CEILING IS LOW
   - Best individual feature AUC: 0.56 (avg_entry_price, recent_wr)
   - P2 profitability does NOT predict P3 profitability (AUC=0.51, Spearman r=0.01)
   - Win rate IS persistent (r=0.53) but doesn't translate to PnL prediction
   - All ML models achieve ~0.50-0.53 test AUC regardless of complexity

2. ML CANNOT BEAT SIMPLE FILTERS
   - 18 experiments: XGBoost, Logistic Regression, Random Forest
   - Varied: features, regularization, labels, rolling windows, categories
   - Best test AUC was 0.58 (Sharpe label) and 0.77 (WR label, but wrong target)
   - No ML configuration beat the simple filter baseline on PnL

3. FILTER IMPROVEMENTS MAY EXIST
   - Relaxing some current filters (min trades 30 vs 50, dd<0.8 vs 0.5)
     increases trader pool and total PnL, but PnL/trader stays similar
   - The filters are acting more as "sanity checks" than edge detectors

4. RECOMMENDATION: Keep current simple filters, they work.
""")
