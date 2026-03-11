#!/usr/bin/env python3
"""
Market making simulation for HL small caps.
How many fills per day can we realistically get?
What does the P&L look like?
"""

import subprocess
import json
import numpy as np

def query_hl(payload: dict) -> dict:
    cmd = f'''ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@3.1.140.199 'python3 -c "
import json, urllib.request
req = urllib.request.Request(
    \\"https://api.hyperliquid.xyz/info\\",
    data=json.dumps({json.dumps(payload)}).encode(),
    headers={{\\"Content-Type\\": \\"application/json\\"}})
print(json.dumps(json.loads(urllib.request.urlopen(req).read())))
"' '''
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
    return json.loads(result.stdout.strip())


def main():
    # Get metadata
    data = query_hl({"type": "metaAndAssetCtxs"})
    meta = data[0]
    ctxs = data[1]
    name_map = {m["name"]: i for i, m in enumerate(meta["universe"])}

    targets = ["DYM", "MOODENG", "SAGA", "POPCAT", "MEME", "MANTA", "IO", "BLUR", "ARB", "kPEPE",
               "TURBO", "BLAST", "BRETT", "NOT", "BOME", "TNSR", "W", "ZETA"]

    # Observed spreads from earlier
    spreads_bps = {
        "ARB": 3.0, "kPEPE": 3.0, "POPCAT": 5.0, "MOODENG": 5.0,
        "SAGA": 5.8, "DYM": 5.7, "BLAST": 41.0, "MANTA": 5.0,
        "TNSR": 5.0, "BOME": 5.0, "TURBO": 5.0, "NOT": 5.0,
        "BRETT": 5.0, "IO": 5.0, "MEME": 5.0, "BLUR": 5.0,
        "W": 5.0, "ZETA": 5.0,
    }

    print("="*90)
    print("MARKET MAKING P&L SIMULATION")
    print("="*90)
    print()
    print("Assumptions:")
    print("  - $200 position size per side")
    print("  - Quote at best bid/ask (capture full spread on one side)")
    print("  - Maker rebate: 1 bps per fill")
    print("  - Adverse selection: 30% of fills are 'toxic' (lose 2x spread)")
    print("  - Fill rate: we capture X% of daily volume as fills")
    print()

    fill_pcts = [0.5, 1.0, 2.0, 5.0]
    position_size = 200

    print(f"{'Asset':<10} {'24hVol':>10} {'Spread':>7} | ", end="")
    for fp in fill_pcts:
        print(f"{'@'+str(fp)+'%':>10}", end="")
    print(f" | {'FillsNeeded':>12}")
    print("-"*90)

    results = []
    for coin in targets:
        if coin not in name_map or coin not in spreads_bps:
            continue
        idx = name_map[coin]
        ctx = ctxs[idx]
        vol_24h = float(ctx["dayNtlVlm"])
        spread = spreads_bps[coin]
        funding = float(ctx["funding"]) * 10000

        pnls = []
        for fp in fill_pcts:
            # Total volume we'd fill
            our_volume = vol_24h * (fp / 100)
            # Number of fills (each fill is $200)
            n_fills = our_volume / position_size

            # Revenue per fill:
            # 70% good fills: earn half-spread + rebate
            # 30% toxic fills: lose spread (adverse selection)
            good_fill_pnl = (spread / 2 + 1.0) * position_size / 10000  # $ per good fill
            bad_fill_pnl = -(spread * 1.0) * position_size / 10000  # $ per bad fill

            daily_pnl = n_fills * (0.7 * good_fill_pnl + 0.3 * bad_fill_pnl)

            # Add funding income (assume net long bias of $100 avg)
            funding_pnl = abs(funding) * 100 / 10000 * 24 if funding < 0 else 0

            total_daily = daily_pnl + funding_pnl
            pnls.append(total_daily)

        # How many fills/day to make $5/day?
        good_pnl = (spread / 2 + 1.0) * position_size / 10000
        bad_pnl = -(spread * 1.0) * position_size / 10000
        pnl_per_fill = 0.7 * good_pnl + 0.3 * bad_pnl
        fills_for_5 = 5.0 / pnl_per_fill if pnl_per_fill > 0 else float('inf')

        print(f"{coin:<10} ${vol_24h:>9,.0f} {spread:>6.1f}bp | ", end="")
        for p in pnls:
            print(f"  ${p:>7.2f}", end="")
        print(f" | {fills_for_5:>10.0f} fills")

        results.append({
            'coin': coin, 'vol': vol_24h, 'spread': spread,
            'pnl_1pct': pnls[1], 'pnl_per_fill': pnl_per_fill,
            'fills_for_5': fills_for_5, 'funding': funding
        })

    # Summary
    print()
    print("="*90)
    print("SCENARIO ANALYSIS: Running 5 assets simultaneously")
    print("="*90)

    # Pick top 5 by volume * spread
    by_opportunity = sorted(results, key=lambda x: x['vol'] * x['spread'], reverse=True)[:5]
    print(f"\nTop 5 by opportunity score (volume * spread):")
    for fp in fill_pcts:
        total = 0
        for r in by_opportunity:
            our_vol = r['vol'] * (fp / 100)
            n_fills = our_vol / position_size
            good = (r['spread'] / 2 + 1.0) * position_size / 10000
            bad = -(r['spread'] * 1.0) * position_size / 10000
            daily = n_fills * (0.7 * good + 0.3 * bad)
            funding_add = abs(r['funding']) * 100 / 10000 * 24 if r['funding'] < 0 else 0
            total += daily + funding_add
        coins = ", ".join(r['coin'] for r in by_opportunity)
        print(f"  {fp}% fill rate: ${total:.2f}/day (${total*365:.0f}/yr) — {coins}")

    # What about adverse selection sensitivity?
    print()
    print("="*90)
    print("ADVERSE SELECTION SENSITIVITY (1% fill rate, top 5 assets)")
    print("="*90)
    for adv_pct in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]:
        total = 0
        for r in by_opportunity:
            our_vol = r['vol'] * 0.01
            n_fills = our_vol / position_size
            good = (r['spread'] / 2 + 1.0) * position_size / 10000
            bad = -(r['spread'] * 1.0) * position_size / 10000
            daily = n_fills * ((1-adv_pct) * good + adv_pct * bad)
            total += daily
        print(f"  {adv_pct:.0%} toxic fills: ${total:.2f}/day")

    # Capital efficiency
    print()
    print("="*90)
    print("CAPITAL REQUIREMENTS")
    print("="*90)
    print("  5 assets x $200 per side x 2 sides = $2,000 margin needed")
    print("  With 3x leverage: ~$667 collateral")
    print(f"  Current wallet: $535")
    print(f"  Can run: ~4 assets at $200, or 5 assets at $160")


if __name__ == '__main__':
    main()
