#!/bin/bash

set -e

echo "==================================="
echo "Timestamp Policy Validation Script"
echo "==================================="
echo ""

echo "1. Checking NTP Sync Status..."
if command -v chronyc &> /dev/null; then
    echo "   [chrony detected]"
    chronyc tracking | grep "System time" || echo "   Unable to get tracking info"
elif command -v timedatectl &> /dev/null; then
    echo "   [systemd-timesyncd detected]"
    timedatectl status | grep "System clock synchronized" || echo "   Unable to get sync status"
elif command -v ntpq &> /dev/null; then
    echo "   [ntpd detected]"
    ntpq -p | head -5 || echo "   Unable to get peer info"
else
    echo "   [WARNING] No NTP service detected"
fi
echo ""

echo "2. Checking Database Schema..."
if command -v psql &> /dev/null; then
    DB_HOST="${POSTGRES_HOST:-localhost}"
    DB_PORT="${POSTGRES_PORT:-5432}"
    DB_NAME="${POSTGRES_DB:-dislocation_trader}"
    DB_USER="${POSTGRES_USER:-trader}"

    echo "   Checking quotes_raw columns..."
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "\d quotes_raw" 2>/dev/null | grep -E "exchange_ts_ms|received_ts_ms|block_ts_ms" && echo "   ✓ Timestamp columns exist" || echo "   ✗ Missing timestamp columns - run migration sql/003_add_timestamp_columns.sql"

    echo "   Checking connector_health columns..."
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "\d connector_health" 2>/dev/null | grep -E "last_latency_ms|p95_latency_ms|invalid_ts_count|future_ts_count" && echo "   ✓ Latency tracking columns exist" || echo "   ✗ Missing latency columns - run migration sql/003_add_timestamp_columns.sql"
else
    echo "   [SKIP] psql not available"
fi
echo ""

echo "3. Checking TypeScript Files..."
if [ -f "src/utils/clock.ts" ]; then
    echo "   ✓ src/utils/clock.ts exists"
else
    echo "   ✗ src/utils/clock.ts missing"
fi

if grep -q "exchangeTsMs" "src/types/index.ts" 2>/dev/null; then
    echo "   ✓ NormalizedQuote type updated"
else
    echo "   ✗ NormalizedQuote type missing timestamp fields"
fi

if grep -q "timeAlignmentFilter" "src/detection/filters.ts" 2>/dev/null; then
    echo "   ✓ Time alignment filter implemented"
else
    echo "   ✗ Time alignment filter missing"
fi

if grep -q "fetchBlockWithTimestamp" "src/chain/block-watcher.ts" 2>/dev/null; then
    echo "   ✓ Block timestamp caching implemented"
else
    echo "   ✗ Block timestamp caching missing"
fi
echo ""

echo "4. Checking Configuration..."
if grep -q "maxFutureTsMs" "config/default.json" 2>/dev/null; then
    echo "   ✓ Timestamp validation config present"
else
    echo "   ✗ Missing timestamp validation config"
fi

if grep -q "maxTimeSkewMsBase" "config/default.json" 2>/dev/null; then
    echo "   ✓ Time alignment config present"
else
    echo "   ✗ Missing time alignment config"
fi
echo ""

echo "5. Checking Documentation..."
if [ -f "docs/TIMESTAMP_POLICY.md" ]; then
    echo "   ✓ docs/TIMESTAMP_POLICY.md exists"
else
    echo "   ✗ docs/TIMESTAMP_POLICY.md missing"
fi

if [ -f "IMPLEMENTATION_SUMMARY.md" ]; then
    echo "   ✓ IMPLEMENTATION_SUMMARY.md exists"
else
    echo "   ✗ IMPLEMENTATION_SUMMARY.md missing"
fi
echo ""

echo "6. Checking Database Migration..."
if [ -f "sql/003_add_timestamp_columns.sql" ]; then
    echo "   ✓ sql/003_add_timestamp_columns.sql exists"
else
    echo "   ✗ sql/003_add_timestamp_columns.sql missing"
fi
echo ""

echo "==================================="
echo "Validation Complete"
echo "==================================="
echo ""
echo "Next Steps:"
echo "1. Run database migration: psql ... < sql/003_add_timestamp_columns.sql"
echo "2. Build TypeScript: npm run build"
echo "3. Run tests: npm run test"
echo "4. Start application: npm run dev"
echo "5. Check logs for NTP sync status at startup"
echo "6. Monitor connector_health table for latency metrics"
echo ""
