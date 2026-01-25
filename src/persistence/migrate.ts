import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { logger } from '../utils/logger.js';

export async function runMigrations(pool: pg.Pool, sqlDir: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    const applied = await client.query('SELECT filename FROM _schema_migrations ORDER BY filename');
    const appliedSet = new Set(applied.rows.map((r: { filename: string }) => r.filename));

    const files = readdirSync(sqlDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const sql = readFileSync(join(sqlDir, file), 'utf-8');
      logger.info({ file }, 'Applying migration');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    if (count > 0) {
      logger.info({ count }, 'Migrations applied');
    } else {
      logger.info('No pending migrations');
    }
  } finally {
    client.release();
  }
}
