# Build per-asset blocklist from data

## Priority: Medium
## Labels: strategy, signal-quality

## Description
Some assets consistently lose on short signals (SAGA, TNSR, MOODENG — all bounce_fail dominated in post-Mar5). Need larger sample to confirm which are genuinely bad vs unlucky.

## Approach
1. Wait for 3+ weeks of data
2. Identify assets with >10 signals and negative total PnL
3. Cross-reference with pre-gap data for consistency
4. Add configurable `blockedAssets` list to PCA config

## Current worst (post-Mar5, small sample)
- SAGA: -180 bps (4 signals, 4 bounce_fail)
- TNSR: -193 bps (3 signals, 3 bounce_fail)
- MOODENG: -131 bps (5 signals, 4 bounce_fail)
- GMX: -93 bps (6 signals, 4 bounce_fail)

## Target date: ~Mar 25
