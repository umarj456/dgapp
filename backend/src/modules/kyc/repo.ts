import type { Db } from '../../db.js';
import type { CountryRequirement, KycCheck, KycCheckType, KycStatus } from './gate.js';

export async function loadKycChecks(db: Db, userId: string): Promise<KycCheck[]> {
  const r = await db.query(
    `SELECT check_type, status, country, created_at FROM kyc_checks WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return r.rows.map((x) => ({ checkType: x.check_type, status: x.status, country: x.country, createdAt: x.created_at }));
}

export async function loadCountryRequirement(db: Db, country: string): Promise<CountryRequirement | null> {
  const r = await db.query(`SELECT * FROM did_country_requirements WHERE country = $1`, [country]);
  if (!r.rowCount) return null;
  const x = r.rows[0];
  return { country: x.country, requiresId: x.requires_id, requiresAddress: x.requires_address, addressMustBeLocal: x.address_must_be_local };
}

export async function recordKycCheck(
  db: Db,
  userId: string,
  checkType: KycCheckType,
  status: KycStatus,
  opts: { provider?: string; reference?: string; country?: string; details?: unknown } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO kyc_checks (user_id, check_type, status, provider, reference, country, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, checkType, status, opts.provider ?? null, opts.reference ?? null, opts.country ?? null, JSON.stringify(opts.details ?? {})],
  );
}
