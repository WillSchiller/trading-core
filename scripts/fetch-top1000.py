#!/usr/bin/env python3
"""Fetch top 1000 all-time sports traders + weekly/monthly."""
import requests
import json
import time
import asyncio
import aiohttp
from pathlib import Path

DATA_DIR = Path("/tmp/pm_edge_study")
DATA_API = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"

with open(DATA_DIR / "trader_histories.json") as f:
    histories = json.load(f)
with open(DATA_DIR / "slug_cache.json") as f:
    slug_cache = json.load(f)

print(f"Existing: {len(histories)} traders, {len(slug_cache)} markets")

# Fetch top 1000 all-time + 500 weekly + 500 monthly
all_traders = {}
for period, limit in [('ALL', 1000), ('MONTH', 500), ('WEEK', 500)]:
    for offset in range(0, limit, 100):
        url = f"{DATA_API}/v1/leaderboard?category=SPORTS&timePeriod={period}&orderBy=PNL&limit=100&offset={offset}"
        resp = requests.get(url, timeout=30)
        if resp.status_code != 200 or not resp.json():
            break
        for item in resp.json():
            addr = (item.get('proxyWallet') or '').lower()
            if addr and addr not in all_traders:
                all_traders[addr] = item.get('userName', '')
        time.sleep(0.2)
    print(f"  {period} (limit {limit}): {len(all_traders)} unique traders")

to_fetch = [a for a in all_traders if a not in histories]
print(f"\nNew traders to fetch: {len(to_fetch)}")

def fetch_history(address, max_pages=50):
    all_trades = []
    for page in range(max_pages):
        url = f"{DATA_API}/trades?user={address}&limit=100&offset={page*100}"
        try:
            resp = requests.get(url, timeout=30)
            if resp.status_code != 200 or not resp.json():
                break
            trades = resp.json()
            all_trades.extend(trades)
            if len(trades) < 100:
                break
            time.sleep(0.1)
        except:
            break
    return all_trades

for i, addr in enumerate(to_fetch):
    histories[addr] = fetch_history(addr)
    if (i + 1) % 25 == 0 or i == len(to_fetch) - 1:
        total = sum(len(v) for v in histories.values())
        print(f"  {i+1}/{len(to_fetch)}: {len(histories)} traders, {total:,} trades")
        with open(DATA_DIR / "trader_histories.json", 'w') as f:
            json.dump(histories, f)
    time.sleep(0.1)

with open(DATA_DIR / "trader_histories.json", 'w') as f:
    json.dump(histories, f)

# Fetch new slugs
new_slugs = set()
for trades in histories.values():
    for t in trades:
        s = t.get('slug', '')
        if s and s not in slug_cache and t.get('side') == 'BUY':
            new_slugs.add(s)

print(f"\nNew markets to resolve: {len(new_slugs)}")

async def fetch_market(session, slug, sem):
    async with sem:
        try:
            async with session.get(f"{GAMMA_API}/markets?slug={slug}", timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    if data:
                        m = data[0]
                        return slug, {'closed': m.get('closed', False), 'outcomePrices': m.get('outcomePrices'), 'outcomes': m.get('outcomes'), 'clobTokenIds': m.get('clobTokenIds')}
                return slug, None
        except:
            return slug, None

async def main():
    sem = asyncio.Semaphore(20)
    to_fetch_list = list(new_slugs)
    connector = aiohttp.TCPConnector(limit=20, ttl_dns_cache=300)
    async with aiohttp.ClientSession(connector=connector) as session:
        for i in range(0, len(to_fetch_list), 200):
            batch = to_fetch_list[i:i+200]
            results = await asyncio.gather(*[fetch_market(session, s, sem) for s in batch])
            for slug, result in results:
                slug_cache[slug] = result
            done = min(i + 200, len(to_fetch_list))
            if done % 5000 == 0 or done == len(to_fetch_list):
                resolved = sum(1 for v in slug_cache.values() if v and v.get('closed'))
                print(f"  {done}/{len(to_fetch_list)} — {resolved} total resolved")
                with open(DATA_DIR / "slug_cache.json", 'w') as f:
                    json.dump(slug_cache, f)
            await asyncio.sleep(0.5)
    with open(DATA_DIR / "slug_cache.json", 'w') as f:
        json.dump(slug_cache, f)

if new_slugs:
    asyncio.run(main())

total = sum(len(v) for v in histories.values())
resolved = sum(1 for v in slug_cache.values() if v and v.get('closed'))
print(f"\nDone: {len(histories)} traders, {total:,} trades, {len(slug_cache):,} markets ({resolved:,} resolved)")
