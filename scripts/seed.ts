import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(__dirname, '../sql');

const { Client } = pg;

async function seed() {
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

    const seed = readFileSync(join(SQL_DIR, '002_seed_venues.sql'), 'utf-8');
    await client.query(seed);
    console.log('Seed data inserted');

  } catch (error) {
    console.error('Seeding failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

seed();
