import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(__dirname, '../sql');

const { Client } = pg;

async function migrate() {
  const client = new Client({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    database: process.env.POSTGRES_DB ?? 'dislocation_trader',
    user: process.env.POSTGRES_USER ?? 'trader',
    password: process.env.POSTGRES_PASSWORD ?? 'devpassword',
  });

  try {
    await client.connect();
    console.log('Connected to database');

    const schema = readFileSync(join(SQL_DIR, '001_initial_schema.sql'), 'utf-8');
    await client.query(schema);
    console.log('Schema created');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
