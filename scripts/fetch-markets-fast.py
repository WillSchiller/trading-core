#!/usr/bin/env python3
"""Fast parallel market resolution fetcher — by slug not conditionId."""
import json
import asyncio
import aiohttp
from pathlib import Path

DATA_DIR = Path("/tmp/pm_edge_study")
GAMMA_API = "https://gamma-api.polymarket.com"
CONCURRENT = 20
BATCH_DELAY = 0.5

with open(DATA_DIR / "trader_histories.json") as f:
    histories = json.load(f)

slug_cache_file = DATA_DIR / "slug_cache.json"
if slug_cache_file.exists():
    with open(slug_cache_file) as f:
        slug_cache = json.load(f)
else:
    slug_cache = {}

slugs = set()
for trades in histories.values():
    for t in trades:
        s = t.get('slug', '')
        if s and t.get('side') == 'BUY':
            slugs.add(s)

to_fetch = [s for s in slugs if s not in slug_cache]
print(f"Total slugs: {len(slugs)}, cached: {len(slug_cache)}, to fetch: {len(to_fetch)}")

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

async def main():
    sem = asyncio.Semaphore(CONCURRENT)
    connector = aiohttp.TCPConnector(limit=CONCURRENT, ttl_dns_cache=300)
    async with aiohttp.ClientSession(connector=connector) as session:
        batch_size = 200
        for i in range(0, len(to_fetch), batch_size):
            batch = to_fetch[i:i+batch_size]
            tasks = [fetch_market(session, s, sem) for s in batch]
            results = await asyncio.gather(*tasks)
            for slug, result in results:
                slug_cache[slug] = result
            done = min(i + batch_size, len(to_fetch))
            closed = sum(1 for v in slug_cache.values() if v and v.get('closed'))
            print(f"  {done}/{len(to_fetch)} ({done/len(to_fetch)*100:.0f}%) — {closed} resolved")
            with open(slug_cache_file, 'w') as f:
                json.dump(slug_cache, f)
            await asyncio.sleep(BATCH_DELAY)

asyncio.run(main())
closed = sum(1 for v in slug_cache.values() if v and v.get('closed'))
print(f"\nDone. {len(slug_cache)} markets cached, {closed} resolved.")
