#!/bin/bash
# Daily A/B test report — runs on EC2 via cron
set -euo pipefail

cd /home/ubuntu/app
source .env 2>/dev/null || true

REPORT=$(docker exec dislocation-postgres psql -U trader -d dislocation_trader -t -A -F'|' -c "
SELECT model_version,
  COUNT(*) as trades,
  COUNT(*) FILTER (WHERE execution_status = 'filled') as filled,
  COUNT(*) FILTER (WHERE resolved AND real_pnl > 0) as wins,
  COUNT(*) FILTER (WHERE resolved AND real_pnl <= 0) as losses,
  COUNT(*) FILTER (WHERE NOT resolved) as open,
  ROUND(SUM(CASE WHEN resolved THEN real_pnl ELSE 0 END)::numeric, 2) as resolved_pnl,
  ROUND(AVG(our_size)::numeric, 2) as avg_size
FROM pm_live_trades
WHERE source = 'rust'
GROUP BY model_version
ORDER BY model_version;
")

TODAY_REPORT=$(docker exec dislocation-postgres psql -U trader -d dislocation_trader -t -A -F'|' -c "
SELECT model_version,
  COUNT(*) as trades,
  COUNT(*) FILTER (WHERE resolved AND real_pnl > 0) as wins,
  COUNT(*) FILTER (WHERE resolved AND real_pnl <= 0) as losses,
  ROUND(SUM(CASE WHEN resolved THEN real_pnl ELSE 0 END)::numeric, 2) as pnl
FROM pm_live_trades
WHERE source = 'rust' AND executed_at >= CURRENT_DATE
GROUP BY model_version
ORDER BY model_version;
")

MSG="📊 *PM A/B Test Report*
$(date -u '+%Y-%m-%d %H:%M UTC')

*All Time (source=rust):*"

while IFS='|' read -r mv trades filled wins losses open pnl avg_size; do
  [ -z "$mv" ] && continue
  wr="0"
  total_resolved=$((wins + losses))
  [ "$total_resolved" -gt 0 ] && wr=$(echo "scale=1; $wins * 100 / $total_resolved" | bc)
  MSG="$MSG
▸ *${mv}*: ${trades} trades (${filled} filled)
  W/L: ${wins}/${losses} (${wr}%) | Open: ${open}
  PnL: \$${pnl} | Avg size: \$${avg_size}"
done <<< "$REPORT"

MSG="$MSG

*Today:*"

if [ -z "$TODAY_REPORT" ]; then
  MSG="$MSG
  No trades today"
else
  while IFS='|' read -r mv trades wins losses pnl; do
    [ -z "$mv" ] && continue
    MSG="$MSG
▸ *${mv}*: ${trades} trades, W/L ${wins}/${losses}, PnL \$${pnl}"
  done <<< "$TODAY_REPORT"
fi

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" \
    -d parse_mode="Markdown" \
    -d text="${MSG}" > /dev/null
  echo "Report sent to Telegram"
else
  echo "$MSG"
  echo "(Telegram not configured)"
fi
