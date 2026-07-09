# trading-core

A solo-built research and execution platform for crypto market microstructure strategies, run with real capital at deliberately small size. TypeScript monolith for venue connectivity and orchestration, Rust services on the latency-sensitive paths, Postgres + Grafana for state and observability, Terraform + GitHub Actions → ECR → SSM for deploys.

**Honest headline: exchange-verified all-in PnL was ≈ –$200 over nine months** (Polymarket: $269 deposited → $95 residual value per the public trade tape; Hyperliquid perps: –$29). Every strategy below was run as a falsifiable hypothesis against instrumented live or paper execution, and killed (or capped) when the data said so. The durable outputs are the infrastructure, a 13.7M-trade dataset, and a cleanly measured adverse-selection result that explains *why* the naive version of copy-trading cannot work.

## Architecture

```
                ┌─────────────────────────────────────────────┐
                │              EC2 (docker-compose)           │
                │                                             │
  Binance ──WS──►                                             │
  Coinbase──WS──►  trader-app (TypeScript, ~30k LOC)          │
  Bybit  ───WS──►   collectors → state → detection → exec ────┼──► Base L2
  Base RPC──────►                                             │   (Uniswap v3,
                │                                             │    Aerodrome)
  Hyperliquid ──►  hl-pca-hotpath (Rust/tokio)                │
   allMids WS   │   ws_feed → online PCA → regime → signals ──┼──► Hyperliquid
                │                                             │
  Polymarket ───►  pm-copy-hotpath (Rust/tokio)               │
   RTDS feed    │   listener → ONNX scorer → risk → orders ───┼──► Polymarket CLOB
                │        │                                    │
                │        ▼                                    │
                │   Postgres (45 tables) ◄── Grafana (11 dashboards)
                └─────────────────────────────────────────────┘
```

## Strategy generations and results

All figures are from the production database as of July 2026. Position sizes were intentionally small ($2–$200); the goal was statistically honest measurement, not income.

### 1. CEX/DEX dislocation (Jan–Feb 2026) — retired

Hypothesis: price gaps between CEXs and Base DEXs (Uniswap v3, Aerodrome) persist long enough to monetize after gas, slippage, and fees.

Built: WebSocket collectors for three CEXs, `slot0`/sqrtPriceX96 readers per block, QuoterV2 integration, spread detection with staleness and depth filters, paper execution with full cost modeling.

Result: post-cost spreads at retail latency on Base were too rare and too thin. Retired without live capital.

### 2. PCA statistical arbitrage on Hyperliquid perps (Feb–May 2026) — retired

Hypothesis: residual z-scores from an online PCA factor model over ~40 perps mean-revert; filtered entries (counter-trend PC1, negative funding, EWMA vol gate) have positive expectancy.

Built: Rust hot path with online PCA, regime detection, live execution with kill switches ($50 daily / $200 total / 5 consecutive losses — they fired), and parallel paper runs for every config change.

Result: **11 runs, none profitable.** Live: –$28.74 over 284 closed trades across 5 configs. Paper configs ranged –$3 to –$155. Fees + funding exceeded the residual edge at every tested configuration. Killed on evidence.

### 3. ML-gated copy-trading on Polymarket (Mar–Jul 2026) — capped at control size

Hypothesis: a small set of Polymarket sports traders have persistent skill; copying their entries, gated by an ML model, is +EV.

Built: shadow-tracking pipeline (13.7M observed trades), trader-eligibility filters validated on a 769-trader train/test split, gradient-boosted models exported to ONNX and scored in-process in Rust (p99 signal→order **189ms**), per-trader circuit breakers, live execution.

Result — the most instructive in the repo:

| Fill outcome (first live era) | n | Win rate | Resolution-basis PnL |
|---|---|---|---|
| Orders that did **not** fill | 91 | **80.2%** | +$200 hypothetical |
| Orders that **filled** | 94 | **36.2%** | **–$680** |

Hypothetical paper profit became a real loss — the whole campaign's exchange-verified drawdown was ≈ –$175 (the system's own resolution-basis accounting recorded –$680; reconciling against the exchange tape during the postmortem showed early exits had recovered much of it — see lesson 5). The win-rate asymmetry is textbook **adverse selection**: fills concentrate precisely in the trades where the copied signal is stale or wrong — the same mechanism that governs JIT liquidity provision and quote-sniping in AMMs. The Rust rebuild with tighter price-band and ML gating brought the final live iteration to +$135 over 179 orders (51.5% win rate) — positive but small, with capacity capped by sports-market depth. Moved to a dry-run control mode; not worth scaling.

## Engineering highlights

- **Rust hot paths** (`hl-pca-hotpath/`, `pm-copy-hotpath/`): tokio async, WebSocket feeds with reconnection/heartbeat handling, in-process ONNX inference, criterion benchmarks, per-trade latency instrumentation (`LATENCY_ANALYSIS.md`).
- **On-chain execution** (`src/execution/`, `src/chain/`): sqrtPriceX96 math, token-ordering handling, EIP-1559 gas estimation with buffers, local nonce management, simulate-before-submit.
- **Data discipline**: prices as `NUMERIC` end-to-end (never floats), dedup unique indexes, quote-staleness rules (CEX >3s dropped, DEX >2 blocks dropped), no-lookahead separation between backfilled training data and forward-test PnL.
- **Risk controls that actually fired**: kill switches, per-trader circuit breakers, exposure caps — all with event tables (`perps_kill_switch_events`, `pm_kill_switch_events`) so every halt is auditable.
- **Observability**: 11 provisioned Grafana dashboards over Postgres; every strategy decision (including skips and rejections) is persisted with its reason.

## Repository map

```
src/                  TypeScript monolith: collectors, detection, execution, persistence
hl-pca-hotpath/       Rust: online PCA stat-arb engine for Hyperliquid
pm-copy-hotpath/      Rust: Polymarket copy-trading engine (ONNX scoring, risk, fills)
research/             Model training (Python), exported ONNX models
grafana/              Provisioned dashboards
infra/                Terraform: EC2, ECR, CloudWatch, Secrets Manager
sql/                  Migrations (45-table schema)
docs/                 Specs, deployment runbooks, dated worklog
scripts/              Deploy, migrate, backfill, analysis
```

**`docs/POSTMORTEM.md` is the full six-month postmortem** — timeline, incident log, per-strategy verdicts, and lessons. `docs/WORKLOG.md` is the unedited development diary. `CLAUDE.md` configures the AI-assisted workflow used throughout.

## Running it

```bash
npm install
docker-compose up -d        # Postgres + Grafana
npm run db:migrate && npm run db:seed
npm run dev                 # paper mode by default (PAPER_MODE=true)
```

Rust services build with `cargo build --release` in their respective directories; each has a `*.toml.example` config.

## Lessons

1. **Paper PnL without a fill model is fiction.** Measure fill-conditional outcomes before believing any edge.
2. **Fees and funding are the strategy.** Perps edges below ~10bps/trade don't survive Hyperliquid's cost structure at taker.
3. **Kill switches must be pre-committed and automatic.** Every discretionary override in this repo's history was a mistake.
4. **Instrument skips, not just trades.** The 9,699 ML-rejected signals were as informative as the 179 executed ones.
5. **The exchange is the only source of truth for PnL.** This system's internal `real_pnl` accounting overstated losses ~3.5× (resolution-basis booking on positions that were actually exited early). The headline numbers here come from reconciling the exchange's public trade tape; the discrepancy itself is documented in the postmortem.
