# Latency Analysis: PM Copy Trading Hot Path

Current metrics: p50=139ms, p95=658ms, avg=196ms (filled trades only).

## 1. Hot Path Execution Flow

Signal receipt to order submission, traced through the code:

```
RTDS WS message received
  |
  +-- [1] serde_json::from_value (parse ActivityTrade)     ~0.01ms
  +-- [2] cache_market_meta: lock market_cache Mutex        ~0.01ms (uncontended)
  +-- [3] parse_activity_item (dedup, build TradeSignal)    ~0.01ms
  +-- [4] trader_db.score_for (AHashMap lookup)             ~0.001ms
  |
  === process_buy begins ===
  |
  +-- [5] market_cache.lock() to read meta                  ~0.01ms
  +-- [6] scorer.lock() + score_all_json:
  |       - build_all_features (regex for slug date)        ~0.05ms
  |       - ONNX inference x3 (v2, v3, v4)                 ~0.3-1.0ms each
  |       - calibration + kelly calc                        ~0.01ms
  |       - serde_json::to_string (scores)                 ~0.01ms
  |       Total under lock:                                 ~1-3ms
  +-- [7] positions.lock() (3 reads)                        ~0.01ms
  +-- [8] fill_db.get_daily_pnl() — POSTGRES QUERY          ~5-50ms (!!!)
  +-- [9] risk.lock() + can_trade + record_order            ~0.01ms
  |
  === tokio::spawn — order execution ===
  |
  +-- [10] market_order().build() (EIP-712 struct)          ~0.5ms
  +-- [11] sign() (secp256k1 signing)                      ~0.1ms
  +-- [12] post_order() — HTTP POST to CLOB                ~60-300ms (!!!)
  |       ^^^ This is EU→US round trip
  +-- [13] If FAK fails → build GTC order                  ~0.5ms
  +-- [14] sign() again                                    ~0.1ms
  +-- [15] post_order() again — 2nd HTTP POST              ~60-300ms (!!!)
  |
  === Post-fill (not in latency measurement but blocks resources) ===
  |
  +-- [16] insert_fill() — POSTGRES INSERT                  ~5-20ms
  +-- [17] positions.lock().track_buy()                     ~0.01ms
```

## 2. Bottleneck Analysis

### Bottleneck 1: EU→US Network Latency (60-300ms per round trip)

Server is in eu-west-1 (Ireland). Polymarket CLOB is hosted in the US (likely us-east-1 or NYC area). Minimum physics-limited RTT for Ireland→US East Coast is ~70ms. With TLS handshake reuse (HTTP keep-alive via reqwest), each POST is ~70-100ms best case, 200-300ms worst case.

The FAK+GTC fallback path does TWO sequential round trips: 140-600ms just in network I/O.

The latency_ms timer starts at `t0` in the spawned task (step 10) and ends after `execute_copy` returns (after step 12 or 15). So the reported p50=139ms / p95=658ms is almost entirely network latency to the CLOB.

### Bottleneck 2: get_daily_pnl() — Postgres Query in Hot Path (5-50ms)

`get_daily_pnl()` runs a `SUM(real_pnl)` query against `pm_rust_trades` on every buy signal BEFORE the order is submitted. This query hits the same Postgres in eu-west-1, so latency is low (~5ms), but it's unnecessary blocking time. This runs BEFORE the tokio::spawn, so it delays the order submission start.

### Bottleneck 3: Scorer Mutex Held During All 3 ONNX Inferences (1-3ms)

The `scorer.lock().await` is held while running `score_all_json`, which runs inference on ALL 3 models (v2, v3, v4) sequentially. Only the primary model (v4) result is used for the trade decision. The other two model scores are logged to `ml_scores_json` for offline analysis.

If two tracked-trader signals arrive within ~3ms of each other, the second one blocks on the scorer mutex.

### Bottleneck 4: Market Cache Lock Contention

`cache_market_meta` takes a lock on `market_cache` for EVERY RTDS activity message, not just tracked traders. RTDS activity feed is high throughput (all trades on Polymarket). The lock is brief (HashMap insert), but it's a `tokio::Mutex` so it yields to the executor, adding scheduling overhead on every message.

### Bottleneck 5: Sequential FAK→GTC (2x Round Trips)

When FAK doesn't match, the code falls through to build + sign + post a GTC order. This doubles the network latency. The GTC price is trader_price + 5 cents, which is a fixed spread.

### Bottleneck 6: Regex Compilation in Feature Building

`extract_hours_from_slug` compiles a new `Regex::new(r"(\d{4}-\d{2}-\d{2})")` on every call. This is inside the scorer lock. Regex compilation is ~1-5 microseconds but it's wasteful.

## 3. ONNX Inference Deep Dive

Models are small binary classifiers (~26-29 features, likely gradient-boosted trees exported to ONNX). With `GraphOptimizationLevel::Level3` and a 29-feature input, single inference should take:

- Tree ensemble (LightGBM/XGBoost): 0.05-0.5ms per model
- Small neural net: 0.1-1.0ms per model

Running 3 models sequentially: 0.15-3.0ms total.

**Should we skip non-primary models?** Yes. The v2 and v3 scores are only written to `ml_scores_json` for offline analysis. They don't affect the trade decision. Running them adds latency and holds the mutex longer.

**Recommendation**: Run only the primary model (v4) in the hot path. Log the signal features to DB so v2/v3 scores can be computed offline in batch.

## 4. Competitor Latency Advantage

Other PM copy traders running on US-based servers (us-east-1 or NYC colocation):
- CLOB RTT: 1-10ms vs our 70-100ms
- Advantage: 60-90ms per order, 120-180ms for FAK+GTC
- At p50=139ms, our entire latency is roughly equal to their network advantage

This means a US-based competitor can see the same RTDS signal and place their order before ours even reaches the CLOB server.

## 5. Optimization Recommendations (Prioritized)

### P0: Move to US Server (Expected: -120ms on average, -400ms on p95)

Move the pm-copy-hotpath binary to a US-east server, ideally the same region as the CLOB. This alone would drop p50 from ~139ms to ~30-50ms. FAK+GTC p95 would drop from 658ms to ~200ms.

Options:
- Small EC2 in us-east-1 running just the hotpath binary
- Keep Postgres + Grafana in eu-west-1, connect over VPC peering or public internet (only post-fill writes, not latency-sensitive)
- Or run a lightweight SQLite locally and sync to Postgres async

**Impact**: Single biggest improvement. Everything else is micro-optimization by comparison.

### P1: Cache daily PnL Instead of Querying Per-Signal (Expected: -5 to -50ms)

Replace `fill_db.get_daily_pnl().await` with a cached value that updates periodically (every 30s or on each fill). The daily PnL changes only when trades resolve — polling it on every buy signal is wasteful.

```rust
// In FeedCtx or RiskManager:
daily_pnl: Arc<AtomicF64>,  // or Arc<Mutex<f64>> updated by resolver
```

### P2: Skip Non-Primary Models in Hot Path (Expected: -0.5 to -2ms, reduces mutex contention)

Only run the primary model (v4) during the hot path. Save the raw features to DB so v2/v3 scores can be computed in batch offline.

```rust
pub fn score_primary_only(&mut self, signal: &TradeSignal, ...) -> (ScoreResult, AHashMap<String, f32>) {
    // build features, run only self.models[self.primary_model], return features for logging
}
```

### P3: Skip FAK, Go Straight to GTC (Expected: -70 to -150ms when FAK misses)

FAK (Fill and Kill) is a market order that fills at best available price or cancels. When it fails, you've wasted a round trip. Consider:

Option A: Always use GTC at trader_price + spread. One round trip, guaranteed posting.
Option B: Fire FAK and GTC in parallel (two concurrent POSTs). Cancel the GTC if FAK fills. But this risks double-filling.
Option C: Use FOK (Fill or Kill) if the CLOB supports it — semantically cleaner than FAK for this use case.

The right choice depends on FAK fill rate. If FAK fills >80% of the time, keep it. If <50%, switch to GTC-only.

### P4: Replace Market Cache Mutex with DashMap or RwLock (Expected: reduces tail latency)

`MarketCache` is `Arc<Mutex<AHashMap>>`. Every RTDS message takes a write lock even if the entry already exists. Options:

- Use `dashmap::DashMap` for lock-free concurrent reads/writes
- Use `tokio::sync::RwLock` — most messages will only read (entry already cached), only new markets need writes
- Filter non-tracked-trader messages BEFORE the cache lock (check trader_db first)

### P5: Compile Regex Once (Expected: negligible, ~5us saved)

Use `lazy_static!` or `std::sync::LazyLock` for the date regex in `extract_hours_from_slug`.

```rust
static DATE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{4}-\d{2}-\d{2})").unwrap());
```

### P6: Use RwLock for Scorer (Expected: reduces contention for concurrent signals)

Scorer uses `&mut self` because of `market_counts` mutation. If `market_counts` were moved to a separate `AtomicUsize` map or `DashMap`, the scorer could take `&self` and use `RwLock` or no lock at all (ONNX Session::run takes `&self`).

### P7: Pre-sign Orders (Not Feasible)

EIP-712 signatures include nonce and expiration, so orders can't be pre-signed. The signing itself (~0.1ms) is negligible anyway.

## 6. Summary: Where the Time Goes

For a filled FAK trade (p50 = 139ms):

| Step | Time (ms) | % of Total |
|------|-----------|------------|
| Parse + dedup + trader lookup | <0.1 | <0.1% |
| Market cache read | <0.1 | <0.1% |
| Scorer (3 models) | 1-3 | 1-2% |
| Position tracker read | <0.1 | <0.1% |
| Daily PnL query (Postgres) | 5-50 | 4-36% |
| Risk check | <0.1 | <0.1% |
| Build order + sign | ~0.6 | 0.4% |
| **POST to CLOB (EU→US)** | **70-100** | **50-72%** |
| **2nd POST (GTC fallback)** | **70-100** | **only on FAK miss** |

The dominant cost is network latency to the CLOB. Everything else combined is <55ms.

## 7. Quick Wins vs Strategic Moves

**Quick wins** (code changes only, deployable today):
1. Cache daily PnL (P1) — 15 min of work, saves 5-50ms
2. Primary model only (P2) — 30 min, saves 0.5-2ms + reduces contention
3. Static regex (P5) — 2 min
4. DashMap for market cache (P4) — 20 min

**Strategic** (infrastructure change):
1. US server for hotpath (P0) — biggest single improvement, saves 120ms+ average
2. Evaluate FAK fill rate to decide FAK-vs-GTC strategy (P3) — needs data analysis first
