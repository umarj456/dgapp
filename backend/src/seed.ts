/** Import DIDs into the pool from a CSV file (DB only, no SIPNAV calls).
 *   npm run seed -- path/to/pool.csv
 * CSV header: e164,country,region,number_type,monthly_usd,setup_usd,sipnav_ref   (see seed/pool.example.csv) */
import { readFileSync } from 'node:fs';
import { pool, tx } from './db.js';
import { importPool, parsePoolCsv, poolStats } from './modules/dids/pool-admin.js';

const file = process.argv[2];
if (!file) { console.error('usage: npm run seed -- <pool.csv>'); process.exit(2); }
const entries = parsePoolCsv(readFileSync(file, 'utf8'));
const res = await tx((c) => importPool(c, entries));
console.log(`pool import: ${res.inserted} inserted, ${res.updated} updated`);
console.table(await poolStats(pool));
await pool.end();
