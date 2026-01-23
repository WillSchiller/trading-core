Hypothesis 

Goal: Test whether short-term on-chain price dislocations are frequent, durable enough to act on, and monetizable after real costs.

Core assumptions to test

A) Dislocations exist (frequency)
Material price gaps occur regularly between:

* CEX (e.g., Binance) and Uniswap v3, and
* Uniswap v3 and other DEX venues (v2/v4/Curve/Aerodrome).

Primary drivers assumed to be:

* large flow shocks,
* uneven liquidity,
* block/MEV effects,
* venue microstructure differences.

B) Dislocations persist (durability)
A meaningful subset of gaps lasts multiple blocks or several seconds, long enough for our system to:

1. detect the gap,
2. estimate slippage + gas,
3. submit and land a transaction.

C) Dislocations are monetizable (economics)

1. No HFT requirement
We do not need co-location or sub-millisecond latency. Fast RPC + clean software should be sufficient for seconds-scale opportunities.
2. Edge > costs
For trades we act on, expected profit must exceed:
* AMM slippage,
* pool fees,
* gas,
* reverts, and
* adverse continuation risk.

What we mean by “material gap”

A gap is material if:

|Uniswap v3 price − CEX price| ≥ configurable threshold (bps)
AND
duration ≥ configurable window (blocks/seconds)
AND
v3 depth around current tick ≥ minimum liquidity threshold

Thresholds are per pair + per chain.

Success criteria (what proves the hypothesis)

Using live data (then paper trades, then small real trades):

We validate the hypothesis if we can show:

* Gaps above threshold occur regularly,
* A stable subset persists long enough to act,
* After modeled costs, a subset shows positive expected value,
* Live results match modeled direction (not just backtests).

Out of scope (for now)

* Cross-exchange custody arbitrage
* Sub-block / HFT strategies
* v4 as primary price venue
* Complex ML prediction



System overview (prompt-friendly)

The system is a single docker-compose deployment (monolith) consisting of:

* one Node.js (TypeScript) application
* one Postgres container with a persistent volume
* Grafana connected to Postgres for dashboards



1) Data collection (in-process)

A Node.js TypeScript app continuously collects real-time pricing from selected CEX + DEX venues. Quotes are kept in memory as “latest state” and periodically persisted to Postgres (raw + rollups).

CEX venues (reference anchors)

* Binance (primary anchor)
* Coinbase Exchange (independent anchor)
* Bybit (derivatives-heavy; often leads)
* OKX (redundancy)
* Kraken (optional redundancy)

DEX venues
Mainnet:

* Uniswap v3
* Curve (stables + stETH/wstETH)
* Balancer v2 (selected pairs only)

Base:

* Uniswap v3
* Aerodrome

In-memory state
Maintain latest quote per:

* venue x pair (and chain for DEX)
Include: timestamp, price (mid), bid/ask (if CEX), block number (if DEX), confidence/latency metadata.

Persistence (Postgres)
Store:

* quote rollups (e.g., 1s/10s/1m)
* detected opportunities (events)
* trades / execution logs
Raw high-frequency quotes may be sampled or batched to avoid DB bloat.

2) Trade opportunity detection (in-process module)

Consumes the in-memory latest prices and computes dislocations:

* Primary spread: Uniswap v3 vs CEX anchor (Binance; confirm with Coinbase/Bybit)
* Secondary classifiers: Curve/Aerodrome/Balancer (context only)

Outputs “opportunity events” with:

* pair, chain, direction (buy_v3 / sell_v3)
* spread (bps), duration, volatility regime (optional)
* estimated slippage, fees, gas, profit-after-costs
* reason codes (e.g., “v3_vs_cex_gap”, “depth_ok”, “gas_ok”)

3) Trade execution (in-process module)

When an opportunity passes filters:

* run final quote/impact checks (Uniswap quoter / on-chain simulation)
* enforce risk limits (max size, cooldown, max gas, max slippage, max open exposure)
* submit transaction (swap on v3; optional routing later)
* record outcome to Postgres (success/fail/revert, realized costs, timestamps)

Notes:

* For MVP, execution can be “paper mode” (log-only) and then switched to live with a signer once signals look real.

4) Grafana dashboard

Grafana queries Postgres to display:

* CEX vs DEX price overlays
* spread (bps) over time
* opportunity count and distribution
* execution outcomes (fill rate, revert rate, avg gas, realized PnL proxy)
* top pairs/venues by dislocation frequency and EV

Deployment topology (AWS)

The system is deployed as a single EC2 instance running a docker-compose stack:

EC2 (AWS)
│
├─ Node app   → trading logic, data collection, signals, and execution (monolith)
├─ Postgres   → persistent database using an EBS-backed volume
└─ Grafana    → dashboards exposed on port 3000, connected directly to Postgres

All components are colocated on the same host for low latency and operational simplicity during the MVP phase.

Execution details (engineering-oriented, LLM-friendly)

What “execution” means in this MVP

* We do NOT trade on CEX in MVP. CEX is price reference only.
* We execute trades on DEX (primarily Uniswap v3) when the on-chain price deviates from CEX anchors.
* Therefore “execution details” mainly means:
  1. which external APIs we consume (CEX + chain/RPC),
  2. which on-chain contracts we call (Uniswap router/quoter),
  3. what data we must fetch to decide + submit.

---

External APIs we need (inputs)

CEX market data (WebSocket preferred)

We only need real-time order book / best bid-ask / trades for selected pairs.

Binance

* WS: best bid/ask or bookTicker for symbols
* Optional REST: exchange info / symbol list, ping/time
* Output: {ts, venue:"binance", pair, bid, ask, mid}

Coinbase Exchange

* WS: level1/ticker (best bid/ask)
* Optional REST: products list
* Output same schema

Bybit

* WS: ticker / best bid-ask
* Output same schema

OKX

* WS: tickers / best bid-ask
* Output same schema

Kraken (optional)

* WS: ticker
* Output same schema

Implementation notes:

* Prefer WS streaming; use REST only for bootstrap (symbol metadata).
* Normalize all CEX pairs into a consistent internal pair string (e.g., ETH/USDC).
* Track WS reconnects, sequence/latency, and staleness (drop quotes older than N ms).

---

Chain access (RPC / WebSocket)

We need low-latency chain reads for Base + Mainnet.

RPC provider

* HTTPS RPC for reads + tx send (Alchemy/Infura/QuickNode/etc.)
* Optional WS RPC for new blocks / logs subscription

Data needed per chain:

* latest block number + timestamp
* gas price / EIP-1559 fee estimates
* ability to call contracts (eth_call)
* ability to send raw tx (eth_sendRawTransaction)

---

On-chain contracts we call (execution path)

Uniswap v3 (primary)

We need:

1. Pool state reads (for pricing/validation)
* slot0() (sqrtPriceX96, tick, etc.)
* liquidity()
* tick data (optional, if doing depth modeling)
1. Quoting
* Use Uniswap v3 Quoter/QuoterV2 via eth_call to estimate:
  * expected output for a proposed swap
  * price impact / slippage estimate
1. Swap execution
* Use Uniswap v3 SwapRouter (or Universal Router if chosen) to submit swaps.
* Always set:
  * amountOutMinimum based on max slippage
  * deadline
* Persist tx hash + receipt + realized gas used.

Curve / Aerodrome / Balancer (secondary, optional in MVP)

* MVP: treat as additional price venues (reads/quotes only), not necessarily execution targets.
* Add execution later if a venue is clearly profitable.

---

Output artifacts we must log/persist (so we can evaluate profitability)

For each opportunity + attempt:

* reference prices (Binance + Coinbase + Bybit) at decision time
* v3 price and pool identifiers (chain, pool address, fee tier)
* computed spread (bps)
* gas estimate + assumed fees
* quoter output (expected amount out, implied slippage)
* decision: trade/skip + reason codes
* tx hash (if sent), receipt status, realized gas

Store minimally in Postgres (tables or JSONB fields ok).

---

Minimal “what the engineer needs to implement”

1. CEX WS connectors for the listed venues (bid/ask → normalized Quote)
2. On-chain reader for Uniswap v3 pool price (slot0)
3. Quoter call to estimate swap output before sending
4. SwapRouter tx builder + signer + send (paper mode first, then live)
5. Structured logging + Postgres persistence for evaluation

---

Notes / scope constraints (MVP)

* No mempool simulation.
* No CEX trading/execution.
* No private orderflow or MEV relay integration (later).
* Keep pool/pair list small and explicit (config-driven).