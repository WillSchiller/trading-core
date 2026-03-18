import numpy as np

BANKROLL = 500
N_PATHS = 10_000
N_TRADES = 200

pnls = np.array([
    -39, 21.4633, 49, 2.1249, 14.9478, 0.0149, 0.0086, 0.0085, -3.4319, 29,
    -7.0721, -21.8874, -3.6607, 38.497, 11.2702, 10.677, 0.185, 0.5927,
    -10.4772, 10.1716, 9.3642, -0.1129, -9.5055, -64, 51.0881, 49.957, 60,
    3.0951, 6.2301, 0.0447, 0.0851, 0.0387, 1.5238, -0.8, 2.5324, -15.1763,
    0.9619, -10.0557, -6.4373, -0.0857, 1.1111, 0.1525, 0.076, 1.6296,
    1.4559, 0.5058, 0.0063, 0.0034, 0.0091, 0.0122, 0.0128, 0.0112, 0.0071,
    0.0108, 0.0095, -10.5845, -0.183, -22.4767, -39.482, 0.049, 4.5713,
    4.5788, 0.0015, 0.016, -39.8101, -45, 47, -0.1579, -0.1525, 19.1065, 29,
    45, -53, 0.0008, 0.016, -0.1121, 0.0798, 1.4277, 5.2623, 0.0166,
    -0.3582, -0.0193, 0.0737, -2.9009, 47.1998, 11.2887, -4.6043, -54, -54,
    -5.3498, -21.8939, 52, 48.3822, 51.0234, 0.7932, 0.0872, -32.5057,
    -2.6973, -2.5122, -55.0793, -44, 50, 1.7682, 0.9333, 0.0721, 7.1874,
    19.248, 21.2028, -4.8176, 1.7525, 1.683, 0.4515, -54, 0.0422, -40.1031,
    -51, 52.0001, 19.5089, 41.5085, 4.7393, -40.9992, 36.2662, -4.0914,
    -4.7575, 5.7166, 4.939, 4.9416, 3.5151, 0.5634, 20.7656, 12.9116,
    30.5133, 15.4529, 28.125, 29.6685, 29.4525, 7.5915, 35.4195, 4.662,
    1.206, 1.008, 4.599, 1.179, 2.394, 1.89, 11.808, 2.079, 5.8275, 3.6135
])

wins = pnls[pnls > 0]
losses = pnls[pnls <= 0]
wr = len(wins) / len(pnls)
avg_win = wins.mean()
avg_loss = losses.mean()
ev = wr * avg_win + (1 - wr) * avg_loss

print(f"=== Bankroll Monte Carlo Simulation ===")
print(f"Historical trades: {len(pnls)}")
print(f"Bankroll: ${BANKROLL}")
print(f"Simulating: {N_TRADES} trades x {N_PATHS:,} paths\n")
print(f"Win rate: {wr*100:.1f}%")
print(f"Avg win:  ${avg_win:.2f}    Avg loss: ${avg_loss:.2f}")
print(f"Expected per trade: ${ev:.2f}\n")

np.random.seed(42)
final_eq = np.zeros(N_PATHS)
max_dd = np.zeros(N_PATHS)
ruin = 0
eq_at_50 = []
eq_at_100 = []

for p in range(N_PATHS):
    idx = np.random.randint(0, len(pnls), N_TRADES)
    trades = pnls[idx]
    equity = BANKROLL + np.cumsum(trades)
    peak = np.maximum.accumulate(equity)
    dd = equity - peak
    bust_idx = np.where(equity <= 0)[0]
    if len(bust_idx) > 0:
        ruin += 1
        final_eq[p] = 0
        max_dd[p] = dd[:bust_idx[0]+1].min()
    else:
        final_eq[p] = equity[-1]
        max_dd[p] = dd.min()
    if len(bust_idx) == 0 or bust_idx[0] > 49:
        eq_at_50.append(equity[49])
    if len(bust_idx) == 0 or bust_idx[0] > 99:
        eq_at_100.append(equity[99])

eq_at_50 = np.array(eq_at_50)
eq_at_100 = np.array(eq_at_100)
pct = lambda arr, p: np.percentile(arr, p)

print(f"--- Final Equity After {N_TRADES} Trades ---")
print(f"Mean:       ${final_eq.mean():.2f}")
print(f"Median:     ${pct(final_eq, 50):.2f}")
print(f"5th pctile: ${pct(final_eq, 5):.2f}")
print(f"25th:       ${pct(final_eq, 25):.2f}")
print(f"75th:       ${pct(final_eq, 75):.2f}")
print(f"95th:       ${pct(final_eq, 95):.2f}")

print(f"\n--- Risk Metrics ---")
print(f"P(ruin):             {ruin/N_PATHS*100:.2f}%")
print(f"P(net loss):         {(final_eq < BANKROLL).sum()/N_PATHS*100:.1f}%")
print(f"P(lose > 50%):       {(final_eq < BANKROLL*0.5).sum()/N_PATHS*100:.1f}%")
print(f"P(double bankroll):  {(final_eq >= BANKROLL*2).sum()/N_PATHS*100:.1f}%")

print(f"\n--- Max Drawdown ---")
print(f"Mean DD:    ${max_dd.mean():.2f}")
print(f"Median DD:  ${pct(max_dd, 50):.2f}")
print(f"Worst 5%:   ${pct(max_dd, 5):.2f}")

print(f"\n--- Equity Checkpoints ---")
print(f"At trade 50:  mean ${eq_at_50.mean():.0f}  |  5th ${pct(eq_at_50,5):.0f}  |  95th ${pct(eq_at_50,95):.0f}")
print(f"At trade 100: mean ${eq_at_100.mean():.0f}  |  5th ${pct(eq_at_100,5):.0f}  |  95th ${pct(eq_at_100,95):.0f}")

ev_total = final_eq.mean() - BANKROLL
print(f"\n--- Bottom Line ---")
print(f"Expected profit: ${ev_total:.0f} ({ev_total/BANKROLL*100:.0f}% ROI)")
print(f"Sharpe: {ev_total / final_eq.std():.2f}")
