# Timestamp and Clock Policy

This document describes the implementation of the timestamp and clock policy for the MVP hardening phase.

## Overview

The timestamp policy ensures accurate time tracking across CEX and DEX data sources, validates timestamp correctness, and aligns quotes temporally before opportunity detection. This reduces false positives from time-skewed data and improves trade decision quality.

## Components

### 1. Server Clock Discipline

**File**: `/src/utils/clock.ts`

The system checks NTP synchronization status at startup by detecting and querying the following services:

- **chrony**: Preferred on modern Linux systems
- **systemd-timesyncd**: Common on Ubuntu/Debian
- **ntpd**: Traditional NTP daemon

**Output**:
```typescript
{
  isSynced: boolean,
  service: 'chrony' | 'systemd-timesyncd' | 'ntpd' | 'unknown',
  offsetMs?: number,
  details?: string
}
```

**Logged at startup** (see `/src/index.ts`):
```
NTP clock sync status: { isSynced: true, service: 'chrony', offsetMs: 2.4, details: 'System time offset: 2.40ms' }
```

If NTP is not synced, a warning is logged but the system continues to run.

### 2. Exchange Timestamps

**Files**:
- `/src/collectors/cex/binance.ts`
- `/src/collectors/cex/coinbase.ts`
- `/src/collectors/cex/bybit.ts`

All CEX connectors now parse and store exchange-provided timestamps:

- **Binance**: Uses `E` field (event time) from `bookTicker` messages
- **Coinbase**: Uses `time` field from ticker messages (ISO 8601 format)
- **Bybit**: Uses `ts` field from orderbook messages

**Quote structure**:
```typescript
{
  ts: Date,                  // Local timestamp (for backwards compat)
  exchangeTsMs: number,      // Exchange event timestamp in milliseconds
  receivedTsMs: number,      // Local receipt timestamp in milliseconds
  latencyMs: number,         // Calculated: receivedTsMs - exchangeTsMs
  venue: string,
  pair: string,
  mid: number,
  ...
}
```

### 3. Timestamp Validation

**File**: `/src/state/quote-cache.ts`

When a quote is added to the cache, its timestamp is validated:

**Validation rules**:
- **Future timestamps**: Quote is rejected if `exchangeTsMs > receivedTsMs + 500ms`
- **Ancient timestamps**: Quote is rejected if `exchangeTsMs < receivedTsMs - 30000ms` (30 seconds old)
- **Negative latency**: Quote is rejected if `latencyMs < -100ms`

**Invalid quotes**:
- Are marked with `isValidTs = false` and `invalidTsReason`
- Are automatically marked as **stale** and excluded from opportunity detection
- Trigger increment of `invalid_ts_count` in `connector_health` table
- Are logged as warnings with details

**Configuration** (in `/config/default.json`):
```json
{
  "system": {
    "maxFutureTsMs": 500,
    "maxPastTsMs": 30000
  }
}
```

### 4. DEX Time Source

**File**: `/src/chain/block-watcher.ts`

The block watcher now:
- Fetches full block data (including `timestamp`) for each new block
- Caches up to 100 recent block timestamps in memory
- Exposes `getBlockTimestamp(blockNumber)` for retrieval

**Block structure**:
```typescript
{
  blockNumber: bigint,
  timestamp: number  // milliseconds since epoch
}
```

**Quote cache integration**:
- DEX quotes use `blockTsMs` from cached block data
- Falls back to `receivedTsMs` if block timestamp unavailable
- Primary staleness for DEX is still **block lag** (currentBlock - quoteBlock > 2)

**QuoteCache API**:
```typescript
cache.updateCurrentBlock(chain, blockNumber, timestamp);
cache.getBlockTimestamp(chain, blockNumber);
```

### 5. Time Alignment Gate

**File**: `/src/detection/filters.ts`

New filter: `timeAlignmentFilter`

**Purpose**: Ensures that CEX anchor quotes and DEX quotes are temporally aligned before calculating spread.

**Algorithm**:
```typescript
tAnchor = anchorQuote.exchangeTsMs ?? anchorQuote.receivedTsMs
tDex = dexQuote.blockTsMs ?? dexQuote.receivedTsMs
skew = abs(tAnchor - tDex)

if (skew > maxTimeSkewMs) {
  return { passed: false, reason: 'time_skew' }
}
```

**Thresholds** (per chain):
- **Base**: 1500ms max skew (2s block time)
- **Mainnet**: 3000ms max skew (12s block time)

**Integration**: This filter should be called in the opportunity detection loop before emitting an opportunity.

**Example usage**:
```typescript
import { timeAlignmentFilter, getMaxTimeSkewMs } from './filters.js';

const maxSkew = getMaxTimeSkewMs(chain);
const result = timeAlignmentFilter({
  anchorQuote,
  dexQuote,
  maxTimeSkewMs: maxSkew
});

if (!result.passed) {
  skipOpportunity(result.reason);
}
```

### 6. Drift Monitoring

**File**: `/src/persistence/health.ts`

The `connector_health` table now tracks:

- `last_latency_ms`: Most recent quote latency
- `p95_latency_ms`: 95th percentile latency (calculated externally, persisted via API)
- `invalid_ts_count`: Count of quotes with invalid timestamps
- `future_ts_count`: Count of quotes with future timestamps

**New APIs**:
```typescript
healthPersistence.updateLatencyMetrics(venueId, chain, latencyMs, p95LatencyMs);
healthPersistence.incrementInvalidTsCount(venueId, chain);
healthPersistence.incrementFutureTsCount(venueId, chain);
```

**Alert thresholds** (to be implemented in monitoring):
- If `p95_latency_ms > 2000ms` for more than 60 seconds → WARN
- If `future_ts_count` increases rapidly → CRITICAL (clock drift detected)

### 7. Database Schema

**File**: `/sql/003_add_timestamp_columns.sql`

**New columns in `quotes_raw`**:
- `exchange_ts_ms BIGINT`: Exchange-provided timestamp
- `received_ts_ms BIGINT`: Local receipt timestamp
- `block_ts_ms BIGINT`: DEX block timestamp

**New columns in `connector_health`**:
- `last_latency_ms INT`: Most recent latency
- `p95_latency_ms INT`: 95th percentile latency
- `invalid_ts_count INT`: Count of invalid timestamps
- `future_ts_count INT`: Count of future timestamps

**Indexes**:
```sql
CREATE INDEX idx_quotes_raw_exchange_ts ON quotes_raw (exchange_ts_ms DESC)
  WHERE exchange_ts_ms IS NOT NULL;

CREATE INDEX idx_connector_health_latency ON connector_health (venue_id, p95_latency_ms)
  WHERE p95_latency_ms IS NOT NULL;
```

## Configuration

**File**: `/config/default.json`

```json
{
  "system": {
    "quoteStaleThresholdMs": 3000,
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

## Usage Examples

### Check NTP Status at Startup

```typescript
import { checkNtpSync } from './utils/clock.js';

const ntpStatus = await checkNtpSync();
logger.info(ntpStatus, 'NTP sync status');
```

### Validate Quote Timestamps

```typescript
import { validateTimestamps } from './utils/clock.js';

const validation = validateTimestamps(
  exchangeTsMs,
  receivedTsMs,
  500,    // maxFutureMs
  30000   // maxPastMs
);

if (!validation.isValid) {
  logger.warn({ reason: validation.reason }, 'Invalid timestamp');
}
```

### Time Alignment Filter

```typescript
import { timeAlignmentFilter, getMaxTimeSkewMs } from './detection/filters.js';

const maxSkew = getMaxTimeSkewMs('base');
const result = timeAlignmentFilter({
  anchorQuote: binanceQuote,
  dexQuote: uniswapQuote,
  maxTimeSkewMs: maxSkew
});

if (!result.passed) {
  skipOpportunity(result.reason);
}
```

### Track Latency Metrics

```typescript
import { HealthPersistence } from './persistence/health.js';

const healthPersistence = new HealthPersistence(pool);

// Update after each quote
await healthPersistence.updateLastQuote(venueId, chain, blockNumber, latencyMs);

// Update p95 periodically (e.g., every minute)
await healthPersistence.updateLatencyMetrics(venueId, chain, latencyMs, p95Latency);
```

## Testing

### Unit Tests

**File**: `tests/unit/clock.test.ts` (to be created)

Test cases:
- `validateTimestamps` with valid, future, ancient, and negative latency inputs
- `getMaxTimeSkewMs` returns correct values for each chain

**File**: `tests/unit/filters.test.ts` (to be created)

Test cases:
- `timeAlignmentFilter` with aligned and skewed quotes

### Integration Tests

**File**: `tests/integration/quote-cache.test.ts` (to be created)

Test cases:
- Invalid timestamp quotes are marked as stale
- Valid quotes pass through
- Block timestamp caching and retrieval

## Monitoring

### Key Metrics (Grafana)

**Panel 1: CEX Latency by Venue**
```sql
SELECT venue_name, AVG(last_latency_ms) as avg_latency, MAX(p95_latency_ms) as p95_latency
FROM connector_health
WHERE last_latency_ms IS NOT NULL
GROUP BY venue_name
ORDER BY p95_latency DESC;
```

**Panel 2: Invalid Timestamp Rate**
```sql
SELECT venue_name, invalid_ts_count, future_ts_count
FROM connector_health
WHERE invalid_ts_count > 0 OR future_ts_count > 0;
```

**Panel 3: Time Skew Distribution**
```sql
SELECT
  ABS(exchange_ts_ms - received_ts_ms) as latency_ms,
  COUNT(*)
FROM quotes_raw
WHERE exchange_ts_ms IS NOT NULL
GROUP BY latency_ms
ORDER BY latency_ms;
```

### Alerts

**High Latency**:
```
IF p95_latency_ms > 2000 FOR 60s THEN alert
```

**Clock Drift**:
```
IF future_ts_count increases by > 100 in 60s THEN critical_alert
```

## Runbook

### Symptom: High latency alerts

**Diagnosis**:
1. Check `connector_health` table for affected venue
2. Check network connectivity to exchange
3. Check local system load

**Action**:
- If persistent: switch to backup venue or disable affected venue

### Symptom: Frequent invalid timestamp rejections

**Diagnosis**:
1. Check `invalid_ts_count` and `future_ts_count` in `connector_health`
2. Check NTP sync status: `timedatectl status`
3. Check system clock drift

**Action**:
- If NTP not synced: restart NTP service
- If clock drifting: investigate hardware or OS issues
- If exchange timestamps wrong: contact exchange support

### Symptom: Many opportunities skipped due to time_skew

**Diagnosis**:
1. Check actual time skew values in logs
2. Verify block watcher is updating block timestamps
3. Check if DEX RPC is lagging

**Action**:
- If block watcher issues: restart or switch RPC provider
- If RPC lagging: add buffer to `maxTimeSkewMs` config
- If exchange latency high: increase thresholds

## Performance Impact

- **Quote processing**: ~5-10μs additional latency for timestamp validation
- **Memory**: Block timestamp cache: ~3KB per chain (100 blocks * 24 bytes)
- **Database**: New columns add ~24 bytes per raw quote row
- **RPC calls**: One additional `getBlock` call per new block (~2s on Base, ~12s on Mainnet)

## Future Enhancements

1. **Adaptive thresholds**: Adjust `maxTimeSkewMs` based on observed latency distribution
2. **Latency percentile tracking**: Track p50, p95, p99 latencies in-memory and persist periodically
3. **Clock skew estimation**: Estimate local clock offset from exchange timestamps
4. **Time series database**: Export latency metrics to Prometheus for long-term analysis
5. **Automated venue degradation**: Automatically downgrade or disable venues with chronic latency issues
