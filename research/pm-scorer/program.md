# PM Scorer Autoresearch

Autonomous ML research for the Polymarket copy trading scorer model.

## Setup

1. **Read context files**:
   - This file (`program.md`) — instructions
   - `train.py` — the file you modify. Feature engineering, model config, label construction, evaluation.
   - `prepare.py` — fixed. Data loading, train/test split, evaluation metrics, Kelly simulation. Do NOT modify.
   - `/tmp/pm_shadow_export.csv` — the data (1M+ resolved trades from Polymarket shadow tracking)

2. **Create branch**: `git checkout -b autoresearch/pm-<tag>` from current state.
3. **Run baseline**: `cd /Users/will/dev/blockhelix/research/pm-scorer && python3 train.py > run.log 2>&1`
4. **Record in results.tsv**

## Goal

**Maximise the Kelly simulation PnL on the held-out test set** (last 15% of data, strict temporal split).

Secondary metrics (also reported):
- AUC on test set
- Win rate on test set
- Max drawdown in Kelly simulation
- Number of trades taken

The Kelly simulation uses:
- $120 bankroll, compounding
- 100% fill rate, 0 slippage (Rust FAK handles fill; model picks winners)
- Half-Kelly sizing from calibrated probabilities
- 5-minute markets excluded

## What you CAN modify

`train.py` — everything is fair game:
- Feature engineering (add, remove, transform features)
- Label construction (win/loss, APY-based, risk-adjusted, custom)
- Model hyperparameters (depth, trees, learning rate, regularisation)
- Calibration method
- Feature interactions
- Data filtering / weighting
- Multi-model ensembles

## What you CANNOT modify

`prepare.py` — this is the evaluation harness. It contains:
- Data loading and temporal train/cal/val/test split (50/20/15/15)
- Kelly simulation with realistic friction
- Metric computation
- All evaluation is done here — results are trustworthy

## Key constraints

- **Strict temporal split**: train < cal < val < test. No future data leakage.
- **No look-ahead bias**: features must use only data available at trade time. Rolling windows use only past data.
- **`market_trader_count` and `size_vs_median`**: must be computed as expanding (causal) statistics, not full-dataset aggregates.
- **Keep it simple**: a small improvement with ugly complexity is not worth it. Removing features and getting equal results is a win.

## Known findings from prior research

- Entry price is 37% of model importance — the model may be just learning market pricing
- Raw `entry_price` alone gives AUC ~0.80-0.84. Model must beat this.
- "No" bets at 35-50c are profitable (contrarian edge). "No" bets at 65c+ are negative.
- "Yes" bets at 65c+ are the most consistently profitable bucket.
- 5-minute crypto up/down markets are coin flips — excluded from training.
- Trader's rolling WR and streak are genuine signals (not derivable from price).
- `implied_edge`, `price_dist_from_half`, `payoff_ratio`, `is_favourite` are all redundant with `entry_price` — XGBoost learns the same splits.
- Calibration with isotonic regression works well (2-3% error).
- v3 model (clean temporal split): AUC 0.84, 34% WR but profitable from asymmetric payoffs.

## Latest baseline (v2, Mar 30, 2.9M shadow trades)

- v1 (16 features): 222% CAGR at $120, 69.9% WR, 499 trades, AUC 0.87
- v2 (24 features, +outcome/payoff): 112% CAGR at $120, 73.3% WR, 247 trades, AUC 0.87
- v1 takes more trades and makes more money. v2 is pickier but higher WR.
- Key v2 features: payoff_ratio (25%), entry_price (15%), implied_edge (11%), roll_streak (10%), is_yes_underdog (8%)
- is_yes_underdog / is_yes_favourite are high-importance — outcome type matters

## Missing features to try

- Time-to-resolution (hours until event)
- Price momentum (price change in last 1h/4h/24h)
- Trader specialisation (how focused is this trader on one category)
- Market age (how long since market opened)
- neg_risk flag (multi-outcome markets behave differently)
- Outcome type properly classified (Yes/No/team name/Over/Under)
- Trader's WR specifically in this category
- Number of concurrent open positions for this trader

## Output format

The training script prints:

```
---
test_auc:         0.8400
test_brier:       0.1500
kelly_pnl:        1233.00
kelly_cagr:       155.0
kelly_max_dd:     -125.00
kelly_trades:     254
kelly_wr:         72.4
baseline_auc:     0.8000
features_used:    16
```

Extract key metric: `grep "^kelly_pnl:" run.log`

## Logging results

Log to `results.tsv` (tab-separated):

```
commit	kelly_pnl	test_auc	kelly_wr	status	description
```

## The experiment loop

LOOP FOREVER:

1. Look at current state — what features, what label, what hyperparams
2. Form a hypothesis — "adding time-to-resolution should improve capital efficiency scoring"
3. Modify `train.py` with the change
4. `git commit -m "description of change"`
5. Run: `python3 train.py > run.log 2>&1`
6. Read results: `grep "^kelly_pnl:\|^test_auc:" run.log`
7. If crashed: `tail -n 50 run.log`, attempt fix
8. Record in results.tsv
9. If kelly_pnl improved: keep the commit
10. If worse: `git reset --hard HEAD~1`

**NEVER STOP**. Run experiments continuously. If you run out of ideas, re-read the known findings, try combining approaches, try removing things.
