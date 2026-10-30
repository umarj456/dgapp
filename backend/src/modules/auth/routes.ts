import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db.js';
import { sha256 } from '../../lib/crypto.js';
import { HttpError } from '../../lib/errors.js';
import { recordKycCheck } from '../kyc/repo.js';
import type { OtpProvider } from './otp-provider.js';
import { authenticate } from './plugin.js';
import { createSession, requestOtp, upsertUserByEmail, verifyOtp } from './service.js';

const email = z.string().email().transform((s) => s.trim().toLowerCase());
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, 'phone must be E.164 with +');

export async function authRoutes(app: FastifyInstance, opts: { otp: OtpProvider }) {
  const auth = authenticate(pool);

  // Sign-up and login are the same flow: email OTP. Verifying it = email KYC check passed.
  app.post('/v1/auth/email/start', async (req) => {
    const body = z.object({ email }).parse(req.body);
    await requestOtp(pool, opts.otp, 'email', body.email, 'login');
    return { sent: true };
  });

  app.post('/v1/auth/email/verify', async (req) => {
    const body = z.object({ email, code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    await verifyOtp(pool, body.email, 'login', body.code);
    const userId = await upsertUserByEmail(pool, body.email);
    await recordKycCheck(pool, userId, 'email', 'passed', { provider: 'otp', reference: body.email });
    const s = await createSession(pool, userId);
    return { token: s.token, expiresAt: s.expiresAt };
  });

  app.post('/v1/me/phone/start', { preHandler: auth }, async (req) => {
    const body = z.object({ phone }).parse(req.body);
    const taken = await pool.query(`SELECT 1 FROM users WHERE phone_e164=$1 AND id<>$2`, [body.phone, req.user!.id]);
    if (taken.rowCount) throw new HttpError(409, 'phone_in_use');
    await requestOtp(pool, opts.otp, 'sms', body.phone, 'verify_phone');
    return { sent: true };
  });

  app.post('/v1/me/phone/verify', { preHandler: auth }, async (req) => {
    const body = z.object({ phone, code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    await verifyOtp(pool, body.phone, 'verify_phone', body.code);
    await pool.query(`UPDATE users SET phone_e164=$1, updated_at=now() WHERE id=$2`, [body.phone, req.user!.id]);
    await recordKycCheck(pool, req.user!.id, 'phone', 'passed', { provider: 'otp', reference: body.phone });
    return { verified: true };
  });

  app.post('/v1/auth/logout', { preHandler: auth }, async (req) => {
    const token = req.headers.authorization!.slice(7);
    await pool.query(`DELETE FROM sessions WHERE token_hash=$1`, [sha256(token)]);
    return { ok: true };
  });
}
