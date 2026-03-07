# Investigate hourly performance pattern

## Priority: Low
## Labels: research, data-analysis

## Description
Post-Mar5 data hints at time-of-day pattern:
- Best hours (UTC): 8-12 (avg +20-30 bps)
- Worst hours (UTC): 0-3, 20, 22-23 (avg -10 to -26 bps)

Very small sample (3-24 signals per hour). Need 3+ weeks to confirm.

## Existing mechanism
`blockedHoursUtc` config already exists in PCA config. If pattern holds, can block worst hours.

## Target date: ~Apr 1 (need large sample for hourly granularity)
