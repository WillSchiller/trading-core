# Grafana Dashboard Testing Guide

## Overview

The dashboard test suite prevents SQL syntax errors, template variable interpolation issues, and configuration problems in Grafana dashboards. This was implemented after a production bug with SQL syntax in template variable interpolation.

## Quick Start

```bash
# Run all dashboard tests
npm run test:dashboards

# Run specific test file
npm test tests/unit/dashboards/dashboard-validator.test.ts
npm test tests/unit/dashboards/template-variable-validator.test.ts
npm test tests/unit/dashboards/sql-query-validator.test.ts

# Run with database validation (optional)
POSTGRES_HOST=localhost npm run test:dashboards

# Run validation script
chmod +x scripts/validate-dashboards.sh
./scripts/validate-dashboards.sh
```

## Test Coverage

### 1. Dashboard Structure Validation
- Valid JSON format
- Required fields (uid, title, panels)
- Unique UIDs across dashboards
- Proper datasource references
- Panel layout and overlap detection

### 2. Template Variable Validation
- Variable query syntax (__value, __text aliases)
- Proper WHERE clauses and filtering
- includeAll and allValue configuration
- Variable dependency order
- Refresh settings
- Naming conventions (snake_case)

### 3. SQL Query Validation
- Template variable interpolation
  - No quotes around numeric IDs
  - Proper quotes around string values
  - ${var} syntax instead of $var
- Time filtering with Grafana macros
- Performance anti-patterns
  - Scanning quotes_raw without time filter
  - Using quotes_raw for aggregations (should use quote_rollups)
  - Missing LIMIT clauses
- Data correctness
  - NULL handling in aggregates
  - Proper column aliases (time, metric, value)
- JOIN correctness
  - Proper ON/USING clauses
  - Qualified column names

## Architecture

```
tests/unit/dashboards/
├── README.md                           # Test suite documentation
├── dashboard-validator.test.ts         # Core structure validation
├── template-variable-validator.test.ts # Variable-specific validation
└── sql-query-validator.test.ts         # SQL anti-pattern detection
```

### Helper Functions

All test files share common patterns:

```typescript
// Load all dashboards
async function loadDashboards(): Promise<Map<string, GrafanaDashboard>>

// Extract queries from panels
function extractQueries(dashboard: GrafanaDashboard): QueryInfo[]

// Extract template variables
function extractTemplateVariables(dashboard: GrafanaDashboard): TemplateVariable[]
```

## Common Issues and Fixes

### Issue 1: Numeric Variable Quoted in SQL

**Error:**
```
spreads.json: "Latest Spread" - pair_id is quoted but should be numeric
```

**Bad:**
```sql
WHERE pair_id = '${pair}'
```

**Good:**
```sql
WHERE pair_id = ${pair}
```

### Issue 2: String Variable Not Quoted

**Error:**
```
opportunities.json: "By Strategy" - strategy should be quoted in string comparison
```

**Bad:**
```sql
WHERE strategy = ${strategy}
```

**Good:**
```sql
WHERE strategy = '${strategy}'
```

### Issue 3: Missing includeAll Logic

**Error:**
```
executions.json: "Trade Feed" - variable ${pair} used without includeAll conditional logic
```

**Bad:**
```sql
WHERE pair_id = ${pair}
```

**Good:**
```sql
WHERE (${pair} = 0 OR pair_id = ${pair})
```

### Issue 4: Missing Time Filter

**Error:**
```
spreads.json: "Price History" - uses ts but missing time macros
```

**Bad:**
```sql
SELECT ts as time, mid FROM quotes_raw WHERE pair_id = 1
```

**Good:**
```sql
SELECT ts as time, mid FROM quotes_raw
WHERE ts BETWEEN $__timeFrom() AND $__timeTo()
  AND pair_id = 1
```

### Issue 5: Using quotes_raw for Aggregations

**Error:**
```
spreads.json: "Average Spread" - aggregates quotes_raw (should use quote_rollups for performance)
```

**Bad:**
```sql
SELECT DATE_TRUNC('minute', ts) as time, AVG(mid) as value
FROM quotes_raw
GROUP BY time
```

**Good:**
```sql
SELECT interval_start as time, close_mid as value
FROM quote_rollups
WHERE interval_type = '1m'
```

### Issue 6: Missing NULL Check in Aggregates

**Error:**
```
opportunities.json: "Average Spread" - uses AVG without NULL handling
```

**Bad:**
```sql
SELECT AVG(spread_bps) FROM opportunities
```

**Good:**
```sql
SELECT AVG(spread_bps) FROM opportunities
WHERE spread_bps IS NOT NULL
```

### Issue 7: Time Column Not Aliased

**Error:**
```
executions.json: "Trade Timeline" - selects detected_at but doesn't alias as 'time' for Grafana
```

**Bad:**
```sql
SELECT detected_at, spread_bps FROM opportunities
```

**Good:**
```sql
SELECT detected_at as time, spread_bps as value
FROM opportunities
```

## Database Validation

The test suite can validate SQL queries against a real PostgreSQL database to catch:
- Invalid table/column names
- Type mismatches
- Syntax errors

Enable by setting database environment variables:

```bash
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_DB=dislocation_trader
export POSTGRES_USER=trader
export POSTGRES_PASSWORD=your_password

npm run test:dashboards
```

If not set, SQL syntax validation is skipped with a warning (other tests still run).

## CI Integration

Dashboard tests run automatically with:

```bash
npm test
```

They are part of the `test:unit` suite since they don't require a running database (database validation is optional).

## Adding New Dashboards

1. Create dashboard JSON in `grafana/dashboards/`
2. Run validation tests:
   ```bash
   npm run test:dashboards
   ```
3. Fix any reported errors
4. Commit dashboard and test updates

## Test Development

### Adding New Validation Rules

1. Choose appropriate test file based on category:
   - `dashboard-validator.test.ts` - structure, datasources, panels
   - `template-variable-validator.test.ts` - variable configuration
   - `sql-query-validator.test.ts` - SQL patterns and anti-patterns

2. Follow the pattern of collecting errors and reporting all at once:

```typescript
it('should follow new rule', () => {
  const errors: string[] = [];

  for (const { file, panelTitle, query } of allQueries) {
    if (/* validation logic */) {
      errors.push(`${file}: "${panelTitle}" - clear error message`);
    }
  }

  expect(errors, errors.join('\n')).toHaveLength(0);
});
```

3. Include specific error messages with file name and panel title for debugging

### Test Organization

Tests are organized by concern:
- **Structure** - JSON format, required fields
- **Configuration** - datasources, variables, panels
- **SQL Syntax** - query correctness
- **SQL Semantics** - proper use of time filters, aggregates
- **Performance** - query efficiency, indexing
- **Grafana Conventions** - time/metric/value aliases, time_series format

## Known Limitations

1. SQL syntax validation requires database connection (optional feature)
2. Complex template variable expressions may need manual review
3. Dynamic SQL generation (CONCAT, etc.) may trigger false positives
4. Visualization config (colors, thresholds) not validated beyond basic structure
5. Panel queries using advanced Grafana features (transformations, etc.) may need special handling

## Troubleshooting

### Tests can't find dashboard files
- Run from project root: `/Users/will/dev/blockhelix/`
- Verify `grafana/dashboards/*.json` files exist

### SQL syntax validation skipped
- Expected if `POSTGRES_HOST` not set
- Other validations still run
- Set database env vars to enable

### False positive on valid query
- Review error message for specific issue
- Check if query uses advanced pattern not covered
- Add exception logic to test if pattern is valid
- Document in test comments

### Type errors in test files
- Run `npm run typecheck` to verify
- Tests use interfaces matching Grafana JSON schema
- Update interfaces if Grafana schema changes

## Performance Considerations

Tests are fast since they:
- Load dashboard JSON files once (beforeAll)
- Parse JSON in memory
- Only connect to database if explicitly enabled
- Run in parallel where possible

Typical execution time: < 1 second without database, < 5 seconds with database validation.

## Best Practices

### When Writing Dashboards

1. Always test locally before committing:
   ```bash
   npm run test:dashboards
   ```

2. Use template variables consistently:
   - Numeric: `${pair}` (no quotes)
   - String: `'${strategy}'` (with quotes)
   - includeAll: `(${pair} = 0 OR pair_id = ${pair})`

3. Always filter time-based queries:
   ```sql
   WHERE ts BETWEEN $__timeFrom() AND $__timeTo()
   ```

4. Use rollups for aggregations:
   - `quotes_raw` - only for recent raw data
   - `quote_rollups` - for aggregated time series

5. Alias columns for Grafana:
   - Time column: `as time`
   - Value column: `as value`
   - Series name: `as metric`

### When Modifying Tests

1. Keep error messages specific and actionable
2. Group related validations together
3. Test the tests - verify they catch actual bugs
4. Document why a validation exists (reference bug if applicable)
5. Consider performance impact of regex patterns

## Related Documentation

- [Grafana Dashboard JSON Model](https://grafana.com/docs/grafana/latest/dashboards/json-model/)
- [Grafana Template Variables](https://grafana.com/docs/grafana/latest/dashboards/variables/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Vitest Documentation](https://vitest.dev/)

## Maintenance

Review and update tests when:
- Grafana version is upgraded (schema changes)
- New query patterns are introduced
- Database schema changes (table/column names)
- New performance issues are discovered
- False positives become problematic

## Support

For issues or questions:
1. Check test output for specific error messages
2. Review test file comments for context
3. Check `tests/unit/dashboards/README.md` for examples
4. Review this guide for common issues
5. Check git history for recent dashboard changes
