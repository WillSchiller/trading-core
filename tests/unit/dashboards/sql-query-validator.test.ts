import { describe, it, expect, beforeAll } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DASHBOARD_DIR = resolve(process.cwd(), 'grafana/dashboards');

interface GrafanaDashboard {
  uid: string;
  title: string;
  panels: Panel[];
}

interface Panel {
  id: number;
  type: string;
  title: string;
  targets?: Target[];
  panels?: Panel[];
}

interface Target {
  refId: string;
  rawSql?: string;
}

interface QueryInfo {
  file: string;
  panelTitle: string;
  query: string;
  refId: string;
}

async function loadDashboards(): Promise<Map<string, GrafanaDashboard>> {
  const files = await readdir(DASHBOARD_DIR);
  const dashboards = new Map<string, GrafanaDashboard>();

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const content = await readFile(join(DASHBOARD_DIR, file), 'utf-8');
    const dashboard = JSON.parse(content) as GrafanaDashboard;
    dashboards.set(file, dashboard);
  }

  return dashboards;
}

function extractAllQueries(dashboards: Map<string, GrafanaDashboard>): QueryInfo[] {
  const queries: QueryInfo[] = [];

  function extractFromPanel(panel: Panel, file: string): void {
    if (panel.targets) {
      for (const target of panel.targets) {
        if (target.rawSql) {
          queries.push({
            file,
            panelTitle: panel.title,
            query: target.rawSql,
            refId: target.refId,
          });
        }
      }
    }

    if (panel.panels) {
      for (const subPanel of panel.panels) {
        extractFromPanel(subPanel, file);
      }
    }
  }

  for (const [file, dashboard] of dashboards) {
    for (const panel of dashboard.panels || []) {
      extractFromPanel(panel, file);
    }
  }

  return queries;
}

describe('SQL Query Anti-Pattern Detection', () => {
  let dashboards: Map<string, GrafanaDashboard>;
  let allQueries: QueryInfo[];

  beforeAll(async () => {
    dashboards = await loadDashboards();
    allQueries = extractAllQueries(dashboards);
  });

  describe('Template Variable Interpolation Errors', () => {
    it('should not quote numeric IDs in WHERE clauses', () => {
      const numericFields = ['pair_id', 'venue_id', 'id', 'opportunity_id', 'chain_id'];
      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        for (const field of numericFields) {
          const quotedPattern = new RegExp(`${field}\\s*=\\s*['"]\\$\\{\\w+\\}['"]`, 'gi');
          if (quotedPattern.test(query)) {
            errors.push(`${file}: "${panelTitle}" - ${field} is quoted but should be numeric`);
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should not use bare $variable syntax in SQL', () => {
      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        const bareVarPattern = /\$[a-zA-Z_]\w*(?!\(|_)/g;
        const matches = query.match(bareVarPattern) || [];

        const actualBareVars = matches.filter(
          (match) => !match.startsWith('$__') && match !== '$$'
        );

        if (actualBareVars.length > 0) {
          errors.push(
            `${file}: "${panelTitle}" - uses bare variables: ${actualBareVars.join(', ')}`
          );
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should properly escape single quotes in string literals', () => {
      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        const singleQuotes = query.split("'");

        for (let i = 1; i < singleQuotes.length - 1; i += 2) {
          const stringContent = singleQuotes[i];
          if (stringContent.includes("'") && !stringContent.includes("''")) {
            const hasVariable = /\$\{/.test(stringContent);
            if (!hasVariable) {
              errors.push(
                `${file}: "${panelTitle}" - unescaped single quote in string: '${stringContent}'`
              );
            }
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should use template variable syntax for string comparison', () => {
      const errors: string[] = [];
      const stringVariables = ['strategy', 'direction', 'status', 'chain', 'venue_type'];

      for (const { file, panelTitle, query } of allQueries) {
        for (const varName of stringVariables) {
          const goodPattern = `'\${${varName}}'`;
          const badPattern = new RegExp(`=\\s*\\\${${varName}}\\b`, 'g');

          if (badPattern.test(query) && !query.includes(goodPattern)) {
            errors.push(
              `${file}: "${panelTitle}" - \${${varName}} should be quoted in string comparison`
            );
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });
  });

  describe('SQL Injection Prevention', () => {
    it('should not concatenate user input directly into SQL', () => {
      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        const hasConcatenation = /\|\|/.test(query);
        const hasVariableInConcat = /\|\|.*\$\{|\$\{.*\|\|/.test(query);

        if (hasConcatenation && hasVariableInConcat) {
          const hasQuotes = /'\$\{.*\}'/.test(query);
          if (!hasQuotes) {
            errors.push(
              `${file}: "${panelTitle}" - concatenates unquoted variable (potential SQL injection)`
            );
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });
  });

  describe('Time Range Handling', () => {
    it('should use time macros instead of hard-coded dates', () => {
      const errors: string[] = [];
      const hardCodedDatePattern = /('|")\d{4}-\d{2}-\d{2}/;

      for (const { file, panelTitle, query } of allQueries) {
        if (hardCodedDatePattern.test(query)) {
          const hasTimeMacro = /\$__time(From|To)/.test(query);
          if (!hasTimeMacro) {
            errors.push(`${file}: "${panelTitle}" - uses hard-coded date instead of time macro`);
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should use BETWEEN with time macros for time filtering', () => {
      const errors: string[] = [];
      const timeColumns = ['ts', 'detected_at', 'created_at', 'confirmed_at', 'submitted_at', 'interval_start'];
      const allowedFixedTimePatterns = [
        /NOW\s*\(\)\s*-\s*INTERVAL/i,
        /CURRENT_TIMESTAMP/i,
        />\s*NOW\s*\(\)/i,
        /<\s*NOW\s*\(\)/i,
        /BETWEEN.*NOW/i,
        /interval\s+'\d+/i,
      ];

      for (const { file, panelTitle, query } of allQueries) {
        for (const col of timeColumns) {
          const hasColumn = new RegExp(`\\b${col}\\b`, 'i').test(query);
          if (hasColumn && query.toUpperCase().includes('WHERE')) {
            const hasProperTimeFilter =
              query.includes('$__timeFrom()') || query.includes('$__timeTo()');
            const hasFixedTimeRange = allowedFixedTimePatterns.some(p => p.test(query));
            const isSubqueryOrWindow = /OVER\s*\(|LAG\s*\(|LEAD\s*\(|ROW_NUMBER/i.test(query);
            const isSelectOnly = new RegExp(`SELECT[^;]*\\b${col}\\b[^;]*FROM`, 'is').test(query) &&
              !new RegExp(`WHERE[^;]*\\b${col}\\b`, 'is').test(query);
            const hasLimit = /LIMIT\s+\d+/i.test(query);
            const hasOrderByDesc = /ORDER BY.*DESC/i.test(query);
            const isLatestQuery = hasLimit && hasOrderByDesc;
            const isFreshnessCheck = /\(\s*SELECT\s+(MAX|MIN)\s*\(\s*ts\s*\)\s*FROM/i.test(query);

            if (!hasProperTimeFilter && !hasFixedTimeRange && !isSubqueryOrWindow && !isSelectOnly && !isLatestQuery && !isFreshnessCheck) {
              errors.push(
                `${file}: "${panelTitle}" - uses ${col} but missing time macros`
              );
            }
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });
  });

  describe('Performance Anti-Patterns', () => {
    it('should not scan quotes_raw without time filter', () => {
      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        if (query.toLowerCase().includes('quotes_raw')) {
          const hasTimeFilter =
            query.includes('$__timeFrom()') ||
            query.includes('$__timeTo()') ||
            /ts\s*(>|<|>=|<=|BETWEEN)/i.test(query) ||
            /NOW\s*\(\)\s*-\s*INTERVAL/i.test(query) ||
            /INTERVAL\s+'\d+/i.test(query) ||
            /LIMIT\s+\d+/i.test(query);
          const isSubquery = /\(\s*SELECT\s+MAX\s*\(.*\)\s+FROM\s+quotes_raw/i.test(query) ||
            /\(\s*SELECT\s+MIN\s*\(.*\)\s+FROM\s+quotes_raw/i.test(query);
          const isAggregateOnly = /SELECT\s+.*\bMAX\s*\(\s*ts\s*\)/i.test(query) ||
            /SELECT\s+.*\bMIN\s*\(\s*ts\s*\)/i.test(query);

          if (!hasTimeFilter && !isSubquery && !isAggregateOnly) {
            errors.push(
              `${file}: "${panelTitle}" - queries quotes_raw without time filter (performance issue)`
            );
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should use quote_rollups for time series instead of quotes_raw when appropriate', () => {
      const errors: string[] = [];
      const legitRawQuoteFields = ['latency_ms', 'observed_at', 'clock_drift', 'skew', 'alignment', 'rate', 'count', 'quotes_per'];

      for (const { file, panelTitle, query } of allQueries) {
        const usesRawQuotes = query.toLowerCase().includes('quotes_raw');
        const isTimeSeries = query.toLowerCase().includes('as time');
        const hasAggregation = /\b(avg|sum|min|max)\s*\(/i.test(query);
        const needsRawData = legitRawQuoteFields.some(f => query.toLowerCase().includes(f));
        const isCountingQuery = /COUNT\s*\(\s*\*\s*\)/i.test(query);

        if (usesRawQuotes && isTimeSeries && hasAggregation && !needsRawData && !isCountingQuery) {
          errors.push(
            `${file}: "${panelTitle}" - aggregates quotes_raw (should use quote_rollups for performance)`
          );
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should include LIMIT for table panels', () => {
      const errors: string[] = [];
      const smallTables = ['connector_health', 'risk_state', 'slippage_calibration', 'latest_slippage_curves', 'venues', 'pairs', 'pair_venue_config'];

      for (const { file, panelTitle, query } of allQueries) {
        const hasLimit = /LIMIT\s+\d+/i.test(query);
        const hasOrderBy = /ORDER BY/i.test(query);
        const hasTimeFilter = query.includes('$__timeFrom()') || query.includes('$__timeTo()');
        const isTimeSeries = /format.*time_series/i.test(query) || /as\s+time\b/i.test(query);
        const hasGroupBy = /GROUP BY/i.test(query);
        const isWindowFunction = /OVER\s*\(/i.test(query);
        const usesSmallTable = smallTables.some(t =>
          new RegExp(`FROM\\s+${t}\\b`, 'i').test(query) &&
          !query.toLowerCase().includes('quotes_raw') &&
          !query.toLowerCase().includes('opportunities') &&
          !query.toLowerCase().includes('executions')
        );
        const hasDistinctOn = /DISTINCT ON/i.test(query);
        const hasPercentile = /percentile_cont|percentile_disc/i.test(query);
        const isSubqueryBounded = /\(\s*SELECT\s+[^)]+WHERE[^)]+\)/i.test(query);

        if (hasOrderBy && !hasLimit && !hasTimeFilter && !isTimeSeries && !hasGroupBy && !isWindowFunction && !usesSmallTable && !hasDistinctOn && !hasPercentile && !isSubqueryBounded) {
          errors.push(
            `${file}: "${panelTitle}" - has ORDER BY but no LIMIT (could return too many rows)`
          );
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should use indexed columns in WHERE clauses', () => {
      const indexedColumns = [
        'id',
        'venue_id',
        'pair_id',
        'ts',
        'detected_at',
        'created_at',
        'confirmed_at',
        'status',
        'opportunity_id',
        'chain',
        'direction',
        'strategy',
        'trade_size_usd',
      ];
      const smallTables = ['connector_health', 'risk_state', 'slippage_calibration', 'latest_slippage_curves', 'venues', 'pairs', 'pair_venue_config'];

      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        if (query.toUpperCase().includes('WHERE')) {
          const hasIndexedFilter = indexedColumns.some((col) => {
            const eqPattern = new RegExp(`WHERE.*\\b${col}\\b.*=`, 'i');
            const betweenPattern = new RegExp(`\\b${col}\\b\\s+(BETWEEN|>|<|>=|<=)`, 'i');
            const inPattern = new RegExp(`\\b${col}\\b\\s+IN\\s*\\(`, 'i');
            return eqPattern.test(query) || betweenPattern.test(query) || inPattern.test(query);
          });
          const hasTimeMacro = query.includes('$__timeFrom()') || query.includes('$__timeTo()');
          const hasIntervalFilter = /NOW\s*\(\)\s*-\s*INTERVAL/i.test(query);
          const usesSmallTable = smallTables.some(t => new RegExp(`FROM\\s+${t}\\b`, 'i').test(query));
          const hasSubquery = /WHERE.*IN\s*\(\s*SELECT/i.test(query);

          if (!hasIndexedFilter && !hasTimeMacro && !hasIntervalFilter && !usesSmallTable && !hasSubquery) {
            errors.push(
              `${file}: "${panelTitle}" - WHERE clause doesn't use indexed columns (performance warning)`
            );
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });
  });

  describe('Data Correctness', () => {
    it('should handle NULL values explicitly when aggregating', () => {
      const errors: string[] = [];
      for (const { file, panelTitle, query } of allQueries) {
        const hasTopLevelSum = /SELECT\s+SUM\s*\([^)]+\)\s*$/i.test(query);
        const isCumulativeQuery = /SUM\s*\([^)]+\)\s*OVER\s*\(/i.test(query);
        const hasFilterClause = /FILTER\s*\(\s*WHERE/i.test(query);

        if (hasTopLevelSum && !isCumulativeQuery && !hasFilterClause) {
          const hasNullProtection =
            query.includes('COALESCE') || query.includes('IS NOT NULL');
          if (!hasNullProtection) {
            errors.push(
              `${file}: "${panelTitle}" - top-level SUM without COALESCE may return NULL when no rows match`
            );
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should use appropriate aliases for time columns in time series', () => {
      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        // Only check time series queries (those with time bucketing)
        const isTimeSeries =
          /time_bucket|date_trunc|date_bin/i.test(query) ||
          (/GROUP BY/i.test(query) && /ORDER BY.*time/i.test(query));

        if (!isTimeSeries) continue;

        const timeColumns = ['ts', 'detected_at', 'created_at', 'confirmed_at', 'interval_start'];
        const hasTimeAlias = /\s+as\s+time\b/i.test(query);

        for (const col of timeColumns) {
          const isInSelect = new RegExp(`SELECT[^;]*\\b${col}\\b`, 'is').test(query);
          if (isInSelect && !hasTimeAlias) {
            errors.push(
              `${file}: "${panelTitle}" - time series selects ${col} but doesn't alias as 'time'`
            );
            break;
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should use proper column aliases for metric series', () => {
      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        if (query.toLowerCase().includes('time_series')) {
          const hasMetricAlias = /\s+as\s+metric\b/i.test(query);

          const isMultiSeries =
            query.toLowerCase().includes('join') ||
            /\b(name|canonical|direction|strategy)\b/i.test(query);

          if (isMultiSeries && !hasMetricAlias) {
            errors.push(
              `${file}: "${panelTitle}" - time_series format but no 'metric' alias for series name`
            );
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });
  });

  describe('Conditional Logic for includeAll', () => {
    it('should handle "All" selection properly', () => {
      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        const variableRefs = query.match(/\$\{(\w+)\}/g) || [];

        for (const ref of variableRefs) {
          const varName = ref.slice(2, -1);

          if (query.includes(ref)) {
            const hasConditional =
              new RegExp(`\\(\\s*\\\${${varName}}\\s*=\\s*0\\s*OR`, 'i').test(query) ||
              new RegExp(`\\(\\s*\\\${${varName}}\\s*=\\s*'0'\\s*OR`, 'i').test(query) ||
              new RegExp(`\\(\\s*'\\$\\{${varName}\\}'\\s*=\\s*'all'\\s*OR`, 'i').test(query);

            const isDirectComparison = new RegExp(`=\\s*\\\${${varName}}(?!\\))`, 'i').test(query);

            if (isDirectComparison && !hasConditional && !query.includes("'all'")) {
              errors.push(
                `${file}: "${panelTitle}" - variable \${${varName}} used without includeAll conditional logic`
              );
            }
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });
  });

  describe('Join Correctness', () => {
    it('should use proper JOIN conditions', () => {
      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        const joinMatches = query.match(/JOIN\s+\w+.*?(?=JOIN|WHERE|ORDER|GROUP|$)/gis);

        if (joinMatches) {
          for (const joinClause of joinMatches) {
            const hasOn = /\bON\b/i.test(joinClause);
            const hasUsing = /\bUSING\b/i.test(joinClause);

            if (!hasOn && !hasUsing) {
              errors.push(
                `${file}: "${panelTitle}" - JOIN without ON or USING clause: ${joinClause.slice(0, 50)}`
              );
            }
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should qualify ambiguous columns in JOINs', () => {
      const errors: string[] = [];
      const commonColumns = ['id', 'name', 'created_at', 'chain'];

      for (const { file, panelTitle, query } of allQueries) {
        const hasJoin = /\bJOIN\b/i.test(query);

        if (hasJoin) {
          for (const col of commonColumns) {
            const pattern = new RegExp(`\\bSELECT\\b[^;]*\\b${col}\\b[^;]*\\bFROM\\b`, 'is');
            const hasColumn = pattern.test(query);

            if (hasColumn) {
              const isQualified = new RegExp(`\\b[a-z]+\\d?\\.${col}\\b`, 'i').test(query);
              if (!isQualified) {
                errors.push(
                  `${file}: "${panelTitle}" - ambiguous column '${col}' in JOIN (should be qualified with table alias)`
                );
              }
            }
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });
  });

  describe('Format and Readability', () => {
    it('should use consistent keyword casing', () => {
      const errors: string[] = [];
      const keywords = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'ORDER BY', 'GROUP BY'];

      for (const { file, panelTitle, query } of allQueries) {
        let uppercaseCount = 0;
        let lowercaseCount = 0;

        for (const keyword of keywords) {
          if (query.includes(keyword)) uppercaseCount++;
          if (query.includes(keyword.toLowerCase())) lowercaseCount++;
        }

        if (uppercaseCount > 0 && lowercaseCount > 0) {
          errors.push(
            `${file}: "${panelTitle}" - inconsistent SQL keyword casing (mix of upper/lowercase)`
          );
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });
  });
});
