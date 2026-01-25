import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from '../src/persistence/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(__dirname, '../sql');

const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB ?? 'dislocation_trader',
  user: process.env.POSTGRES_USER ?? 'trader',
  password: process.env.POSTGRES_PASSWORD ?? 'devpassword',
  max: 1,
});

try {
  await runMigrations(pool, SQL_DIR);
} catch (error) {
  console.error('Migration failed:', error);
  process.exit(1);
} finally {
  await pool.end();
}
