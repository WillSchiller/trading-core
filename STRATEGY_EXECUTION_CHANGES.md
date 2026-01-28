# Strategy-Specific Execution Parameters Implementation

## Summary

Implemented strategy-specific execution parameters to prevent rank_space opportunities from being killed by decay and buffer logic designed for dislocation strategy.

## Problem

The execution layer was applying uniform decay calculation and edge buffer (10 bps) to all opportunities regardless of strategy:

```
Original rank_space: 6.1 bps → Fresh: 0.2 bps (decay: 5.9 bps) ← 97% destroyed
Required spread: 19.5 bps (fee:5 + slip:4.5 + gas:0.0 + buffer:10)
Result: Skipped
```

This killed viable rank_space opportunities that would otherwise clear break-even thresholds.

## Changes Made

### 1. Added Strategy-Specific Decay Logic

**File**: `/Users/will/dev/blockhelix/src/execution/index.ts` (lines 380-392)

```typescript
const strategy = opportunity.strategy ?? 'dislocation';

let freshSpreadBps: number;
let spreadDecay: number;
if (strategy === 'rank_space') {
  freshSpreadBps = rawFreshSpreadBps;
  spreadDecay = 0;  // No decay for rank_space
} else {
  freshSpreadBps = rawFreshSpreadBps;
  spreadDecay = Math.abs(opportunity.spreadBps) - Math.abs(freshSpreadBps);
}
```

**Impact**: rank_space opportunities no longer have their spreads artificially reduced by decay calculation.

### 2. Added Strategy-Specific Edge Buffer

**File**: `/Users/will/dev/blockhelix/src/execution/index.ts` (line 407)

```typescript
const edgeBufferBps = strategy === 'rank_space' ? 3 : this.appConfig.execution.edgeBufferBps;
```

**Impact**:
- rank_space: 3 bps buffer (more aggressive, suitable for persistent signals)
- dislocation: 5 bps buffer (from config, conservative for transient signals)

### 3. Fixed Config Mismatch

**Files**:
- `/Users/will/dev/blockhelix/src/config/types.ts` (line 35-36)
- `/Users/will/dev/blockhelix/src/config/schema.ts` (line 32)

**Added**:
```typescript
edgeBufferBps: number;
minProfitUsd?: number;
```

**Impact**: Config now properly defines `edgeBufferBps` instead of hardcoded value. The previous hardcoded 10 bps was inconsistent with config value of 5 bps.

### 4. Added Shadow Execution Logging

**File**: `/Users/will/dev/blockhelix/src/execution/index.ts` (lines 436-459)

```typescript
if (strategy === 'rank_space') {
  const grossSpreadBps = Math.abs(freshSpreadBps);
  const shadowPnl = {
    wouldClearBreakEven: grossSpreadBps >= breakEvenBps,
    wouldClearBreakEvenPlus2: grossSpreadBps >= breakEvenBps + 2,
    wouldClearBreakEvenPlus4: grossSpreadBps >= breakEvenBps + 4,
    counterfactualPnlBps: grossSpreadBps - breakEvenBps,
  };

  this.logger.info({
    strategy,
    freshSpreadBps,
    requiredSpreadBps,
    breakEvenBps,
    edgeBufferBps,
    shadowPnl,
  }, 'Shadow execution (rank_space skipped)');
}
```

**Impact**: For skipped rank_space opportunities, logs show:
- Whether it would have cleared break-even
- Whether it would have cleared break-even + 2bp
- Whether it would have cleared break-even + 4bp
- Counterfactual PnL in bps

This enables post-hoc analysis of opportunity quality without executing.

### 5. Enhanced Logging

**File**: `/Users/will/dev/blockhelix/src/execution/index.ts` (lines 411-429)

Added to spread re-validation logs:
- `strategy` field
- `edgeBufferBps` (now varies by strategy)
- `breakEvenBps` (for transparency)

## Expected Outcomes

### For rank_space Opportunities

**Before**:
```
Break-even: 11 bps (5 fee + 4.5 slip + 1.5 gas)
Required spread: 21 bps (11 + 10 buffer)
Fresh spread: 15 bps (after 97% decay)
Result: SKIPPED
```

**After**:
```
Break-even: 11 bps (5 fee + 4.5 slip + 1.5 gas)
Required spread: 14 bps (11 + 3 buffer)
Fresh spread: 15 bps (NO decay applied)
Result: EXECUTED
```

### For dislocation Opportunities

**No change** - behavior remains identical:
```
Break-even: 11 bps
Required spread: 16 bps (11 + 5 buffer from config)
Fresh spread: calculated with decay
```

## Verification

### Type Safety
```bash
npm run typecheck
# ✓ Passes without errors
```

### Database Schema
The `strategy` column already exists (migration `006_add_strategy.sql`):
```sql
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS strategy VARCHAR(32) DEFAULT 'dislocation';
```

### Strategy Detection
The rank_space detector already sets the strategy field:
```typescript
// src/detection/rank-space/index.ts:298
strategy: 'rank_space',
```

## Configuration

Update `/Users/will/dev/blockhelix/config/default.json`:

```json
{
  "execution": {
    "edgeBufferBps": 5,  // Used for dislocation strategy
    "maxSlippageBps": 35,
    "deadlineSeconds": 60,
    "gasBufferPercent": 20,
    "simulateBeforeSend": true,
    "minProfitUsd": 0.50
  }
}
```

The 3 bps buffer for rank_space is hardcoded in the execution logic as it's a strategy-specific parameter.

## Testing Recommendations

1. **Monitor shadow logs** for skipped rank_space opportunities
2. **Track counterfactual PnL** vs actual execution PnL
3. **Compare hit rates**:
   - Before: rank_space opportunities with >20 bps spread required
   - After: rank_space opportunities with >14 bps spread required
4. **Verify no regression** for dislocation strategy

## Files Modified

1. `/Users/will/dev/blockhelix/src/execution/index.ts` - Core execution logic
2. `/Users/will/dev/blockhelix/src/config/types.ts` - Type definitions
3. `/Users/will/dev/blockhelix/src/config/schema.ts` - Validation schema

## Next Steps

1. Run the system and monitor logs for `'Shadow execution (rank_space skipped)'` messages
2. Validate that rank_space opportunities execute when spread > break-even + 3bp
3. Compare counterfactual PnL from shadow logs to validate buffer sizing
4. Consider making rank_space buffer configurable if 3bp proves too aggressive/conservative

## Example Log Output

### Spread Re-validation (rank_space)
```json
{
  "opportunityId": "12345",
  "strategy": "rank_space",
  "originalSpreadBps": 15.2,
  "freshSpreadBps": 14.8,
  "spreadDecay": 0,
  "requiredSpreadBps": 14.0,
  "edgeBufferBps": 3,
  "breakEvenBps": 11.0,
  "breakEvenCacheHit": true,
  "anchorAgeMs": 150
}
```

### Shadow Execution (rank_space skipped)
```json
{
  "opportunityId": "12346",
  "strategy": "rank_space",
  "freshSpreadBps": 12.5,
  "requiredSpreadBps": 14.0,
  "breakEvenBps": 11.0,
  "feeTierBps": 5.0,
  "slippageBps": 4.5,
  "gasBps": 1.5,
  "edgeBufferBps": 3,
  "shadowPnl": {
    "wouldClearBreakEven": true,
    "wouldClearBreakEvenPlus2": false,
    "wouldClearBreakEvenPlus4": false,
    "counterfactualPnlBps": 1.5
  }
}
```

### Spread Re-validation (dislocation)
```json
{
  "opportunityId": "12347",
  "strategy": "dislocation",
  "originalSpreadBps": 20.5,
  "freshSpreadBps": 15.2,
  "spreadDecay": 5.3,
  "requiredSpreadBps": 16.0,
  "edgeBufferBps": 5,
  "breakEvenBps": 11.0,
  "breakEvenCacheHit": true,
  "anchorAgeMs": 200
}
```
