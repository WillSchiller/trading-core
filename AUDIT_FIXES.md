# Audit Fixes Applied

Date: 2026-01-26
Agent: opportunity-detector

## Summary

Fixed three issues identified in the quant research audit:

1. **Critical: Floating-point precision in depthFilter** (filters.ts)
2. **High Priority: Detection cycle overlap protection** (index.ts)
3. **Medium Priority: Duplicate calculateSpreadBps functions** (math.ts)

---

## Issue 1: Floating-Point Precision in depthFilter

**File**: `src/detection/filters.ts`

**Problem**: Liquidity depth was converted from bigint using `Number(liquidity)`, which can lose precision for large values (>2^53).

**Fix**: Applied Decimal.js pattern from spread-calculator.ts:

```typescript
// Before
const liquidityUsd = Number(liquidity) * dexMid;

// After
const liquidityDecimal = new Decimal(liquidity.toString());
const dexMidDecimal = new Decimal(dexMid);
const liquidityUsd = liquidityDecimal.times(dexMidDecimal).toNumber();
```

**Changes**:
- Added `import { Decimal } from 'decimal.js'` to filters.ts
- Updated depthFilter function to use Decimal.js for precise bigint multiplication

**Impact**: Eliminates precision loss when calculating liquidity in USD for large token amounts.

---

## Issue 2: Detection Cycle Overlap Protection

**File**: `src/detection/index.ts`

**Problem**: No lock prevented detection cycles from stacking if a cycle took longer than `tickIntervalMs`. This could cause memory issues and unpredictable behavior.

**Fix**: Added overlap protection with a boolean flag:

```typescript
// Added private field
private cycleInProgress: boolean;

// Updated runDetectionCycle
private async runDetectionCycle(): Promise<void> {
  if (this.cycleInProgress) {
    this.logger.warn('Detection cycle still in progress, skipping this tick');
    return;
  }

  this.cycleInProgress = true;
  const startTime = Date.now();

  try {
    // ... existing cycle logic
  } finally {
    this.cycleInProgress = false;
  }
}
```

**Changes**:
- Added `cycleInProgress: boolean` field to OpportunityDetector class
- Initialized to `false` in constructor
- Set to `true` at start of runDetectionCycle
- Reset to `false` in finally block (ensures reset even on errors)
- Added warning log when cycle is skipped

**Impact**: Prevents cycles from overlapping, ensuring system stability when detection takes longer than expected.

---

## Issue 3: Duplicate calculateSpreadBps Functions

**Files**: `src/detection/spread-calculator.ts` and `src/utils/math.ts`

**Problem**: Two implementations of calculateSpreadBps existed:
- `src/detection/spread-calculator.ts`: Uses Decimal.js (correct, precise)
- `src/utils/math.ts`: Uses plain JavaScript arithmetic (imprecise)

**Fix**: Removed the duplicate from math.ts, keeping only the Decimal.js version in spread-calculator.ts.

**Changes**:
- Removed `calculateSpreadBps` function from src/utils/math.ts
- All existing usage already pointed to the Decimal.js version in spread-calculator.ts
- No imports needed updating (verified with grep)

**Impact**: Eliminates confusion and ensures all spread calculations use precise Decimal.js arithmetic.

---

## Verification

All changes verified with:

1. **Unit tests**: All 67 tests pass
   ```
   npm run test:unit
   ✓ tests/unit/spread-calculator.test.ts  (15 tests)
   ✓ tests/unit/filters.test.ts  (24 tests)
   ✓ tests/unit/pool-state-tracker.test.ts  (28 tests)
   ```

2. **Import verification**: Confirmed Decimal.js imported correctly in both files
3. **Code search**: Verified no orphaned references to removed function

---

## Files Modified

- `src/detection/filters.ts` - Added Decimal.js import, updated depthFilter
- `src/detection/index.ts` - Added cycleInProgress flag and overlap protection
- `src/utils/math.ts` - Removed duplicate calculateSpreadBps function

---

## Next Steps

These fixes address the immediate precision and concurrency issues. Recommended follow-ups:

1. Add integration test specifically for large liquidity values (>2^53) to verify precision
2. Add performance test to verify overlap protection works under load
3. Consider adding metrics for cycle overlap events (count of skipped cycles)
