# Postmortem: trading-core, January–July 2026

Six months of building and operating a solo crypto trading system, reconstructed from 488 commits, the development worklog, kill-switch event tables, and the production database. Written July 2026.

**Headline numbers:** six strategy investigations, three taken to live capital, exchange-verified all-in PnL ≈ **–$200** (Polymarket ≈ –$175 mark-to-market per the public trade tape; Hyperliquid –$29), one durable research finding (measured adverse selection in copy-trading fills), 13.7M-trade dataset collected, zero blowups — every loss was bounded by a pre-committed limit. Note: the system's own `real_pnl` accounting said –$506; reconciling against the exchange during this postmortem exposed that as ~2.5× overstated — see incident 11.

## Summary of investigations

| # | Strategy | Period | Live capital? | Outcome | Verdict |
|---|----------|--------|--------------|---------|---------|
| 1 | CEX/DEX dislocation (Base) | Jan 19 – Feb 6 | No (paper) | Post-cost spreads too rare/thin at retail latency; mainnet needs $2k+ size to clear gas | Retired |
| 2 | PCA stat-arb, Hyperliquid perps | Feb 2 – Apr 8 | Yes | –$28.74 live over 284 trades; 11 configs, none profitable | Retired |
| 3 | Funding arb (spot vs perp) | Mar 12 – 23 | Yes (tiny) | 309k scans, 8 positions, ≈ –$0.40; break-even hold times too long | Retired |
| 4 | HL market-maker (paper) | Mar 23 – 30 | No | 1,510 paper fills; +4.1bps edge vs –2.7bps adverse selection = +1.5bps net, below fees | Retired |
| 5 | Polymarket copy-trading | Mar 13 – Apr 8 | Yes | Whole campaign exchange-verified: **≈ –$175** ($269 in → $95 residual). Rust rebuild era positive per system accounting (+$135/179 orders). Adverse-selection finding | Control mode |
| 6 | Polymarket market-maker | designed, never run | No | Superseded by control-mode decision | Shelved |

## Timeline

### January: the dislocation build (Phases 0–5 in ten days)

Work began ~Jan 19 (first commit Jan 23). In roughly ten days: three CEX WebSocket connectors with reconnection and staleness rules, Uniswap v3 slot0 readers, a detection loop holding a <50ms cycle target, Grafana provisioning, Terraform infra, CI/CD to EC2 via SSM. Deployed to ap-southeast-1 on Jan 25.

The economics were visible within a week of paper data (Jan 28): a representative 17.4bps mainnet spread reversed to –3.8bps within one detection-to-validation cycle (~850ms); Base spreads of 5–6bps yielded ~$0.03 gross against a $0.50 minimum profit floor. Mainnet gas of $2–5 per round trip meant break-even required $2,000+ clips — outside risk limits. The strategy was never taken live.

### February: Hyperliquid perps, and a same-day kill switch

Feb 2 was the pivot day: the planned Binance execution path died (UK regulatory block on API trading), and a Hyperliquid execution adapter was built and taken live the same day. The kill switch (5 consecutive losses) fired **that evening** — –$2.50 over 9 trades. The next ten days were a fee-structure education: re-enabled conservatively Feb 8, `hl_live_500` at $100/position Feb 10, repeated kill-switch trips Feb 12–13 (one paper config lost $106 in a day), live disabled Feb 13.

### March: signal research, three side-quests, and the real pivot

Weeks of systematic signal work on the perps model: PC1/residual PnL decomposition, counter-trend gates, funding-rate gates, EWMA vol thresholds, hold-time tightening (2h→1h), all tracked as numbered issues. `hl_live_filtered` went live Mar 11 with the full gate stack — and the kill switch fired Mar 12. That was effectively the end of the perps hypothesis, though it ran in paper until April.

Three parallel experiments ran in March: funding arb (309k scans produced only 8 economically viable entries), a paper HL market-maker (net edge +1.5bps after adverse selection — real but below fees), and — the one that mattered — **Polymarket copy-trading shadow tracking, started Mar 13**. Infra migrated ap-southeast-1 → eu-west-1 on Mar 23 (a re-provision that left a duplicate instance running idle for a month — see incident log).

### March 20 – April 8: copy-trading live, the adverse-selection lesson

The Node-based copy trader went live Mar 20 with ML-gated entries. Shadow/paper metrics looked strong. Real results did not match:

| Fill outcome (node era) | n | Win rate | Resolution-basis PnL |
|---|-----|---------|-----|
| Orders that did not fill | 91 | 80.2% | +$200 hypothetical |
| Orders that filled | 94 | 36.2% | **–$680** |

Hypothetical paper profit (+$646) became a real loss. The dollar figures above are the system's resolution-basis accounting; the exchange-verified drawdown for the whole campaign was ≈ –$175, because early exits recovered much of the booked loss (incident 11). The win-rate asymmetry is the durable result. The mechanism is adverse selection: in a copy-trading race, your limit order fills when the market has already moved through it — i.e., disproportionately when the copied trade is stale or wrong. The winners you "would have had" are exactly the ones you never get.

The response was a ground-up Rust rebuild (`pm-copy-hotpath`, first trades Mar 29): in-process ONNX scoring, per-step latency instrumentation (p99 signal→order 189ms after connection-warming and round-trip elimination), tighter price bands, and progressively better models (v5 → v6 Kelly-sized → v7 split binary/multi, Apr 6). The v6 era was positive per system accounting: **+$135.49 over 179 real orders (51.5% win rate)** — but ~$0.76/order against sports-market depth is not a business.

**Apr 8: full stop.** Live trading ended deliberately — flat $2 dry-run "control mode" to keep collecting unbiased data, gates lowered on the perps signal collector for the same purpose, a memory leak fixed on the way out. The last strategy commit is dated Apr 8; the server was stopped May 6.

## Incident log (engineering honesty section)

1. **Public RPC can't serve slot0** (Jan 19) — "invalid opcode" on contract calls; lost a day before moving to a paid provider.
2. **DEX quotes stamped with system time, not block time** (fixed Jan 26) — the time-alignment filter validated against the wrong clock until an audit caught it. Silent correctness bug in the core of a timing-sensitive system.
3. **"No data" dashboards during quiet markets** (Jan 26) — adaptive polling backed off by design; the display made a healthy system look dead.
4. **Config volume-mount race → production crash-loop** (Jan 28) — new image + stale host config. Fix: bake config into the image; config changes now require a deploy, which is a feature.
5. **Live Telegram bot token pasted into the committed worklog** (Jan 28; found Jul 9) — committed in plaintext despite the repo's own rules. Scrubbed from HEAD, token rotated. Also: the Grafana admin password was hardcoded in `deploy.sh` for months. Lesson: secret scanners (this repo now uses gitleaks) miss context-dependent leaks; grep for your own secret-injection patterns too.
6. **Secrets pipeline accepted placeholders as values** (Feb 2) — `{}` from Terraform defaults passed validation; exchange keys were silently empty in production.
7. **Kill-switch event spam** — no dedup on trigger events; single halts logged up to 9×, polluting the audit trail.
8. **Orphaned positions on maker timeout** — the executor cancelled the order record without checking whether Hyperliquid had partially filled it.
9. **Upstream API dependency broke the resolver** (Apr 1) — Polymarket's Gamma API failure orphaned unresolved positions until an auto-sell path via the data API was built.
10. **Ops debt discovered on revival** (Jul 9) — no database backups had ever existed (first EBS snapshot taken Jul 9); the Mar 23 migration left a blank duplicate instance running for a month with the elastic IP attached to the wrong box; the security group had drifted open.
11. **Internal PnL accounting diverged ~2.5× from the exchange** (found Jul 9, writing this document) — the `real_pnl` column booked filled positions at resolution prices even when they had actually been sold early, compounding to a reported –$506 against an exchange-tape-verified ≈ –$200. Found only by reconstructing cash flows from the exchange's public activity feed (855 events: $2,600 bought, $1,445 sold, $886 redeemed, $0 cash remaining, $95 open). The deposits ledger was also incomplete ($101 recorded vs $269 implied). Rule reaffirmed the hard way: the exchange is the only source of truth.

## Costs

- Real trading PnL, exchange-verified: ≈ **–$200** (Polymarket campaign ≈ –$175 mark-to-market: $269 deposited, $95 residual; Hyperliquid perps –$29; funding arb ≈ $0)
- Infrastructure: ~$50/month (t3.medium, EBS, ECR)
- The dataset and findings this bought: 13.7M observed Polymarket trades, 45-table instrumented history of every decision including skips, and a measured answer to *why naive copy-trading loses*.

## Lessons

**Quant**
1. Paper PnL without a fill model is fiction. Fill-conditional analysis (would-have-won vs did-win) is the first table to build, not the last.
2. Fees and funding are the strategy. No residual edge tested here survived Hyperliquid taker costs; the MM experiment's honest +1.5bps net was still below fees.
3. Capacity analysis belongs *before* the build. Sports-market depth capped the one positive strategy at pocket money; an hour of arithmetic would have predicted that.
4. Pre-committed automatic kill switches work. They fired ~40 times across the project; every live loss stayed bounded.
5. Keep a control run when you stop. Flat-size dry-run data keeps the measurement honest for free.

**Engineering**
6. Timestamps are the product. Two of the worst bugs were clock bugs (system vs block time; server time round-trips costing 80ms/order).
7. Validate secrets at the pipeline boundary; placeholder values must fail loudly.
8. Bake config into artifacts. Mutable host config + immutable images = crash-loops.
9. Instrument skips with reasons. The 9,699 ML-rejected signals were as informative as the 179 executed ones.

**Operational**
10. Backups before you need them — this project ran six months of irreplaceable data collection with none.
11. Write the worklog *especially* when moving fast: the disciplined January diary made that month trivially reconstructable; February–April required archaeology across commits and database tables.

## If starting again

Start from the fill: model P(fill | subsequent price move) on day one, because every taker strategy here ultimately died on execution, not signal. Do the capacity arithmetic before writing code. Put the hot path in Rust from the start. And run one experiment at a time — six parallel table families made every pivot cheaper than it should have been to attempt, and the portfolio of shallow experiments cost more than one deep one would have.
