#!/usr/bin/env python3
"""Fetch top 500 all-time sports traders and their full histories."""
import requests
import json
import time
import asyncio
import aiohttp
from pathlib import Path

DATA_DIR = Path("/tmp/pm_edge_study")
DATA_API = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"

# Load existing caches
cache_file = DATA_DIR / "trader_histories.json"
with open(cache_file) as f:
    histories = json.load(f)

slug_cache_file = DATA_DIR / "slug_cache.json"
with open(slug_cache_file) as f:
    slug_cache = json.load(f)

print(f"Existing: {len(histories)} traders, {len(slug_cache)} markets")

# Step 1: Fetch top 500 from all-time leaderboard
print("\n=== Fetching top 500 all-time sports traders ===")
all_traders = {}
for offset in range(0, 500, 100):
    url = f"{DATA_API}/v1/leaderboard?category=SPORTS&timePeriod=ALL&orderBy=PNL&limit=100&offset={offset}"
    resp = requests.get(url, timeout=30)
    if resp.status_code != 200 or not resp.json():
        break
    for item in resp.json():
        addr = (item.get('proxyWallet') or '').lower()
        if addr:
            all_traders[addr] = {
                'name': item.get('userName', ''),
                'pnl': item.get('pnl', 0),
                'volume': item.get('vol', 0),
            }
    print(f"  offset {offset}: {len(all_traders)} traders")
    time.sleep(0.3)

# Also add weekly/monthly for diversity
for period in ['WEEK', 'MONTH']:
    for offset in range(0, 200, 100):
        url = f"{DATA_API}/v1/leaderboard?category=SPORTS&timePeriod={period}&orderBy=PNL&limit=100&offset={offset}"
        resp = requests.get(url, timeout=30)
        if resp.status_code != 200 or not resp.json():
            break
        for item in resp.json():
            addr = (item.get('proxyWallet') or '').lower()
            if addr and addr not in all_traders:
                all_traders[addr] = {
                    'name': item.get('userName', ''),
                    'pnl': item.get('pnl', 0),
                    'volume': item.get('vol', 0),
                }
        time.sleep(0.3)
    print(f"  +{period}: {len(all_traders)} total")

print(f"Total unique traders: {len(all_traders)}")

# Step 2: Fetch trade histories for new traders
to_fetch = [a for a in all_traders if a not in histories]
print(f"\n=== Fetching histories for {len(to_fetch)} new traders ===")

def fetch_trader_history(address, max_pages=50):
    all_trades = []
    for page in range(max_pages):
        url = f"{DATA_API}/trades?user={address}&limit=100&offset={page*100}"
        try:
            resp = requests.get(url, timeout=30)
            if resp.status_code != 200:
                break
            trades = resp.json()
            if not trades:
                break
            all_trades.extend(trades)
            if len(trades) < 100:
                break
            time.sleep(0.12)
        except:
            break
    return all_trades

for i, addr in enumerate(to_fetch):
    histories[addr] = fetch_trader_history(addr)
    if (i + 1) % 20 == 0 or i == len(to_fetch) - 1:
        total = sum(len(v) for v in histories.values())
        print(f"  {i+1}/{len(to_fetch)}: {total:,} total trades")
        with open(cache_file, 'w') as f:
            json.dump(histories, f)
    time.sleep(0.15)

with open(cache_file, 'w') as f:
    json.dump(histories, f)

# Step 3: Fetch new market resolutions
new_slugs = set()
for addr, trades in histories.items():
    for t in trades:
        s = t.get('slug', '')
        if s and s not in slug_cache and t.get('side') == 'BUY':
            new_slugs.add(s)

print(f"\n=== Fetching {len(new_slugs)} new market resolutions ===")

async def fetch_market(session, slug, sem):
    async with sem:
        try:
            async with session.get(f"{GAMMA_API}/markets?slug={slug}", timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    if data:
                        m = data[0]
                        return slug, {
                            'closed': m.get('closed', False),
                            'outcomePrices': m.get('outcomePrices'),
                            'outcomes': m.get('outcomes'),
                            'clobTokenIds': m.get('clobTokenIds'),
                        }
                return slug, None
        except:
            return slug, None

async def fetch_all_markets():
    sem = asyncio.Semaphore(20)
    connector = aiohttp.TCPConnector(limit=20, ttl_dns_cache=300)
    to_fetch_list = list(new_slugs)
    async with aiohttp.ClientSession(connector=connector) as session:
        for i in range(0, len(to_fetch_list), 200):
            batch = to_fetch_list[i:i+200]
            tasks = [fetch_market(session, s, sem) for s in batch]
            results = await asyncio.gather(*tasks)
            for slug, result in results:
                slug_cache[slug] = result
            done = min(i + 200, len(to_fetch_list))
            if done % 2000 == 0 or done == len(to_fetch_list):
                closed = sum(1 for v in slug_cache.values() if v and v.get('closed'))
                print(f"  {done}/{len(to_fetch_list)} ({done/len(to_fetch_list)*100:.0f}%) — {closed} total resolved")
                with open(slug_cache_file, 'w') as f:
                    json.dump(slug_cache, f)
            await asyncio.sleep(0.5)

    with open(slug_cache_file, 'w') as f:
        json.dump(slug_cache, f)

if new_slugs:
    asyncio.run(fetch_all_markets())

total_traders = len(histories)
total_trades = sum(len(v) for v in histories.values())
total_resolved = sum(1 for v in slug_cache.values() if v and v.get('closed'))
print(f"\n=== Done ===")
print(f"Traders: {total_traders}")
print(f"Trades: {total_trades:,}")
print(f"Markets: {len(slug_cache):,} ({total_resolved:,} resolved)")
