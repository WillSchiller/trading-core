#!/bin/bash

set -e

echo "=================================="
echo "Grafana Dashboard Validation"
echo "=================================="
echo ""

echo "Running dashboard structure validation..."
npm test tests/unit/dashboards/dashboard-validator.test.ts

echo ""
echo "Running template variable validation..."
npm test tests/unit/dashboards/template-variable-validator.test.ts

echo ""
echo "Running SQL query validation..."
npm test tests/unit/dashboards/sql-query-validator.test.ts

echo ""
echo "=================================="
echo "All dashboard tests passed!"
echo "=================================="
