import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool, types } = pg;

// Force NUMERIC (OID 1700) to return as string, never float
types.setTypeParser(1700, (val: string) => val);

let pool: pg.Pool | null = null;

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  statementTimeoutMillis?: number;
}

export function createPool(config: DbConfig): pg.Pool {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.max ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
    statement_timeout: config.statementTimeoutMillis ?? 10000,
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected Postgres pool error');
  });

  pool.on('connect', () => {
    logger.debug('New Postgres client connected');
  });

  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('Database pool not initialized. Call createPool first.');
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
}

function redactParams(params?: unknown[]): string {
  if (!params || params.length === 0) return '[]';
  return `[${params.length} params]`;
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  const start = Date.now();
  const result = await p.query<T>(text, params);
  const duration = Date.now() - start;
  logger.debug({ query: text.slice(0, 100), params: redactParams(params), duration, rows: result.rowCount }, 'Query executed');
  return result;
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
