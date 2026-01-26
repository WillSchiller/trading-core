# Grafana Dashboard Test Suite

This test suite validates all Grafana dashboard JSON files to prevent common issues with SQL syntax, template variable interpolation, and dashboard configuration.

## Test Files

### 1. `dashboard-validator.test.ts`
Core dashboard validation including:
- JSON structure and required fields
- Datasource configuration
- Template variable definitions
- Panel configuration and layout
- Basic SQL query validation
- SQL syntax validation with PostgreSQL (optional)

### 2. `template-variable-validator.test.ts`
Deep validation of template variables:
- Variable query patterns (__value, __text aliases)
- WHERE clauses and is_enabled filtering
- Custom variable format validation
- Multi-select and allValue configuration
- Variable dependency checking
- Refresh settings
- Naming conventions

### 3. `sql-query-validator.test.ts`
SQL anti-pattern detection:
- Template variable interpolation errors
- SQL injection prevention
- Time range handling
- Performance anti-patterns
- Data correctness issues
- Conditional logic for includeAll
- JOIN correctness
- Format and readability

## Running Tests

```bash
# Run all dashboard tests
npm run test:unit tests/unit/dashboards

# Run specific test file
npm test tests/unit/dashboards/dashboard-validator.test.ts

# Run with database validation (requires POSTGRES_HOST to be set)
POSTGRES_HOST=localhost npm test tests/unit/dashboards/dashboard-validator.test.ts

# Watch mode for development
npm run test:watch tests/unit/dashboards
```

## Common Issues Detected

### Template Variable Interpolation

**Problem:** Numeric IDs quoted in SQL
```sql
-- Bad: pair_id is an integer but wrapped in quotes
WHERE pair_id = '${pair}'

-- Good: no quotes for numeric comparison
WHERE pair_id = ${pair}
```

**Problem:** String comparison without quotes
```sql
-- Bad: string variable not quoted
WHERE strategy = ${strategy}

-- Good: string variable properly quoted
WHERE strategy = '${strategy}'
```

**Problem:** Bare $variable syntax
```sql
-- Bad: missing braces
WHERE pair_id = $pair

-- Good: use braces
WHERE pair_id = ${pair}
```

### includeAll Handling

**Problem:** Direct comparison without conditional logic
```sql
-- Bad: doesn't handle "All" selection
WHERE pair_id = ${pair}

-- Good: handles "All" with conditional
WHERE (${pair} = 0 OR pair_id = ${pair})
```

### Time Filtering

**Problem:** Missing time macros on time-based queries
```sql
-- Bad: no time filter
SELECT ts as time, mid FROM quotes_raw WHERE pair_id = 1

-- Good: uses Grafana time macros
SELECT ts as time, mid FROM quotes_raw
WHERE ts BETWEEN $__timeFrom() AND $__timeTo()
  AND pair_id = 1
```

### Performance Issues

**Problem:** Scanning quotes_raw without time filter
```sql
-- Bad: full table scan
SELECT * FROM quotes_raw WHERE pair_id = 1

-- Good: filtered by time
SELECT ts, mid FROM quotes_raw
WHERE ts BETWEEN $__timeFrom() AND $__timeTo()
  AND pair_id = 1
```

**Problem:** Using quotes_raw for aggregations
```sql
-- Bad: aggregating raw quotes (slow)
SELECT ts as time, AVG(mid) as value
FROM quotes_raw GROUP BY ts

-- Good: use pre-aggregated rollups
SELECT interval_start as time, close_mid as value
FROM quote_rollups
WHERE interval_type = '1s'
```

### NULL Handling

**Problem:** Aggregating without NULL checks
```sql
-- Bad: AVG includes NULLs
SELECT AVG(spread_bps) FROM opportunities

-- Good: explicit NULL filtering
SELECT AVG(spread_bps) FROM opportunities
WHERE spread_bps IS NOT NULL
```

### Grafana-specific Requirements

**Problem:** Time column not aliased as 'time'
```sql
-- Bad: Grafana won't recognize as time series
SELECT detected_at, spread_bps FROM opportunities

-- Good: aliased for Grafana
SELECT detected_at as time, spread_bps as value
FROM opportunities
```

**Problem:** Missing metric alias for multiple series
```sql
-- Bad: no series name
SELECT ts as time, mid as value
FROM quotes_raw JOIN venues v ON v.id = venue_id

-- Good: series named by venue
SELECT ts as time, mid as value, v.name as metric
FROM quotes_raw JOIN venues v ON v.id = venue_id
```

## Database Schema Validation

The test suite validates queries against the actual database schema when `POSTGRES_HOST` is set. This catches:

- Invalid table names
- Invalid column names
- Type mismatches
- Syntax errors

To enable database validation:

```bash
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_DB=dislocation_trader
export POSTGRES_USER=trader
export POSTGRES_PASSWORD=your_password

npm test tests/unit/dashboards/dashboard-validator.test.ts
```

If database credentials are not set, SQL syntax validation will be skipped with a warning.

## Adding New Dashboards

When adding new dashboard JSON files to `grafana/dashboards/`:

1. Run the test suite to validate
2. Fix any errors reported
3. Commit both the dashboard and any test updates

## Extending Tests

To add new validation rules:

1. Add test to appropriate file based on category
2. Use the existing helper functions to extract queries/variables
3. Follow the pattern of collecting errors and reporting them all at once
4. Include clear error messages with file name and panel title

Example:

```typescript
it('should follow new rule', () => {
  const errors: string[] = [];

  for (const { file, panelTitle, query } of allQueries) {
    if (/* condition */) {
      errors.push(`${file}: "${panelTitle}" - specific error message`);
    }
  }

  expect(errors, errors.join('\n')).toHaveLength(0);
});
```

## CI Integration

These tests run as part of the standard test suite:

```bash
npm test
```

All tests must pass before merging dashboard changes.

## Known Limitations

1. SQL syntax validation requires database connection (optional)
2. Complex template variable expressions may need manual review
3. Dynamic queries (e.g., CONCAT in WHERE) may trigger false positives
4. Test suite doesn't validate visualization configuration beyond basic structure

## Troubleshooting

### Test fails with "Cannot find dashboard files"
- Ensure you're running from project root
- Check that `grafana/dashboards/` exists and contains .json files

### SQL syntax validation skipped
- This is expected if POSTGRES_HOST is not set
- Tests will still run other validations

### False positive on template variable
- Review the specific error message
- Check if your query uses an advanced pattern not covered
- Consider adding exception logic to test if pattern is valid

## Resources

- [Grafana Dashboard JSON Schema](https://grafana.com/docs/grafana/latest/dashboards/json-model/)
- [Grafana Template Variables](https://grafana.com/docs/grafana/latest/dashboards/variables/)
- [PostgreSQL Query Syntax](https://www.postgresql.org/docs/current/sql-syntax.html)
