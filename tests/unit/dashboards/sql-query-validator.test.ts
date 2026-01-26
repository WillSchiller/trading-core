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

      for (const { file, panelTitle, query } of allQueries) {
        for (const col of timeColumns) {
          const hasColumn = new RegExp(`\\b${col}\\b`, 'i').test(query);
          if (hasColumn && query.toUpperCase().includes('WHERE')) {
            const hasProperTimeFilter =
              query.includes('$__timeFrom()') || query.includes('$__timeTo()');

            if (!hasProperTimeFilter) {
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
            /ts\s*(>|<|>=|<=|BETWEEN)/.test(query);

          if (!hasTimeFilter) {
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

      for (const { file, panelTitle, query } of allQueries) {
        const usesRawQuotes = query.toLowerCase().includes('quotes_raw');
        const isTimeSeries = query.toLowerCase().includes('as time');
        const hasAggregation = /\b(avg|sum|count|min|max)\s*\(/i.test(query);

        if (usesRawQuotes && isTimeSeries && hasAggregation) {
          errors.push(
            `${file}: "${panelTitle}" - aggregates quotes_raw (should use quote_rollups for performance)`
          );
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should include LIMIT for table panels', () => {
      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        const hasLimit = /LIMIT\s+\d+/i.test(query);
        const hasOrderBy = /ORDER BY/i.test(query);

        if (hasOrderBy && !hasLimit) {
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
      ];

      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        if (query.toUpperCase().includes('WHERE')) {
          const hasIndexedFilter = indexedColumns.some((col) => {
            const pattern = new RegExp(`WHERE.*\\b${col}\\b.*=`, 'i');
            return pattern.test(query);
          });

          if (!hasIndexedFilter) {
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
      const aggregates = ['AVG', 'SUM', 'MIN', 'MAX'];

      for (const { file, panelTitle, query } of allQueries) {
        for (const agg of aggregates) {
          const aggPattern = new RegExp(`${agg}\\s*\\([^)]+\\)`, 'gi');
          const matches = query.match(aggPattern);

          if (matches) {
            const hasNullCheck =
              query.includes('IS NOT NULL') ||
              query.includes('COALESCE') ||
              query.includes('NULLIF');

            if (!hasNullCheck && !query.includes('COUNT(*)')) {
              errors.push(
                `${file}: "${panelTitle}" - uses ${agg} without NULL handling (may produce unexpected results)`
              );
              break;
            }
          }
        }
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });

    it('should use appropriate aliases for time columns', () => {
      const errors: string[] = [];

      for (const { file, panelTitle, query } of allQueries) {
        const timeColumns = ['ts', 'detected_at', 'created_at', 'confirmed_at', 'interval_start'];

        for (const col of timeColumns) {
          const hasTimeColumn = new RegExp(`\\b${col}\\b`, 'i').test(query);
          const hasTimeAlias = /\s+as\s+time\b/i.test(query);

          if (hasTimeColumn && query.toUpperCase().includes('SELECT')) {
            const isInSelect = new RegExp(`SELECT[^;]*\\b${col}\\b`, 'is').test(query);
            if (isInSelect && !hasTimeAlias) {
              errors.push(
                `${file}: "${panelTitle}" - selects ${col} but doesn't alias as 'time' for Grafana`
              );
              break;
            }
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
              const isQualified = new RegExp(`\\b[a-z]\\d?\\.${col}\\b`, 'i').test(query);
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
