# Competition Readiness Checklist

**Priority order for week-1 competition**

## Top 3 Tasks (Must Have)

### 1. P&L Attribution
- Split P&L into `PC1 component` vs `residual component`
- If most P&L explained by PC1 → running trend/short beta, not stat-arb
- Add: `corr(P&L, PC1)` over rolling window
- Add: regression slope of position returns on PC1

### 2. Factor-Neutral Sizing
Current: equal notional ($100 per position) — **wrong for stat-arb**

Options:
- **Factor neutral**: weight each asset by `-loading_on_PC1`
- **Vol-adjusted**: `notional ∝ 1 / vol(asset)`
- Goal: portfolio PC1 exposure ~ 0

### 3. Realized Metrics
Need:
- Realized P&L distribution (mean/median)
- Win rate
- Average hold time
- Tail loss (p95 loss)
- Max drawdown of equity curve
- MAE/MFE per position

---

## Entry Quality Filters (Nice to Have)

Pick one:
- **Z-score velocity**: require |z| increasing for shorts, |z| peaking then reverting for longs
- **Minimum residual magnitude**: only trade if residual bps > X
- **Cooldown per asset**: after exit, don't re-enter same asset for N ticks

---

## Risk Flags to Monitor

1. **Regime misclassification during chop** — hysteresis helps but won't eliminate
2. **Crowding into same names** — DOT appeared twice in early signals
3. **Hidden beta leakage** — thinking it's stat-arb but actually "short risk"

---

## Validation Questions

- Is P&L mostly PC1 or residual?
- Are shorts winning because of idiosyncratic momentum or because crypto went down?
- Is MAE huge relative to realized P&L? (edge vs variance)
