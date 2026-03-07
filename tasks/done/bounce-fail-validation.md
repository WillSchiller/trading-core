# Validate bounce_fail exit mechanism

## Priority: High
## Labels: research, data-analysis

## Completed: 2026-03-08

## Result
Bounce_fail is correctly killing losers. Shadow tracking confirms:
- Post-Mar5: 0/98 bounce_fail positions recovered (avg shadow PnL -30.5 bps)
- Pre-gap: 1/99 recovered (avg shadow PnL -40.1 bps)
- None ever reached trailing activation (peak avg only +7.8 bps vs 30 bps threshold)

**Verdict**: Keep bounce_fail as-is. It's not cutting too early.
