import pandas as pd
import numpy as np

df = pd.read_csv('/tmp/pm_trades.csv')
df = df.sort_values(['trader_address', 'trader_timestamp'])

SPLIT = 0.6  # 60% train, 40% test
MIN_TRAIN_TRADES = 20
MIN_TEST_TRADES = 10

results = []

for addr, group in df.groupby('trader_address'):
    n = len(group)
    if n < MIN_TRAIN_TRADES + MIN_TEST_TRADES:
        continue

    split_idx = int(n * SPLIT)
    train = group.iloc[:split_idx]
    test = group.iloc[split_idx:]

    train_pnl = train['pnl'].sum()
    train_wr = (train['pnl'] > 0).mean()
    train_avg = train['pnl'].mean()
    train_n = len(train)

    test_pnl = test['pnl'].sum()
    test_wr = (test['pnl'] > 0).mean()
    test_avg = test['pnl'].mean()
    test_n = len(test)

    results.append({
        'address': addr[:10],
        'total_n': n,
        'train_n': train_n,
        'train_pnl': train_pnl,
        'train_wr': train_wr,
        'train_avg': train_avg,
        'test_n': test_n,
        'test_pnl': test_pnl,
        'test_wr': test_wr,
        'test_avg': test_avg,
        'train_positive': train_pnl > 0,
        'test_positive': test_pnl > 0,
    })

res = pd.DataFrame(results).sort_values('train_pnl', ascending=False)

print("=" * 80)
print("TRAIN/TEST SPLIT ANALYSIS — ALL POLYMARKET TRADERS")
print(f"Split: {SPLIT:.0%} train / {1-SPLIT:.0%} test | Min {MIN_TRAIN_TRADES} train, {MIN_TEST_TRADES} test trades")
print(f"Traders with enough data: {len(res)}")
print("=" * 80)

print(f"\n--- FULL TABLE (sorted by train PnL) ---")
print(f"{'addr':<12} {'n':>5} {'trn_n':>5} {'trn_pnl':>9} {'trn_wr':>7} {'tst_n':>5} {'tst_pnl':>9} {'tst_wr':>7} {'persist':>8}")
print("-" * 80)
for _, r in res.iterrows():
    persist = "YES" if r['train_positive'] and r['test_positive'] else "FAIL" if r['train_positive'] else "-"
    print(f"{r['address']:<12} {r['total_n']:>5} {r['train_n']:>5} {r['train_pnl']:>9.2f} {r['train_wr']:>6.1%} {r['test_n']:>5} {r['test_pnl']:>9.2f} {r['test_wr']:>6.1%} {persist:>8}")

# Key stats
train_winners = res[res['train_positive']]
n_train_win = len(train_winners)
n_persist = len(train_winners[train_winners['test_positive']])

print(f"\n--- SUMMARY ---")
print(f"Traders profitable in train:  {n_train_win}/{len(res)}")
print(f"Of those, profitable in test: {n_persist}/{n_train_win}")
print(f"Persistence rate:             {n_persist/n_train_win*100:.0f}%" if n_train_win > 0 else "N/A")

if n_persist > 0:
    persisters = train_winners[train_winners['test_positive']]
    print(f"\n--- PERSISTERS (profitable in both train AND test) ---")
    for _, r in persisters.iterrows():
        print(f"  {r['address']}: train ${r['train_pnl']:.2f} ({r['train_wr']:.0%} WR, n={r['train_n']}) → test ${r['test_pnl']:.2f} ({r['test_wr']:.0%} WR, n={r['test_n']})")

# Null hypothesis: if everyone is random (50% WR, 0 EV), what persistence rate would we expect?
n_sims = 10000
null_persist = []
for _ in range(n_sims):
    fake_train_positive = np.random.random(len(res)) > 0.5
    fake_test_positive = np.random.random(len(res)) > 0.5
    n_tw = fake_train_positive.sum()
    if n_tw > 0:
        null_persist.append((fake_train_positive & fake_test_positive).sum() / n_tw)
null_persist = np.array(null_persist)

actual_rate = n_persist / n_train_win if n_train_win > 0 else 0
p_value = (null_persist >= actual_rate).mean()

print(f"\n--- NULL HYPOTHESIS TEST ---")
print(f"If traders are random coin flips:")
print(f"  Expected persistence rate: {null_persist.mean():.0%}")
print(f"  Actual persistence rate:   {actual_rate:.0%}")
print(f"  p-value:                   {p_value:.3f}")
print(f"  Significant (p<0.05)?      {'YES' if p_value < 0.05 else 'NO'}")
