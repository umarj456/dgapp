/** Minimal forward-only migration runner. 003_dev_* files only run when MIGRATE_DEV_SEED=true. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    if (f.includes('_dev_') && !config.MIGRATE_DEV_SEED) { console.log(`skip ${f} (dev seed)`); continue; }
    const sql = readFileSync(join(dir, f), 'utf8');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
      await c.query('COMMIT');
      console.log(`applied ${f}`);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
