# Timestamp Policy Quick Reference

## At a Glance

### Timestamp Flow

```
Exchange Event → CEX Connector → Quote Cache → Detection Filter → Opportunity
    ↓                  ↓              ↓              ↓
exchangeTsMs      receivedTsMs   Validation   Time Alignment
                  latencyMs      isValidTs    maxTimeSkewMs
```

### Quote Timestamp Fields

```typescript
{
  exchangeTsMs: 1737350000000,    // From exchange (CEX only)
  receivedTsMs: 1737350000012,    // When received locally
  blockTsMs: 1737350000008,       // From block data (DEX only)
  latencyMs: 12                   // receivedTsMs - exchangeTsMs
}
```

## Validation Rules

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Future timestamp | +500ms | Reject (mark stale) |
| Ancient timestamp | -30000ms | Reject (mark stale) |
| Negative latency | <-100ms | Reject (mark stale) |
| Block lag (DEX) | >2 blocks | Mark stale |
| Time skew (CEX↔DEX) | Base: 1500ms<br>Mainnet: 3000ms | Skip opportunity |

## Configuration

```json
{
  "system": {
    "maxFutureTsMs": 500,
    "maxPastTsMs": 30000,
    "dexBlockLagThreshold": 2
  },
  "detection": {
    "maxTimeSkewMsBase": 1500,
    "maxTimeSkewMsMainnet": 3000
  }
}
```

## Common Use Cases

### 1. Check if Quote is Valid

```typescript
const quoteWithStaleness = cache.getQuoteWithStaleness({ venue, pair, chain });
if (quoteWithStaleness?.isStale) {
  console.log(`Stale: ${quoteWithStaleness.staleReason}`);
}
```

### 2. Get Block Timestamp

```typescript
// From block watcher
const blockTs = blockWatcher.getBlockTimestamp(blockNumber);

// From quote cache
const cachedTs = quoteCache.getBlockTimestamp(chain, blockNumber);
```

### 3. Validate Manual Timestamp

```typescript
import { validateTimestamps } from './utils/clock.js';

const result = validateTimestamps(exchangeTsMs, receivedTsMs);
if (!result.isValid) {
  console.error(`Invalid: ${result.reason}`);
}
```

### 4. Check Time Alignment

```typescript
import { timeAlignmentFilter, getMaxTimeSkewMs } from './detection/filters.js';

const maxSkew = getMaxTimeSkewMs(chain);
const result = timeAlignmentFilter({ anchorQuote, dexQuote, maxTimeSkewMs: maxSkew });

if (!result.passed) {
  skipOpportunity(result.reason); // e.g., "time_skew: 2000ms > 1500ms"
}
```

## Database Queries

### Recent Quotes with Latency

```sql
SELECT venue_id, pair_id, mid, latency_ms, exchange_ts_ms, received_ts_ms
FROM quotes_raw
WHERE exchange_ts_ms IS NOT NULL
ORDER BY received_ts_ms DESC
LIMIT 100;
```

### Venue Health with Latency

```sql
SELECT v.name, ch.last_latency_ms, ch.p95_latency_ms, ch.invalid_ts_count, ch.future_ts_count
FROM connector_health ch
JOIN venues v ON ch.venue_id = v.id
ORDER BY ch.p95_latency_ms DESC NULLS LAST;
```

### Latency Distribution

```sql
SELECT
  venue_id,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) as p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) as p99
FROM quotes_raw
WHERE exchange_ts_ms IS NOT NULL
  AND ts > NOW() - INTERVAL '1 hour'
GROUP BY venue_id;
```

## Logging

### Startup NTP Check

```
INFO: NTP clock sync status: { isSynced: true, service: 'chrony', offsetMs: 2.4 }
```

### Invalid Timestamp Warning

```
WARN: Invalid timestamp detected: { venue: 'binance', pair: 'WETH/USDC', exchangeTsMs: ..., receivedTsMs: ..., reason: 'future_timestamp: 800ms ahead' }
```

### Time Alignment Skip

```
DEBUG: Opportunity skipped: { reason: 'time_skew: 2000ms > 1500ms', pair: 'WETH/USDC', chain: 'base' }
```

## Health Checks

### Good Health Indicators

- NTP synced: `isSynced = true`
- Low latency: `p95_latency_ms < 500ms`
- No invalid timestamps: `invalid_ts_count = 0`
- No future timestamps: `future_ts_count = 0`

### Warning Signs

- High latency: `p95_latency_ms > 1000ms`
- Growing invalid count: `invalid_ts_count` increasing
- Future timestamps: `future_ts_count > 0` (clock drift)

### Critical Issues

- NTP not synced: `isSynced = false`
- Very high latency: `p95_latency_ms > 2000ms`
- Rapid future timestamp growth: Clock severely drifted

## Troubleshooting

### Issue: High latency from one venue

**Check**:
```sql
SELECT last_latency_ms, p95_latency_ms FROM connector_health WHERE venue_id = ?;
```

**Fix**: Restart connector or switch to backup venue

### Issue: Many invalid timestamps

**Check**:
```sql
SELECT invalid_ts_count, future_ts_count FROM connector_health WHERE venue_id = ?;
```

**Fix**: Check NTP sync, restart NTP service if needed

### Issue: Opportunities skipped due to time_skew

**Check**: Logs for time alignment filter failures

**Fix**:
- If DEX block data delayed: Check RPC provider
- If CEX latency high: Check network or exchange status
- If persistent: Increase `maxTimeSkewMs` threshold

## Performance Tuning

### Reduce Timestamp Validation Overhead

If validation becomes a bottleneck (unlikely):
- Increase `maxPastTsMs` to accept older quotes
- Disable validation by setting `maxFutureTsMs = Infinity`

### Reduce RPC Load

Block timestamp fetching adds one `getBlock` call per block:
- **Base**: ~1 call per 2s (~43k/day)
- **Mainnet**: ~1 call per 12s (~7k/day)

If RPC rate limits hit, consider:
- Increase block watcher poll interval
- Use WebSocket for block updates (fewer HTTP calls)
- Disable block timestamp caching (use only receivedTsMs for DEX)

## Integration Checklist

- [ ] Run database migration: `sql/003_add_timestamp_columns.sql`
- [ ] Deploy updated code
- [ ] Verify NTP sync logged at startup
- [ ] Check exchange timestamps in logs
- [ ] Monitor latency metrics in `connector_health`
- [ ] Set up Grafana panels for latency
- [ ] Configure alerts for high latency and clock drift
- [ ] Test time alignment filter with real data
- [ ] Tune thresholds based on observed behavior

## References

- Full Documentation: `/docs/TIMESTAMP_POLICY.md`
- Implementation Summary: `/IMPLEMENTATION_SUMMARY.md`
- Code: `/src/utils/clock.ts`, `/src/detection/filters.ts`
