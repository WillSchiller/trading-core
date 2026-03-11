#!/usr/bin/env python3
"""Market making P&L simulation with known data."""

# Data from our earlier queries
assets = {
    #           24h_vol  spread_bps  funding_bps
    "kPEPE":  (9_491_699,   3.0,  -0.14),
    "ARB":    (  961_948,   3.0,  -0.04),
    "SAGA":   (  314_359,   5.8,   0.13),
    "POPCAT": (  292_077,   5.0,   0.13),
    "IO":     (  266_507,   5.0,   0.13),
    "MEME":   (  240_310,   5.0,   0.13),
    "MOODENG":(  224_379,   5.0,   0.13),
    "DYM":    (  206_504,   5.7,  -1.15),
    "MANTA":  (  184_551,   5.0,   0.13),
    "BLUR":   (   83_017,   5.0,  -0.11),
    "BLAST":  (   72_409,  41.0,  -2.26),
    "TURBO":  (   42_942,   5.0,   0.13),
}

POS_SIZE = 200  # $ per fill

print("="*95)
print("MARKET MAKING P&L SIMULATION")
print("="*95)
print()
print("Model: quote at best bid/ask on HL small caps")
print("  - $200 per fill")
print("  - Maker rebate: +1 bps per fill")
print("  - Good fill (70%): earn half-spread + rebate")
print("  - Toxic fill (30%): lose full spread (adverse selection)")
print()

fill_pcts = [0.5, 1.0, 2.0, 5.0, 10.0]

print(f"{'Asset':<10} {'24hVol':>10} {'Sprd':>5} | ", end="")
for fp in fill_pcts:
    print(f"  @{fp}%".rjust(9), end="")
print(f" | {'$/fill':>7} {'fills/$5':>9}")
print("-"*95)

results = []
for coin, (vol, spread, funding) in sorted(assets.items(), key=lambda x: -x[1][0]):
    pnls = []
    for fp in fill_pcts:
        our_vol = vol * (fp / 100)
        n_fills = our_vol / POS_SIZE

        good_pnl = (spread / 2 + 1.0) * POS_SIZE / 10000
        bad_pnl = -(spread * 1.0) * POS_SIZE / 10000
        daily = n_fills * (0.7 * good_pnl + 0.3 * bad_pnl)
        pnls.append(daily)

    pnl_per_fill = 0.7 * ((spread/2 + 1.0) * POS_SIZE / 10000) + 0.3 * (-(spread * 1.0) * POS_SIZE / 10000)
    fills_for_5 = 5.0 / pnl_per_fill if pnl_per_fill > 0 else float('inf')
    fills_at_1pct = vol * 0.01 / POS_SIZE

    print(f"{coin:<10} ${vol:>9,} {spread:>4.0f}bp | ", end="")
    for p in pnls:
        print(f"  ${p:>6.2f}", end="")
    print(f" | ${pnl_per_fill:.4f}  {fills_for_5:>7.0f}")

    results.append({
        'coin': coin, 'vol': vol, 'spread': spread,
        'pnl_per_fill': pnl_per_fill, 'fills_at_1pct': fills_at_1pct,
    })

# Portfolio: top coins by daily P&L at 1% fill
print()
print("="*95)
print("PORTFOLIO: ALL ASSETS AT 1% FILL RATE")
print("="*95)

total_daily = 0
total_fills = 0
for r in results:
    fills = r['vol'] * 0.01 / POS_SIZE
    daily = fills * r['pnl_per_fill']
    total_daily += daily
    total_fills += fills
    print(f"  {r['coin']:<10} {fills:>6.1f} fills/day  ${daily:>6.2f}/day")

print(f"\n  TOTAL:     {total_fills:>6.1f} fills/day  ${total_daily:>6.2f}/day  ${total_daily*365:>8.0f}/yr")

# Adverse selection sensitivity
print()
print("="*95)
print("ADVERSE SELECTION SENSITIVITY (all assets, 1% fill)")
print("="*95)
for toxic in [0.0, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60]:
    total = 0
    for r in results:
        fills = r['vol'] * 0.01 / POS_SIZE
        good = (r['spread']/2 + 1.0) * POS_SIZE / 10000
        bad = -(r['spread'] * 1.0) * POS_SIZE / 10000
        daily = fills * ((1-toxic) * good + toxic * bad)
        total += daily
    status = "<-- our model" if toxic == 0.30 else ""
    print(f"  {toxic:>4.0%} toxic: ${total:>7.2f}/day  ${total*365:>8.0f}/yr  {status}")

# Position sizing
print()
print("="*95)
print("POSITION SIZE SENSITIVITY (all assets, 1% fill, 30% toxic)")
print("="*95)
for pos in [100, 150, 200, 300, 500]:
    total = 0
    total_fills = 0
    for r in results:
        fills = r['vol'] * 0.01 / pos
        good = (r['spread']/2 + 1.0) * pos / 10000
        bad = -(r['spread'] * 1.0) * pos / 10000
        daily = fills * (0.7 * good + 0.3 * bad)
        total += daily
        total_fills += fills
    margin_needed = len(results) * pos  # one side
    with_leverage = margin_needed / 3
    print(f"  ${pos:>3}/fill: ${total:>7.2f}/day  {total_fills:>5.0f} fills  margin=${margin_needed:,}  collateral=${with_leverage:,.0f}")

# What does a day look like?
print()
print("="*95)
print("WHAT DOES A DAY LOOK LIKE? ($200/fill, 1% capture, 30% toxic)")
print("="*95)
total_fills = sum(r['vol'] * 0.01 / POS_SIZE for r in results)
total_pnl = sum(r['vol'] * 0.01 / POS_SIZE * r['pnl_per_fill'] for r in results)
print(f"  Total fills/day: {total_fills:.0f}")
print(f"  Fills/hour: {total_fills/24:.1f}")
print(f"  Avg time between fills: {24*60/total_fills:.1f} min")
print(f"  Daily P&L: ${total_pnl:.2f}")
print(f"  Monthly P&L: ${total_pnl*30:.2f}")
print(f"  On $535 capital: {total_pnl/535*100:.1f}%/day = {total_pnl*365/535*100:.0f}% APY")
