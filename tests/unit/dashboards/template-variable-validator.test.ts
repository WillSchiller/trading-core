import { describe, it, expect, beforeAll } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DASHBOARD_DIR = resolve(process.cwd(), 'grafana/dashboards');

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

interface GrafanaDashboard {
  uid: string;
  title: string;
  templating?: {
    list: TemplateVariable[];
  };
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

describe('Template Variable Deep Validation', () => {
  let dashboards: Map<string, GrafanaDashboard>;

  beforeAll(async () => {
    dashboards = await loadDashboards();
  });

  describe('Variable Query Patterns', () => {
    it('should use __value and __text aliases in query variables', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];

        for (const variable of variables) {
          if (variable.type === 'query' && variable.definition) {
            const sql = variable.definition.toLowerCase();

            if (sql.includes('select')) {
              const hasValueAlias = sql.includes('__value');
              const hasTextAlias = sql.includes('__text');

              expect(
                hasValueAlias,
                `${file}: variable "${variable.name}" missing __value alias`
              ).toBe(true);

              expect(
                hasTextAlias,
                `${file}: variable "${variable.name}" missing __text alias`
              ).toBe(true);
            }
          }
        }
      }
    });

    it('should use proper WHERE clauses in variable queries', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];

        for (const variable of variables) {
          if (variable.type === 'query' && variable.definition) {
            const sql = variable.definition;

            if (sql.toLowerCase().includes('where')) {
              expect(
                sql.includes('is_enabled = true') || sql.includes('is_enabled=true'),
                `${file}: variable "${variable.name}" doesn't filter by is_enabled`
              ).toBe(true);
            }
          }
        }
      }
    });

    it('should order results in variable queries', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];

        for (const variable of variables) {
          if (variable.type === 'query' && variable.definition) {
            const sql = variable.definition.toLowerCase();

            if (sql.includes('select') && !sql.includes('count(')) {
              const hasOrderBy = sql.includes('order by');
              expect(
                hasOrderBy,
                `${file}: variable "${variable.name}" missing ORDER BY clause`
              ).toBe(true);
            }
          }
        }
      }
    });
  });

  describe('Custom Variables', () => {
    it('should have valid query format for custom variables', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];

        for (const variable of variables) {
          if (variable.type === 'custom' && variable.query) {
            const parts = variable.query.split(',').map((p) => p.trim());

            for (const part of parts) {
              const colonCount = (part.match(/:/g) || []).length;
              expect(
                colonCount,
                `${file}: custom variable "${variable.name}" has invalid format: "${part}"`
              ).toBe(1);

              const [value, text] = part.split(':').map((p) => p.trim());
              expect(value, `${file}: custom variable "${variable.name}" has empty value`).not.toBe('');
              expect(text, `${file}: custom variable "${variable.name}" has empty text`).not.toBe('');
            }
          }
        }
      }
    });

    it('should have matching options for custom variables', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];

        for (const variable of variables) {
          if (variable.type === 'custom' && variable.query && variable.options) {
            const queryParts = variable.query.split(',').map((p) => p.trim());
            expect(
              variable.options.length,
              `${file}: custom variable "${variable.name}" options count doesn't match query`
            ).toBe(queryParts.length);

            for (let i = 0; i < queryParts.length; i++) {
              const [expectedValue, expectedText] = queryParts[i].split(':').map((p) => p.trim());
              const option = variable.options[i];

              expect(
                option.value,
                `${file}: custom variable "${variable.name}" option ${i} value mismatch`
              ).toBe(expectedValue);

              expect(
                option.text,
                `${file}: custom variable "${variable.name}" option ${i} text mismatch`
              ).toBe(expectedText);
            }
          }
        }
      }
    });
  });

  describe('Multi-select Variables', () => {
    it('should have proper allValue for multi-select variables', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];

        for (const variable of variables) {
          if (variable.multi === true && variable.includeAll === true) {
            expect(
              variable.allValue,
              `${file}: multi-select variable "${variable.name}" missing allValue`
            ).toBeDefined();

            const dashboardJson = JSON.stringify(dashboard);
            const usesEmptyStringCheck = dashboardJson.includes(`\${${variable.name}:raw}' = ''`);
            if (!usesEmptyStringCheck) {
              expect(
                variable.allValue,
                `${file}: multi-select variable "${variable.name}" has empty allValue`
              ).not.toBe('');
            }
          }
        }
      }
    });
  });

  describe('Variable References in Queries', () => {
    it('should only reference defined variables', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];
        const variableNames = new Set(variables.map((v) => v.name));

        const content = JSON.stringify(dashboard);
        const variableRefs = content.match(/\$\{(\w+)\}/g) || [];

        for (const ref of variableRefs) {
          const varName = ref.slice(2, -1);

          expect(
            variableNames.has(varName),
            `${file}: references undefined variable: \${${varName}}`
          ).toBe(true);
        }
      }
    });

    it('should not have dollar sign variables without braces', () => {
      for (const [file, dashboard] of dashboards) {
        const content = JSON.stringify(dashboard);

        const badRefs = content.match(/"[^"]*\$[a-zA-Z_]\w*[^{][^"]*"/g) || [];

        const actualBadRefs = badRefs.filter((ref) => {
          return (
            !ref.includes('${') &&
            !ref.includes('$__') &&
            !ref.includes('$$')
          );
        });

        expect(
          actualBadRefs,
          `${file}: has dollar sign variables without braces: ${actualBadRefs.join(', ')}`
        ).toHaveLength(0);
      }
    });
  });

  describe('Variable Dependencies', () => {
    it('should not have circular dependencies', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];

        for (const variable of variables) {
          if (variable.type === 'query' && variable.definition) {
            const referencedVars = (variable.definition.match(/\$\{(\w+)\}/g) || []).map((ref) =>
              ref.slice(2, -1)
            );

            expect(
              referencedVars.includes(variable.name),
              `${file}: variable "${variable.name}" references itself`
            ).toBe(false);
          }
        }
      }
    });

    it('should define variables before they are referenced', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];
        const definedVars = new Set<string>();

        for (const variable of variables) {
          if (variable.type === 'query' && variable.definition) {
            const referencedVars = (variable.definition.match(/\$\{(\w+)\}/g) || []).map((ref) =>
              ref.slice(2, -1)
            );

            for (const refVar of referencedVars) {
              expect(
                definedVars.has(refVar),
                `${file}: variable "${variable.name}" references "${refVar}" before it's defined`
              ).toBe(true);
            }
          }

          definedVars.add(variable.name);
        }
      }
    });
  });

  describe('Refresh Settings', () => {
    it('should have refresh set for query variables', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];

        for (const variable of variables) {
          if (variable.type === 'query') {
            expect(
              variable.refresh,
              `${file}: query variable "${variable.name}" missing refresh setting`
            ).toBeDefined();

            const validRefreshValues = [0, 1, 2];
            expect(
              validRefreshValues.includes(variable.refresh!),
              `${file}: variable "${variable.name}" has invalid refresh value: ${variable.refresh}`
            ).toBe(true);
          }
        }
      }
    });
  });

  describe('Label Configuration', () => {
    it('should have readable labels for all variables', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];

        for (const variable of variables) {
          expect(
            variable.label,
            `${file}: variable "${variable.name}" missing label`
          ).toBeDefined();

          expect(
            variable.label!.length,
            `${file}: variable "${variable.name}" has empty label`
          ).toBeGreaterThan(0);

          const isCapitalized = /^[A-Z]/.test(variable.label!);
          expect(
            isCapitalized,
            `${file}: variable "${variable.name}" label should be capitalized: "${variable.label}"`
          ).toBe(true);
        }
      }
    });
  });

  describe('Variable Naming Conventions', () => {
    it('should use snake_case for variable names', () => {
      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];

        for (const variable of variables) {
          const isSnakeCase = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(variable.name);
          expect(
            isSnakeCase,
            `${file}: variable "${variable.name}" should use snake_case`
          ).toBe(true);
        }
      }
    });

    it('should not use reserved SQL keywords as variable names', () => {
      const reservedWords = ['select', 'from', 'where', 'order', 'group', 'having', 'join', 'table'];

      for (const [file, dashboard] of dashboards) {
        const variables = dashboard.templating?.list || [];

        for (const variable of variables) {
          expect(
            reservedWords.includes(variable.name.toLowerCase()),
            `${file}: variable "${variable.name}" is a reserved SQL keyword`
          ).toBe(false);
        }
      }
    });
  });
});
