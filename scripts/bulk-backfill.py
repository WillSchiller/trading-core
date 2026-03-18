#!/usr/bin/env python3
"""
Bulk backfill shadow trades from the edge study cache into production DB.
Uses the locally cached trade histories and slug-based market resolutions.
Run via SSH on the EC2 instance or against the DB directly.
"""
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

# Get existing traders and their addresses
cur.execute("SELECT address FROM pm_tracked_traders")
existing_traders = {r[0] for r in cur.fetchall()}

# Get existing shadow trade dedup keys
cur.execute("SELECT trader_address, condition_id, token_id, side, trader_timestamp FROM pm_shadow_trades")
existing_keys = set()
for r in cur.fetchall():
    existing_keys.add((r[0], r[1], r[2], r[3], int(r[4]) if r[4] else 0))
print(f"Existing: {len(existing_traders)} traders, {len(existing_keys)} shadow trades")

# First ensure all traders exist in pm_tracked_traders
traders_added = 0
for addr, trades in histories.items():
    if addr not in existing_traders:
        name = ''
        for t in trades:
            if t.get('pseudonym') or t.get('name'):
                name = t.get('name') or t.get('pseudonym') or ''
                break
        if not name:
            name = addr[:10]
        cur.execute("""
            INSERT INTO pm_tracked_traders (address, alias, pnl, volume, bankroll_estimate, rank, enabled, copy_eligible)
            VALUES (%s, %s, 0, 0, 10000, 999, true, false)
            ON CONFLICT (address) DO NOTHING
        """, (addr, name))
        traders_added += 1
conn.commit()
print(f"Added {traders_added} new traders")

# Now bulk insert shadow trades
inserted = 0
skipped = 0
errors = 0
batch = []
BATCH_SIZE = 500
BANKROLL = 500
MAX_POS = 100

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

        dedup_key = (addr, cid, token_id, side, ts_ms)
        if dedup_key in existing_keys:
            skipped += 1
            continue

        # Compute our_size (proportional sizing)
        our_size = min(size * (BANKROLL / 10000), MAX_POS) if side == 'BUY' else None
        our_entry = price if side == 'BUY' else None

        # Resolution
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

        batch.append((
            addr, name, cid, token_id, side, size, price, outcome, slug,
            '', False,
            our_size, our_entry, current_price, pnl,
            resolved, resolution_price, ts_ms
        ))
        existing_keys.add(dedup_key)

        if len(batch) >= BATCH_SIZE:
            try:
                cur.executemany("""
                    INSERT INTO pm_shadow_trades
                    (trader_address, trader_alias, condition_id, token_id, side, size, price, outcome, market_slug,
                     market_question, neg_risk,
                     our_size, our_entry_price, current_price, pnl_if_copied,
                     resolved, resolution_price, trader_timestamp)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """, batch)
                conn.commit()
                inserted += len(batch)
            except Exception as e:
                conn.rollback()
                # Insert one by one to skip dupes
                for row in batch:
                    try:
                        cur.execute("""
                            INSERT INTO pm_shadow_trades
                            (trader_address, trader_alias, condition_id, token_id, side, size, price, outcome, market_slug,
                             market_question, neg_risk,
                             our_size, our_entry_price, current_price, pnl_if_copied,
                             resolved, resolution_price, trader_timestamp)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        """, row)
                        conn.commit()
                        inserted += 1
                    except:
                        conn.rollback()
                        errors += 1
            batch = []
            if inserted % 5000 == 0:
                print(f"  {inserted:,} inserted, {skipped:,} skipped, {errors:,} errors")

# Final batch
if batch:
    try:
        cur.executemany("""
            INSERT INTO pm_shadow_trades
            (trader_address, trader_alias, condition_id, token_id, side, size, price, outcome, market_slug,
             market_question, neg_risk,
             our_size, our_entry_price, current_price, pnl_if_copied,
             resolved, resolution_price, trader_timestamp)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, batch)
        conn.commit()
        inserted += len(batch)
    except Exception as e:
        conn.rollback()
        for row in batch:
            try:
                cur.execute("""
                    INSERT INTO pm_shadow_trades
                    (trader_address, trader_alias, condition_id, token_id, side, size, price, outcome, market_slug,
                     market_question, neg_risk,
                     our_size, our_entry_price, current_price, pnl_if_copied,
                     resolved, resolution_price, trader_timestamp)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """, row)
                conn.commit()
                inserted += 1
            except:
                conn.rollback()
                errors += 1

# Mark all as backfilled
for addr in histories:
    cur.execute("""
        UPDATE pm_tracked_traders SET backfilled_at = NOW()
        WHERE address = %s AND backfilled_at IS NULL
    """, (addr,))
conn.commit()

print(f"\nDone. {inserted:,} inserted, {skipped:,} skipped, {errors:,} errors")
print(f"Total traders now: {len(existing_traders) + traders_added}")

cur.execute("SELECT COUNT(*) FROM pm_shadow_trades")
print(f"Total shadow trades in DB: {cur.fetchone()[0]:,}")

cur.close()
conn.close()
