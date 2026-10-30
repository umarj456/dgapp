import type { Db } from '../../db.js';
import { config } from '../../config.js';
import { otpCode, randomToken, safeEqual, sha256 } from '../../lib/crypto.js';
import { HttpError } from '../../lib/errors.js';
import type { OtpProvider } from './otp-provider.js';

export interface AuthUser { id: string; email: string; sipAor: string; status: string }

type Purpose = 'login' | 'verify_email' | 'verify_phone';
const MAX_REQUESTS_PER_HOUR = 5;

export async function requestOtp(db: Db, provider: OtpProvider, channel: 'email' | 'sms', destination: string, purpose: Purpose) {
  const recent = await db.query(
    `SELECT count(*)::int AS n FROM otp_codes WHERE destination=$1 AND created_at > now() - interval '1 hour'`,
    [destination],
  );
  if (recent.rows[0].n >= MAX_REQUESTS_PER_HOUR) throw new HttpError(429, 'otp_rate_limited');
  const code = otpCode();
  await db.query(
    `INSERT INTO otp_codes (channel, destination, purpose, code_hash, expires_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5))`,
    [channel, destination, purpose, sha256(`${destination}:${code}`), config.OTP_TTL_SECONDS],
  );
  await provider.send(channel, destination, code, purpose);
}

/** Verifies and consumes the most recent live code. Throws on mismatch/expiry. */
export async function verifyOtp(db: Db, destination: string, purpose: Purpose, code: string): Promise<void> {
  const r = await db.query(
    `SELECT id, code_hash, attempts FROM otp_codes
      WHERE destination=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [destination, purpose],
  );
  if (!r.rowCount) throw new HttpError(400, 'otp_invalid');
  const row = r.rows[0];
  if (row.attempts >= config.OTP_MAX_ATTEMPTS) throw new HttpError(429, 'otp_too_many_attempts');
  if (!safeEqual(row.code_hash, sha256(`${destination}:${code}`))) {
    await db.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1`, [row.id]);
    throw new HttpError(400, 'otp_invalid');
  }
  await db.query(`UPDATE otp_codes SET consumed_at = now() WHERE id=$1`, [row.id]);
}

export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const r = await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2, now() + make_interval(hours => $3)) RETURNING expires_at`,
    [userId, sha256(token), config.SESSION_TTL_HOURS],
  );
  return { token, expiresAt: r.rows[0].expires_at };
}

export async function userFromToken(db: Db, token: string): Promise<AuthUser | null> {
  const r = await db.query(
    `SELECT u.id, u.email, u.sip_aor, u.status FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash=$1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!r.rowCount) return null;
  const u = r.rows[0];
  return { id: u.id, email: u.email, sipAor: u.sip_aor, status: u.status };
}

/** Finds or creates the user for a verified email. Also creates the wallet. */
export async function upsertUserByEmail(db: Db, email: string): Promise<string> {
  const existing = await db.query(`SELECT id FROM users WHERE email=$1`, [email]);
  if (existing.rowCount) return existing.rows[0].id;
  const aor = 'u' + randomToken(9).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 10);
  const r = await db.query(`INSERT INTO users (email, sip_aor) VALUES ($1,$2) RETURNING id`, [email, aor]);
  await db.query(`INSERT INTO wallets (user_id) VALUES ($1)`, [r.rows[0].id]);
  return r.rows[0].id;
}
