import { describe, it, expect, beforeAll } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';

const DASHBOARD_DIR = resolve(process.cwd(), 'grafana/dashboards');
const REQUIRED_DATASOURCE_UID = 'postgresql';

interface GrafanaDashboard {
  id: null | number;
  uid: string;
  title: string;
  tags?: string[];
  timezone?: string;
  schemaVersion?: number;
  templating?: {
    list: TemplateVariable[];
  };
  panels: Panel[];
}

interface TemplateVariable {
  name: string;
  type: string;
  label?: string;
  datasource?: {
    type: string;
    uid: string;
  };
  definition?: string;
  query?: string;
  refresh?: number;
  multi?: boolean;
  includeAll?: boolean;
  allValue?: string;
  current?: Record<string, unknown>;
  options?: Array<{ text: string; value: string; selected?: boolean }>;
}

interface Panel {
  id: number;
  type: string;
  title: string;
  gridPos?: { x: number; y: number; w: number; h: number };
  targets?: Target[];
  datasource?: {
    type: string;
    uid: string;
  };
  panels?: Panel[];
}

interface Target {
  refId: string;
  datasource?: {
    type: string;
    uid: string;
  };
  rawSql?: string;
  format?: string;
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

function extractAllPanels(panels: Panel[]): Panel[] {
  const result: Panel[] = [];
  for (const panel of panels) {
    result.push(panel);
    if (panel.panels) {
      result.push(...extractAllPanels(panel.panels));
    }
  }
  return result;
}

function extractQueries(dashboard: GrafanaDashboard): Array<{ panelTitle: string; query: string }> {
  const allPanels = extractAllPanels(dashboard.panels || []);
  const queries: Array<{ panelTitle: string; query: string }> = [];

  for (const panel of allPanels) {
    if (panel.targets) {
      for (const target of panel.targets) {
        if (target.rawSql) {
          queries.push({
            panelTitle: panel.title,
            query: target.rawSql,
          });
        }
      }
    }
  }

  return queries;
}

function extractTemplateVariables(dashboard: GrafanaDashboard): TemplateVariable[] {
  return dashboard.templating?.list || [];
}

describe('Grafana Dashboard Validation', () => {
  let dashboards: Map<string, GrafanaDashboard>;

  beforeAll(async () => {
    dashboards = await loadDashboards();
  });

  describe('JSON Structure', () => {
    it('should load all dashboard files as valid JSON', () => {
      expect(dashboards.size).toBeGreaterThan(0);
    });

    it('should have required top-level fields', () => {
      for (const [file, dashboard] of dashboards) {
        expect(dashboard.uid, `${file}: missing uid`).toBeDefined();
        expect(dashboard.title, `${file}: missing title`).toBeDefined();
        expect(dashboard.panels, `${file}: missing panels`).toBeDefined();
        expect(Array.isArray(dashboard.panels), `${file}: panels not array`).toBe(true);
      }
    });

    it('should have unique UIDs across all dashboards', () => {
      const uids = new Set<string>();
      const duplicates: string[] = [];

      for (const [file, dashboard] of dashboards) {
        if (uids.has(dashboard.uid)) {
          duplicates.push(`${file} (uid: ${dashboard.uid})`);
        }
        uids.add(dashboard.uid);
      }

      expect(duplicates, `Duplicate UIDs found: ${duplicates.join(', ')}`).toHaveLength(0);
    });

    it('should have id set to null for provisioning', () => {
      for (const [file, dashboard] of dashboards) {
        expect(dashboard.id, `${file}: id should be null for provisioning`).toBeNull();
      }
    });

    it('should have dislocation-trader tag', () => {
      for (const [file, dashboard] of dashboards) {
        expect(
          dashboard.tags?.includes('dislocation-trader'),
          `${file}: missing dislocation-trader tag`
        ).toBe(true);
      }
    });
  });

  describe('Datasource Configuration', () => {
    it('should reference correct datasource UID in template variables', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = extractTemplateVariables(dashboard);
        for (const variable of variables) {
          if (variable.datasource) {
            expect(
              variable.datasource.uid,
              `${file}: variable ${variable.name} has incorrect datasource UID`
            ).toBe(REQUIRED_DATASOURCE_UID);
            expect(variable.datasource.type).toBe('postgres');
          }
        }
      }
    });

    it('should reference correct datasource UID in panel targets', () => {
      for (const [file, dashboard] of dashboards) {
        const allPanels = extractAllPanels(dashboard.panels);
        for (const panel of allPanels) {
          if (panel.targets) {
            for (const target of panel.targets) {
              if (target.datasource) {
                expect(
                  target.datasource.uid,
                  `${file}: panel "${panel.title}" has incorrect datasource UID`
                ).toBe(REQUIRED_DATASOURCE_UID);
                expect(target.datasource.type).toBe('postgres');
              }
            }
          }
        }
      }
    });
  });

  describe('Template Variables', () => {
    it('should have required fields for query variables', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = extractTemplateVariables(dashboard);
        for (const variable of variables) {
          if (variable.type === 'query') {
            expect(
              variable.datasource,
              `${file}: query variable ${variable.name} missing datasource`
            ).toBeDefined();
            expect(
              variable.definition || variable.query,
              `${file}: query variable ${variable.name} missing definition/query`
            ).toBeDefined();
          }
        }
      }
    });

    it('should have valid SQL in variable queries', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = extractTemplateVariables(dashboard);
        for (const variable of variables) {
          if (variable.type === 'query') {
            const sql = variable.definition || variable.query || '';
            expect(sql.trim(), `${file}: variable ${variable.name} has empty query`).not.toBe('');
            expect(
              sql.toLowerCase().includes('select'),
              `${file}: variable ${variable.name} query doesn't contain SELECT`
            ).toBe(true);
          }
        }
      }
    });

    it('should set allValue for includeAll variables', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = extractTemplateVariables(dashboard);
        for (const variable of variables) {
          if (variable.includeAll === true) {
            expect(
              variable.allValue,
              `${file}: variable ${variable.name} has includeAll but no allValue`
            ).toBeDefined();
          }
        }
      }
    });

    it('should have current and options initialized', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = extractTemplateVariables(dashboard);
        for (const variable of variables) {
          expect(
            variable.current !== undefined,
            `${file}: variable ${variable.name} missing current field`
          ).toBe(true);
          if (variable.type === 'custom') {
            expect(
              variable.options,
              `${file}: custom variable ${variable.name} missing options`
            ).toBeDefined();
          }
        }
      }
    });
  });

  describe('Panel Configuration', () => {
    it('should have unique panel IDs within each dashboard', () => {
      for (const [file, dashboard] of dashboards) {
        const allPanels = extractAllPanels(dashboard.panels);
        const ids = new Set<number>();
        const duplicates: number[] = [];

        for (const panel of allPanels) {
          if (ids.has(panel.id)) {
            duplicates.push(panel.id);
          }
          ids.add(panel.id);
        }

        expect(
          duplicates,
          `${file}: Duplicate panel IDs: ${duplicates.join(', ')}`
        ).toHaveLength(0);
      }
    });

    it('should have valid panel types', () => {
      const validTypes = [
        'timeseries',
        'stat',
        'table',
        'bargauge',
        'gauge',
        'piechart',
        'heatmap',
        'row',
        'text',
        'graph',
        'logs',
        'barchart',
      ];

      for (const [file, dashboard] of dashboards) {
        const allPanels = extractAllPanels(dashboard.panels);
        for (const panel of allPanels) {
          expect(
            validTypes.includes(panel.type),
            `${file}: panel "${panel.title}" has invalid type: ${panel.type}`
          ).toBe(true);
        }
      }
    });

    it('should have valid gridPos dimensions', () => {
      for (const [file, dashboard] of dashboards) {
        const allPanels = extractAllPanels(dashboard.panels);
        for (const panel of allPanels) {
          if (panel.gridPos) {
            expect(panel.gridPos.x, `${file}: panel "${panel.title}" has invalid x`).toBeGreaterThanOrEqual(0);
            expect(panel.gridPos.x, `${file}: panel "${panel.title}" x exceeds grid width`).toBeLessThan(24);
            expect(panel.gridPos.y, `${file}: panel "${panel.title}" has invalid y`).toBeGreaterThanOrEqual(0);
            expect(panel.gridPos.w, `${file}: panel "${panel.title}" has invalid width`).toBeGreaterThan(0);
            expect(panel.gridPos.w, `${file}: panel "${panel.title}" width exceeds grid`).toBeLessThanOrEqual(24);
            expect(panel.gridPos.h, `${file}: panel "${panel.title}" has invalid height`).toBeGreaterThan(0);
          }
        }
      }
    });

    it('should not have overlapping panels', () => {
      for (const [file, dashboard] of dashboards) {
        const panels = dashboard.panels.filter((p) => p.gridPos && p.type !== 'row');

        for (let i = 0; i < panels.length; i++) {
          for (let j = i + 1; j < panels.length; j++) {
            const p1 = panels[i].gridPos!;
            const p2 = panels[j].gridPos!;

            const overlaps =
              p1.x < p2.x + p2.w &&
              p1.x + p1.w > p2.x &&
              p1.y < p2.y + p2.h &&
              p1.y + p1.h > p2.y;

            expect(
              overlaps,
              `${file}: panels "${panels[i].title}" and "${panels[j].title}" overlap`
            ).toBe(false);
          }
        }
      }
    });
  });

  describe('SQL Query Validation', () => {
    it('should have non-empty SQL queries', () => {
      for (const [file, dashboard] of dashboards) {
        const queries = extractQueries(dashboard);
        for (const { panelTitle, query } of queries) {
          expect(
            query.trim(),
            `${file}: panel "${panelTitle}" has empty query`
          ).not.toBe('');
        }
      }
    });

    it('should use Grafana time macros correctly', () => {
      const validMacros = ['$__timeFrom()', '$__timeTo()', '$__timeFilter'];

      for (const [file, dashboard] of dashboards) {
        const queries = extractQueries(dashboard);
        for (const { panelTitle, query } of queries) {
          const hasTimeMacro = validMacros.some((macro) => query.includes(macro));
          const hasBetween = query.toUpperCase().includes('BETWEEN');
          const hasWhere = query.toUpperCase().includes('WHERE');

          if (hasWhere && hasBetween) {
            expect(
              hasTimeMacro,
              `${file}: panel "${panelTitle}" has BETWEEN but no time macro`
            ).toBe(true);
          }
        }
      }
    });

    it('should not have string-quoted numeric template variables in SQL', () => {
      const numericVariables = ['pair', 'pair_id', 'venue_id', 'chain_id'];

      for (const [file, dashboard] of dashboards) {
        const queries = extractQueries(dashboard);
        for (const { panelTitle, query } of queries) {
          for (const varName of numericVariables) {
            const badPattern1 = new RegExp(`'\\$\\{${varName}\\}'`, 'i');
            const badPattern2 = new RegExp(`"\\$\\{${varName}\\}"`, 'i');
            const allowedCoalescePattern = new RegExp(
              `COALESCE\\s*\\(\\s*NULLIF\\s*\\(\\s*'\\$\\{${varName}\\}'`, 'i'
            );
            const hasQuotedVar = badPattern1.test(query) || badPattern2.test(query);
            const isAllowedPattern = allowedCoalescePattern.test(query);

            expect(
              hasQuotedVar && !isAllowedPattern,
              `${file}: panel "${panelTitle}" has quoted numeric variable \${${varName}}`
            ).toBe(false);
          }
        }
      }
    });

    it('should use ${var} syntax not $var in SQL strings', () => {
      const stringVariables = ['strategy', 'direction', 'status'];

      for (const [file, dashboard] of dashboards) {
        const queries = extractQueries(dashboard);
        for (const { panelTitle, query } of queries) {
          for (const varName of stringVariables) {
            const goodPattern = `'\${${varName}}'`;
            const badPattern = `'$${varName}'`;

            if (query.includes(badPattern)) {
              expect(
                query.includes(goodPattern),
                `${file}: panel "${panelTitle}" uses $${varName} instead of \${${varName}}`
              ).toBe(true);
            }
          }
        }
      }
    });

    it('should reference valid table names', () => {
      const validTables = [
        'venues',
        'pairs',
        'pair_venue_config',
        'quotes_raw',
        'quote_rollups',
        'opportunities',
        'executions',
        'connector_health',
        'risk_state',
        'inventory_log',
        'slippage_calibration',
        'slippage_curves',
        'latest_slippage_curves',
        'pca_factor_models',
        'pca_signals',
        'pca_residuals',
        'v_pca_signal_performance',
        'v_pca_residual_stats',
        'v_pca_factor_history',
        'v_pca_mae_mfe',
        'v_pca_stop_analysis',
        'v_pca_mae_distribution',
        'v_pca_shadow_driver',
        'perps_executions',
        'perps_kill_switch_events',
        'v_perps_daily_pnl',
        'v_perps_open_positions',
        'v_perps_performance_by_asset',
      ];

      for (const [file, dashboard] of dashboards) {
        const queries = extractQueries(dashboard);
        for (const { panelTitle, query } of queries) {
          const cteNames = new Set<string>();
          const cteMatches = query.matchAll(/WITH\s+(\w+)\s+AS\s*\(/gi);
          for (const match of cteMatches) {
            cteNames.add(match[1].toLowerCase());
          }
          const additionalCteMatches = query.matchAll(/,\s*(\w+)\s+AS\s*\(/gi);
          for (const match of additionalCteMatches) {
            cteNames.add(match[1].toLowerCase());
          }

          const cleanQuery = query.replace(/EXTRACT\s*\([^)]*FROM\s+\w+\s*\)/gi, '');
          const fromMatch = cleanQuery.match(/FROM\s+(\w+)/gi);
          // Exclude LATERAL keyword from being treated as a table name
          const joinMatch = cleanQuery.match(/JOIN\s+(?!LATERAL\b)(\w+)/gi);

          const tables = [
            ...(fromMatch || []).map((m) => m.split(/\s+/).pop()!.toLowerCase()),
            ...(joinMatch || []).map((m) => m.split(/\s+/).pop()!.toLowerCase()),
          ];

          for (const table of tables) {
            if (cteNames.has(table)) continue;
            expect(
              validTables.includes(table),
              `${file}: panel "${panelTitle}" references unknown table: ${table}`
            ).toBe(true);
          }
        }
      }
    });

    it('should use table aliases in JOINs', () => {
      for (const [file, dashboard] of dashboards) {
        const queries = extractQueries(dashboard);
        for (const { panelTitle, query } of queries) {
          const joinCount = (query.match(/JOIN/gi) || []).length;
          if (joinCount > 0) {
            const hasAliases =
              query.match(/JOIN\s+\w+\s+[a-z]\d?\s+ON/gi) ||
              query.match(/FROM\s+\w+\s+[a-z]\d?\s+/gi);

            expect(
              hasAliases,
              `${file}: panel "${panelTitle}" has JOINs but no table aliases`
            ).toBeTruthy();
          }
        }
      }
    });

    it('should avoid SELECT * in queries', () => {
      for (const [file, dashboard] of dashboards) {
        const queries = extractQueries(dashboard);
        for (const { panelTitle, query } of queries) {
          const hasSelectStar = /SELECT\s+\*/i.test(query);
          expect(
            hasSelectStar,
            `${file}: panel "${panelTitle}" uses SELECT * (should specify columns)`
          ).toBe(false);
        }
      }
    });

    it('should order time series by time column', () => {
      for (const [file, dashboard] of dashboards) {
        const allPanels = extractAllPanels(dashboard.panels);
        for (const panel of allPanels) {
          if (panel.type === 'timeseries' && panel.targets) {
            for (const target of panel.targets) {
              if (target.rawSql) {
                const hasOrderBy = /ORDER BY/i.test(target.rawSql);
                if (hasOrderBy) {
                  const ordersTime = /ORDER BY.*?(time|ts|detected_at|created_at|confirmed_at)/i.test(
                    target.rawSql
                  );
                  expect(
                    ordersTime,
                    `${file}: panel "${panel.title}" doesn't order by time column`
                  ).toBe(true);
                }
              }
            }
          }
        }
      }
    });

    it('should use proper conditional logic for includeAll variables', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = extractTemplateVariables(dashboard);
        const includeAllVars = variables
          .filter((v) => v.includeAll === true)
          .map((v) => v.name);

        const queries = extractQueries(dashboard);
        for (const { panelTitle, query } of queries) {
          for (const varName of includeAllVars) {
            const hasVariable = query.includes(`\${${varName}}`) || query.includes(`\${${varName}:sqlstring}`);
            if (hasVariable) {
              const queryLower = query.toLowerCase();
              const hasConditional =
                query.includes(`\${${varName}} = 0 OR`) ||
                query.includes(`\${${varName}} IS NULL OR`) ||
                queryLower.includes(`'all'`) ||
                queryLower.includes(`= 'all'`);

              expect(
                hasConditional,
                `${file}: panel "${panelTitle}" uses includeAll variable \${${varName}} without conditional logic`
              ).toBe(true);
            }
          }
        }
      }
    });
  });

  describe('SQL Syntax Validation with PostgreSQL', () => {
    let pool: pg.Pool | null = null;

    beforeAll(() => {
      if (process.env.POSTGRES_HOST) {
        pool = new pg.Pool({
          host: process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.POSTGRES_PORT || '5432'),
          database: process.env.POSTGRES_DB || 'dislocation_trader',
          user: process.env.POSTGRES_USER || 'trader',
          password: process.env.POSTGRES_PASSWORD,
        });
      }
    });

    it('should validate SQL syntax using pg_prepare', async () => {
      if (!pool) {
        console.warn('Skipping SQL syntax validation: POSTGRES_HOST not set');
        return;
      }

      const errors: string[] = [];

      for (const [file, dashboard] of dashboards) {
        const queries = extractQueries(dashboard);

        for (const { panelTitle, query } of queries) {
          const preparedQuery = query
            .replace(/\$__timeFrom\(\)/g, "'2024-01-01 00:00:00'::timestamptz")
            .replace(/\$__timeTo\(\)/g, "'2024-01-01 01:00:00'::timestamptz")
            .replace(/\$__timeFilter\((\w+)\)/g, "$1 BETWEEN '2024-01-01 00:00:00'::timestamptz AND '2024-01-01 01:00:00'::timestamptz")
            .replace(/\$\{pair\}/g, '1')
            .replace(/\$\{strategy\}/g, "'all'")
            .replace(/\$\{venue_id\}/g, '1')
            .replace(/\$\{chain\}/g, "'base'")
            .replace(/\$\{direction\}/g, "'buy_dex'")
            .replace(/\$\{status\}/g, "'detected'")
            .replace(/\$\{mode\}/g, 'All')
            .replace(/\$\{run_id:sqlstring\}/g, "'hl_live'")
            .replace(/\$\{run_id\}/g, "'hl_live'");

          try {
            await pool.query(`PREPARE test_query AS ${preparedQuery}`);
            await pool.query('DEALLOCATE test_query');
          } catch (error) {
            const err = error as Error;
            errors.push(`${file}: panel "${panelTitle}" - ${err.message}`);
          }
        }
      }

      if (errors.length > 0) {
        throw new Error(`SQL syntax errors found:\n${errors.join('\n')}`);
      }
    });
  });
});
