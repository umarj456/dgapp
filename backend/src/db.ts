import pg from 'pg';
import { config } from './config.js';

// BIGINT -> JS number. Safe: micro-USD balances stay far below 2^53.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
export type Db = pg.Pool | pg.PoolClient;

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
