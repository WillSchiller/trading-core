import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface GrafanaDashboard {
  id: null | number;
  uid: string;
  title: string;
  tags?: string[];
  timezone?: string;
  schemaVersion?: number;
  version?: number;
  refresh?: string;
  time?: {
    from: string;
    to: string;
  };
  templating?: {
    list: TemplateVariable[];
  };
  panels: Panel[];
}

export interface TemplateVariable {
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

export interface Panel {
  id: number;
  type: string;
  title: string;
  description?: string;
  gridPos?: { x: number; y: number; w: number; h: number };
  targets?: Target[];
  datasource?: {
    type: string;
    uid: string;
  };
  panels?: Panel[];
  fieldConfig?: unknown;
  options?: unknown;
}

export interface Target {
  refId: string;
  datasource?: {
    type: string;
    uid: string;
  };
  rawSql?: string;
  format?: string;
}

export interface QueryInfo {
  file: string;
  dashboardTitle: string;
  panelTitle: string;
  query: string;
  refId: string;
}

export async function loadDashboards(dashboardDir: string): Promise<Map<string, GrafanaDashboard>> {
  const files = await readdir(dashboardDir);
  const dashboards = new Map<string, GrafanaDashboard>();

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const content = await readFile(join(dashboardDir, file), 'utf-8');
    const dashboard = JSON.parse(content) as GrafanaDashboard;
    dashboards.set(file, dashboard);
  }

  return dashboards;
}

export function extractAllPanels(panels: Panel[]): Panel[] {
  const result: Panel[] = [];
  for (const panel of panels) {
    result.push(panel);
    if (panel.panels) {
      result.push(...extractAllPanels(panel.panels));
    }
  }
  return result;
}

export function extractQueries(dashboard: GrafanaDashboard): Array<{ panelTitle: string; query: string }> {
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

export function extractAllQueries(dashboards: Map<string, GrafanaDashboard>): QueryInfo[] {
  const queries: QueryInfo[] = [];

  function extractFromPanel(panel: Panel, file: string, dashboardTitle: string): void {
    if (panel.targets) {
      for (const target of panel.targets) {
        if (target.rawSql) {
          queries.push({
            file,
            dashboardTitle,
            panelTitle: panel.title,
            query: target.rawSql,
            refId: target.refId,
          });
        }
      }
    }

    if (panel.panels) {
      for (const subPanel of panel.panels) {
        extractFromPanel(subPanel, file, dashboardTitle);
      }
    }
  }

  for (const [file, dashboard] of dashboards) {
    for (const panel of dashboard.panels || []) {
      extractFromPanel(panel, file, dashboard.title);
    }
  }

  return queries;
}

export function extractTemplateVariables(dashboard: GrafanaDashboard): TemplateVariable[] {
  return dashboard.templating?.list || [];
}

export function extractAllTemplateVariables(
  dashboards: Map<string, GrafanaDashboard>
): Map<string, TemplateVariable[]> {
  const result = new Map<string, TemplateVariable[]>();

  for (const [file, dashboard] of dashboards) {
    result.set(file, extractTemplateVariables(dashboard));
  }

  return result;
}

export const VALID_TABLE_NAMES = [
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
  'price_predictions',
  'prediction_outcomes',
];

export const INDEXED_COLUMNS = [
  'id',
  'venue_id',
  'pair_id',
  'ts',
  'detected_at',
  'created_at',
  'confirmed_at',
  'submitted_at',
  'status',
  'opportunity_id',
  'interval_start',
];

export const TIME_COLUMNS = [
  'ts',
  'detected_at',
  'created_at',
  'confirmed_at',
  'submitted_at',
  'interval_start',
  'received_at',
  'predicted_at',
];

export const NUMERIC_TEMPLATE_VARIABLES = [
  'pair',
  'pair_id',
  'venue_id',
  'id',
  'opportunity_id',
  'chain_id',
];

export const STRING_TEMPLATE_VARIABLES = [
  'strategy',
  'direction',
  'status',
  'chain',
  'venue_type',
];

export function hasTimeMacro(query: string): boolean {
  return (
    query.includes('$__timeFrom()') ||
    query.includes('$__timeTo()') ||
    query.includes('$__timeFilter')
  );
}

export function hasTimeFilter(query: string): boolean {
  return (
    hasTimeMacro(query) ||
    /\b(ts|detected_at|created_at|confirmed_at|interval_start)\s*(>|<|>=|<=|BETWEEN)/i.test(query)
  );
}

export function extractTableNames(query: string): string[] {
  const fromMatches = query.match(/FROM\s+(\w+)/gi) || [];
  const joinMatches = query.match(/JOIN\s+(\w+)/gi) || [];

  const tables = [
    ...fromMatches.map((m) => m.split(/\s+/).pop()!.toLowerCase()),
    ...joinMatches.map((m) => m.split(/\s+/).pop()!.toLowerCase()),
  ];

  return [...new Set(tables)];
}

export function extractVariableReferences(text: string): string[] {
  const matches = text.match(/\$\{(\w+)\}/g) || [];
  return matches.map((m) => m.slice(2, -1));
}

export function isNumericComparison(query: string, varName: string): boolean {
  const pattern = new RegExp(`\\b\\w+\\s*=\\s*\\\${${varName}}`, 'i');
  return pattern.test(query);
}

export function isStringComparison(query: string, varName: string): boolean {
  const pattern = new RegExp(`'\\\${${varName}}'`, 'i');
  return pattern.test(query);
}

export function hasIncludeAllLogic(query: string, varName: string): boolean {
  return (
    new RegExp(`\\(\\s*\\\${${varName}}\\s*=\\s*0\\s*OR`, 'i').test(query) ||
    new RegExp(`\\(\\s*\\\${${varName}}\\s*=\\s*'0'\\s*OR`, 'i').test(query) ||
    new RegExp(`\\(\\s*'\\$\\{${varName}\\}'\\s*=\\s*'all'\\s*OR`, 'i').test(query)
  );
}

export function formatError(file: string, context: string, message: string): string {
  return `${file}: ${context} - ${message}`;
}

export function collectErrors<T>(
  items: T[],
  validator: (item: T) => string | null
): string[] {
  const errors: string[] = [];
  for (const item of items) {
    const error = validator(item);
    if (error) {
      errors.push(error);
    }
  }
  return errors;
}
