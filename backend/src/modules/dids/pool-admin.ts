/** DID pool administration (ops only). Importing numbers here is a DB change only: it never touches SIPNAV.
 * Numbers must already be assigned to the "DG App" SIPNAV account and routed to the edge before import. */
import { z } from 'zod';
import type { Db } from '../../db.js';

export const poolEntrySchema = z.object({
  e164: z.string().transform((s) => s.replace(/\D/g, '')).pipe(z.string().regex(/^[1-9]\d{6,14}$/)),
  country: z.string().length(2).transform((s) => s.toUpperCase()),
  region: z.string().max(40).optional().nullable(),
  numberType: z.enum(['local', 'tollfree', 'mobile', 'national']).default('local'),
  monthlyPriceMicros: z.coerce.number().int().min(0),
  setupPriceMicros: z.coerce.number().int().min(0).default(0),
  sipnavRef: z.string().max(100).optional().nullable(),
});
export type PoolEntry = z.infer<typeof poolEntrySchema>;

/** Upsert numbers. Existing numbers keep their status (never re-opens an assigned DID); price/region are updated. */
export async function importPool(db: Db, entries: PoolEntry[]) {
  let inserted = 0, updated = 0;
  for (const e of entries) {
    const r = await db.query(
      `INSERT INTO did_pool (e164, country, region, number_type, monthly_price_micros, setup_price_micros, sipnav_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (e164) DO UPDATE SET region=EXCLUDED.region, number_type=EXCLUDED.number_type,
         monthly_price_micros=EXCLUDED.monthly_price_micros, setup_price_micros=EXCLUDED.setup_price_micros,
         sipnav_ref=COALESCE(EXCLUDED.sipnav_ref, did_pool.sipnav_ref), updated_at=now()
       RETURNING (xmax = 0) AS inserted`,
      [e.e164, e.country, e.region ?? null, e.numberType, e.monthlyPriceMicros, e.setupPriceMicros, e.sipnavRef ?? null],
    );
    if (r.rows[0].inserted) inserted++; else updated++;
  }
  return { inserted, updated };
}

/** Disable (or re-enable) an unassigned number, e.g. when SIPNAV pulls it back. Refuses assigned numbers. */
export async function setPoolStatus(db: Db, e164: string, status: 'disabled' | 'available') {
  const r = await db.query(
    `UPDATE did_pool SET status=$2, updated_at=now() WHERE e164=$1 AND status IN ('available','disabled','cooldown') RETURNING e164, status`,
    [e164.replace(/\D/g, ''), status],
  );
  return r.rows[0] ?? null;
}

export async function poolStats(db: Db) {
  const r = await db.query(
    `SELECT country, status, count(*)::int AS n FROM did_pool GROUP BY country, status ORDER BY country, status`,
  );
  return r.rows as { country: string; status: string; n: number }[];
}

/** Parse CSV: header row with e164,country,region,number_type,monthly_usd,setup_usd,sipnav_ref */
export function parsePoolCsv(text: string): PoolEntry[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const [head, ...rows] = lines;
  const cols = head.split(',').map((c) => c.trim().toLowerCase());
  return rows.map((line, i) => {
    const v = line.split(',').map((c) => c.trim());
    const g = (k: string) => { const j = cols.indexOf(k); return j >= 0 && v[j] !== '' ? v[j] : undefined; };
    const usd = (k: string) => (g(k) === undefined ? undefined : Math.round(Number(g(k)) * 1_000_000));
    const p = poolEntrySchema.safeParse({
      e164: g('e164'), country: g('country'), region: g('region'), numberType: g('number_type'),
      monthlyPriceMicros: usd('monthly_usd'), setupPriceMicros: usd('setup_usd'), sipnavRef: g('sipnav_ref'),
    });
    if (!p.success) throw new Error(`CSV row ${i + 2}: ${p.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    return p.data;
  });
}
