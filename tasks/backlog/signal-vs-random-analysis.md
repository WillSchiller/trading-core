# Analyze signal vs random benchmark with larger sample

## Priority: High
## Labels: research, data-analysis

## Description
Post-Mar5 random_short is outperforming real signals (+13.0 vs +3.1 bps). Pre-gap (Feb 11-14) signal beat random (-4.2 vs -11.3 bps). Need to determine if post-Mar5 is market regime noise or structural.

## Analysis needed
1. Once ~3 weeks of data collected, compare signal vs random across different market regimes
2. Check if trailing stop on random is just capturing market drift (short bias)
3. If random consistently beats signal, the z-score entry adds no value and the edge is purely in the exit mechanism

## Key query
```sql
SELECT direction, COUNT(*), ROUND(AVG(pnl_bps)::numeric, 1) as avg_pnl
FROM pca_signals
WHERE created_at > '2026-03-05' AND direction IN ('short','random_short') AND resolved = true
GROUP BY 1;
```

## Target date: ~Mar 25
