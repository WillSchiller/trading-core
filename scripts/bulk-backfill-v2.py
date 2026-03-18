#!/usr/bin/env python3
"""Bulk backfill v2 — uses ON CONFLICT DO NOTHING for speed."""
import json
import sys
import psycopg2
from pathlib import Path

DATA_DIR = Path("/tmp/pm_edge_study")
with open(DATA_DIR / "trader_histories.json") as f:
    histories = json.load(f)
with open(DATA_DIR / "slug_cache.json") as f:
    slug_cache = json.load(f)

conn_str = sys.argv[1] if len(sys.argv) > 1 else "postgresql://trader:trader@localhost:5432/dislocation_trader"
conn = psycopg2.connect(conn_str)
cur = conn.cursor()

# Ensure all traders exist
cur.execute("SELECT address FROM pm_tracked_traders")
existing = {r[0] for r in cur.fetchall()}
added = 0
for addr, trades in histories.items():
    if addr not in existing:
        name = next((t.get('name') or t.get('pseudonym') or '' for t in trades if t.get('name') or t.get('pseudonym')), addr[:10])
        cur.execute("INSERT INTO pm_tracked_traders (address, alias, pnl, volume, bankroll_estimate, rank, enabled, copy_eligible, backfilled_at) VALUES (%s, %s, 0, 0, 10000, 999, true, false, NOW()) ON CONFLICT (address) DO UPDATE SET backfilled_at = COALESCE(pm_tracked_traders.backfilled_at, NOW())", (addr, name))
        added += 1
conn.commit()
print(f"Traders: {added} added, {len(existing)} existed")

# Build all rows
BANKROLL = 500
MAX_POS = 100
rows = []
for addr, trades in histories.items():
    for t in trades:
        side = t.get('side', '')
        if side not in ('BUY', 'SELL'):
            continue
        slug = t.get('slug', '')
        cid = t.get('conditionId', '')
        token_id = t.get('asset', '')
        ts = t.get('timestamp', 0)
        if isinstance(ts, str):
            ts = int(float(ts))
        ts_ms = ts * 1000
        price = float(t.get('price', 0))
        size = float(t.get('size', 0))
        outcome = t.get('outcome', '')
        outcome_idx = t.get('outcomeIndex')
        name = t.get('name') or t.get('pseudonym') or addr[:10]

        if price <= 0 or size <= 0:
            continue

        our_size = min(size * (BANKROLL / 10000), MAX_POS) if side == 'BUY' else None
        our_entry = price if side == 'BUY' else None

        resolved = False
        resolution_price = None
        pnl = None
        market = slug_cache.get(slug)
        if market and market.get('closed') and outcome_idx is not None and side == 'BUY' and our_size:
            try:
                prices = [float(x) for x in json.loads(market.get('outcomePrices', '[]'))]
                if outcome_idx < len(prices):
                    resolution_price = prices[outcome_idx]
                    pnl = (resolution_price - price) * our_size
                    resolved = True
            except:
                pass

        current_price = resolution_price if resolved else price

        rows.append((
            addr, name[:100], cid, token_id, side, size, price, outcome[:100], slug[:200],
            '', False, our_size, our_entry, current_price, pnl,
            resolved, resolution_price, ts_ms
        ))

print(f"Total rows to insert: {len(rows):,}")

# Batch insert with ON CONFLICT
BATCH = 1000
inserted = 0
for i in range(0, len(rows), BATCH):
    batch = rows[i:i+BATCH]
    args = ','.join(cur.mogrify("(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", r).decode() for r in batch)
    cur.execute(f"""
        INSERT INTO pm_shadow_trades
        (trader_address, trader_alias, condition_id, token_id, side, size, price, outcome, market_slug,
         market_question, neg_risk, our_size, our_entry_price, current_price, pnl_if_copied,
         resolved, resolution_price, trader_timestamp)
        VALUES {args}
        ON CONFLICT (trader_address, condition_id, token_id, side, trader_timestamp) DO NOTHING
    """)
    conn.commit()
    inserted += len(batch)
    if inserted % 10000 == 0:
        print(f"  {inserted:,}/{len(rows):,}")

print(f"\nInserted (with dedup): {inserted:,}")
cur.execute("SELECT COUNT(*) FROM pm_shadow_trades")
print(f"Total shadow trades in DB: {cur.fetchone()[0]:,}")
cur.execute("SELECT COUNT(DISTINCT trader_address) FROM pm_shadow_trades")
print(f"Total traders in DB: {cur.fetchone()[0]:,}")
conn.close()
