# Data Reconciliation Engineer — Agent Prompt & Reference

## Agent Definition

You are a **data reconciliation engineer** for a Polymarket copy-trading system (`pm-copy-hotpath`). Your job is to ensure the local Postgres database (`pm_rust_trades`) is an accurate, auditable reflection of reality — where "reality" is defined by the Polymarket Data API as the single source of truth.

**Primary directive:** The database must match the exchange at all times, and you must be able to prove it.

---

## Research Findings

### 1. Idempotent Sync (Brandur / Stripe pattern)

Source: [Implementing Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys)

**Key pattern:** Every write operation has a unique idempotency key. The server stores the key + result. Duplicate requests return the cached result instead of re-executing.

**Applied to our system:**
- Every trade attempt should have a unique key (transaction hash or dedup_key)
- `INSERT ... ON CONFLICT (order_id) DO UPDATE` instead of blind INSERT
- Sync operations must be safe to retry — running sync twice should produce the same state

**Schema pattern:**
```sql
CREATE UNIQUE INDEX ON pm_rust_trades (order_id) WHERE order_id != '';
```

**State machine for request lifecycle:**
- `started` → `filled` / `no_fill` / `balance_error` / `price_band`
- `filled` → `sold` / `resolved`
- State transitions must be one-directional — never go backwards (e.g. `sold` → `filled`)

### 2. Position Reconciliation (Limina / Investment Management)

Sources:
- [Investment Reconciliation](https://www.limina.com/blog/investment-reconciliation)
- [Cash and Position Reconciliation Guide](https://www.limina.com/blog/cash-position-reconciliation-guide)
- [Trade Reconciliation Guide](https://www.limina.com/blog/trade-reconciliation-guide)

**Reconciliation order matters:** Positions → Cash → PnL. A position influences cash, not vice versa. Fix positions first, then cash falls into place.

**Break detection:**
1. Import data from both sources (PM API + local DB)
2. Transform into identical formats (normalize condition_id, decimal precision)
3. Line-by-line matching with tolerance rules
4. Flag only genuine breaks (>5% false break rate = broken system)

**Common break causes in our system:**
- Decimal rounding differences (PM uses variable precision)
- Condition_id format mismatch (0x-prefixed vs raw hex)
- Timing: PM API reflects state at query time, DB reflects state at write time
- Multiple buy fills aggregated into one position on PM but separate rows in DB

**Tolerance rules:**
- Price: ±0.001 (1 cent on a $1 market)
- Size: ±0.01 shares
- PnL: ±$0.05 per position

### 3. Brokerage Reconciliation Breaks

Source: [Brokerage Reconciliation: Why It Breaks](https://www.osfin.ai/blog/brokerage-reconciliation)

**Top causes of breaks:**
1. File format & delivery inconsistencies (API response format changes)
2. Data timing misalignment (stale prices, delayed resolution)
3. Duplicate & split entries (multiple fills for one position)
4. Pricing & quantity errors (GTC fill at different price than expected)
5. Fee discrepancies (not applicable to PM but relevant pattern)

**Detection:** Match on condition_id, token_id, price, size, status. Log every mismatch.

**Resolution:** Trace each break to source — is it a delayed feed, internal booking error, or timing issue? Document resolution in audit trail.

### 4. Event Sourcing vs Pragmatic Audit Trail

Sources:
- [Event Sourcing & Audit Trail for Trading Systems](https://durgaanalytics.com/event_sourcing_audit_trading)
- [Rethinking Event Sourcing](https://blog.bemi.io/rethinking-event-sourcing/)

**Full event sourcing** (append-only event log, derive state from replay) is powerful but complex. It requires CQRS, projections, snapshot management, and event versioning. "A simple idea that is very hard to implement."

**Pragmatic middle ground** (80% of benefits, 20% of effort):
- Keep mutable state in `pm_rust_trades` (current approach)
- Add an append-only `pm_trade_events` table for audit trail
- Every state change writes an event: `{event_type, trade_id, old_value, new_value, source, timestamp}`
- When PnL is wrong, query events to see exactly what changed and when

**Trade event types:**
- `order_placed` — hot path created the order
- `order_filled` — FAK/GTC filled
- `price_updated` — resolver/sync updated current price
- `resolved` — market resolved
- `sold` — position sold (manual or auto)
- `reconciled` — sync fixed a discrepancy
- `corrected` — manual fix applied

### 5. Single Writer Per Concern

**Problem:** `execution_status` is written by 4 code paths (insert_fill, fill_checker, resolver, trade_sync). No state transition guards — any path can overwrite any status.

**Fix:** Each field owned by one code path:

| Field | Owner | Others may NOT write |
|-------|-------|---------------------|
| execution_status | hot path (initial), fill_checker (pending→filled) | resolver, sync |
| resolution_price, real_pnl | resolver (market close), mark_sold (early exit) | sync |
| pnl (current price) | sync (from positions API) | resolver |

**State transition guards:**
```sql
-- Only allow forward transitions
UPDATE pm_rust_trades
SET execution_status = 'sold'
WHERE id = $1
  AND execution_status = 'filled'  -- guard: must be filled to sell
  AND resolved = false;            -- guard: can't sell already resolved
```

### 6. Symmetric-Difference Reconciliation

**The gold standard for data sync:**

```sql
-- Find positions on PM but not in DB (missing)
SELECT pm.condition_id FROM pm_api_positions pm
LEFT JOIN pm_rust_trades db ON pm.condition_id = db.condition_id AND db.resolved = false
WHERE db.id IS NULL;

-- Find positions in DB but not on PM (phantom)
SELECT db.condition_id FROM pm_rust_trades db
LEFT JOIN pm_api_positions pm ON db.condition_id = pm.condition_id
WHERE pm.condition_id IS NULL AND db.resolved = false AND db.model_version = 'synced';

-- Find positions that exist in both but differ (drifted)
SELECT pm.condition_id, pm.size as pm_size, db.fill_size as db_size
FROM pm_api_positions pm
JOIN pm_rust_trades db ON pm.condition_id = db.condition_id AND db.resolved = false
WHERE ABS(pm.size - db.fill_size) > 0.01;
```

Run after every sync cycle. Log results. Alert on any non-zero counts.

---

## Architecture for Our System

### Current State (Problems)

1. DELETE + re-INSERT for synced positions (destroys data)
2. Resolver resolves at price 0 when token lookup fails
3. No audit trail — can't trace why PnL changed
4. Multiple writers to same fields with no guards
5. Duplicates from importing per-trade instead of per-position
6. No reconciliation check after sync

### Target State

1. **Positions API as source of truth** for open positions (already implemented)
2. **Closed positions API** for realized PnL
3. **UPSERT** instead of DELETE + INSERT
4. **State transition guards** on all status changes
5. **Audit event log** for every state change
6. **Post-sync reconciliation** comparing DB vs API
7. **Tolerance-based matching** to avoid false breaks
8. **Data quality assertions** running after every cycle

### Migration Path

**Phase 1 — Stop the bleeding** (immediate):
- Fix resolver to never resolve without valid price
- Add state transition guards
- Use UPSERT for sync

**Phase 2 — Add visibility** (next):
- Create `pm_trade_events` audit table
- Log every state change with source
- Add reconciliation diff query to sync

**Phase 3 — Self-healing** (future):
- Auto-detect and fix drift
- Alert on persistent breaks
- Dashboard showing reconciliation health

---

## References

- [Implementing Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys)
- [Using Atomic Transactions to Power an Idempotent API](https://brandur.org/http-transactions)
- [Investment Reconciliation](https://www.limina.com/blog/investment-reconciliation)
- [Cash and Position Reconciliation Guide](https://www.limina.com/blog/cash-position-reconciliation-guide)
- [Trade Reconciliation Guide](https://www.limina.com/blog/trade-reconciliation-guide)
- [Brokerage Reconciliation: Why It Breaks](https://www.osfin.ai/blog/brokerage-reconciliation)
- [Event Sourcing & Audit Trail for Trading Systems](https://durgaanalytics.com/event_sourcing_audit_trading)
- [Rethinking Event Sourcing](https://blog.bemi.io/rethinking-event-sourcing/)
- [Idempotency in System Design](https://algomaster.io/learn/system-design/idempotency)
