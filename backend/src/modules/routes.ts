/** User-facing API routes (session-authenticated). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { authenticate } from './auth/plugin.js';
import { buyDid, didCountry, myNumbers, releaseAssignment, searchAvailable } from './dids/service.js';
import { evaluateKyc, latestByType } from './kyc/gate.js';
import { requireKyc, type KycDeps } from './kyc/middleware.js';
import { loadCountryRequirement, loadKycChecks, recordKycCheck } from './kyc/repo.js';
import { issueDeviceCredential, revokeDeviceCredential } from './sip/service.js';
import { getWallet, microsToUsd, usdToMicros } from './wallet/repo.js';
import { createDidSubscriptionCheckout, createSetupIntent, createTopupCheckout, ensureCustomer } from './wallet/stripe.js';

export const kycDeps: KycDeps = {
  loadChecks: (id) => loadKycChecks(pool, id),
  loadCountryRequirement: (c) => loadCountryRequirement(pool, c),
};

async function stripeCustomer(userId: string, email: string): Promise<string | null> {
  const r = await pool.query(`SELECT stripe_customer_id FROM users WHERE id=$1`, [userId]);
  const id = await ensureCustomer(email, r.rows[0]?.stripe_customer_id ?? null);
  if (id && id !== r.rows[0]?.stripe_customer_id) await pool.query(`UPDATE users SET stripe_customer_id=$1 WHERE id=$2`, [id, userId]);
  return id;
}

export async function userRoutes(app: FastifyInstance) {
  const auth = authenticate(pool);

  app.get('/v1/me', { preHandler: auth }, async (req) => {
    const u = req.user!;
    const checks = await loadKycChecks(pool, u.id);
    const latest = Object.fromEntries([...latestByType(checks)].map(([k, v]) => [k, v.status]));
    const w = await getWallet(pool, u.id);
    const gate = evaluateKyc(checks, 'place_call');
    return {
      id: u.id, email: u.email, sipAor: u.sipAor,
      kyc: { checks: latest, canCall: gate.allowed, missing: gate.missing, failed: gate.failed },
      wallet: w && { balanceUsd: microsToUsd(w.balanceMicros), availableUsd: microsToUsd(w.balanceMicros - w.heldMicros), currency: w.currency },
      numbers: await myNumbers(pool, u.id),
    };
  });

  // ---- KYC ----
  app.post('/v1/kyc/payment-method/setup', { preHandler: auth }, async (req) => {
    const cust = await stripeCustomer(req.user!.id, req.user!.email);
    return createSetupIntent(req.user!.id, cust);
  });

  /** ID / address submission. Phase 1: stored as 'pending' for manual review (vendor integration later). */
  app.post('/v1/kyc/documents', { preHandler: auth }, async (req) => {
    const b = z.object({
      checkType: z.enum(['id_document', 'address']),
      country: z.string().length(2).transform((s) => s.toUpperCase()),
      documentRef: z.string().max(500), // object-storage key of the uploaded file
      details: z.record(z.string(), z.unknown()).optional(),
    }).parse(req.body);
    await recordKycCheck(pool, req.user!.id, b.checkType, 'pending', { provider: 'manual', reference: b.documentRef, country: b.country, details: b.details });
    return { status: 'pending' };
  });

  // ---- DIDs ----
  app.get('/v1/dids/search', { preHandler: auth }, async (req) => {
    const q = z.object({
      country: z.string().length(2).optional(), region: z.string().optional(), contains: z.string().max(15).optional(),
      type: z.enum(['local', 'tollfree', 'mobile', 'national']).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
    }).parse(req.query);
    const rows = await searchAvailable(pool, q);
    return rows.map((r) => ({ ...r, monthly_price_usd: microsToUsd(Number(r.monthly_price_micros)), setup_price_usd: microsToUsd(Number(r.setup_price_micros)) }));
  });

  app.get('/v1/dids/mine', { preHandler: auth }, async (req) => myNumbers(pool, req.user!.id));

  const didBody = z.object({ didId: z.string().uuid(), billing: z.enum(['wallet', 'stripe']).default('wallet') });
  app.post('/v1/dids/buy', {
    preHandler: [auth, requireKyc(kycDeps, 'buy_did', (req) => {
      const p = didBody.safeParse(req.body);
      return p.success ? didCountry(pool, p.data.didId) : null;
    })],
  }, async (req) => {
    const b = didBody.parse(req.body);
    const res = await tx((c) => buyDid(c, req.user!.id, b.didId, b.billing));
    if (res.status === 'pending_payment') {
      const cust = await stripeCustomer(req.user!.id, req.user!.email);
      const co = await createDidSubscriptionCheckout(req.user!.id, cust, res.assignmentId, res.e164, res.monthlyMicros!);
      return { ...res, checkoutUrl: co.url, checkoutId: co.id, stub: co.stub };
    }
    return res;
  });

  app.post('/v1/dids/:assignmentId/release', { preHandler: auth }, async (req) => {
    const { assignmentId } = z.object({ assignmentId: z.string().uuid() }).parse(req.params);
    await tx((c) => releaseAssignment(c, assignmentId, req.user!.id));
    return { released: true };
  });

  // ---- Wallet ----
  app.get('/v1/wallet/ledger', { preHandler: auth }, async (req) => {
    const r = await pool.query(
      `SELECT id, kind, amount_micros, balance_after, memo, created_at FROM ledger_entries WHERE user_id=$1 ORDER BY id DESC LIMIT 100`,
      [req.user!.id],
    );
    return r.rows;
  });

  app.post('/v1/wallet/topup', { preHandler: auth }, async (req) => {
    const b = z.object({ amountUsd: z.number().min(5).max(500) }).parse(req.body);
    const cust = await stripeCustomer(req.user!.id, req.user!.email);
    return createTopupCheckout(req.user!.id, cust, usdToMicros(b.amountUsd));
  });

  // ---- SIP device credentials (for the WebRTC client) ----
  app.post('/v1/sip/credentials', { preHandler: auth }, async (req) => {
    const b = z.object({ deviceLabel: z.string().max(60).default('web') }).parse(req.body ?? {});
    const cred = await issueDeviceCredential(pool, req.user!.id, req.user!.sipAor, b.deviceLabel);
    return { ...cred, wssUrl: process.env.SIP_WSS_URL ?? `wss://${config.SIP_REALM}:8443/ws` };
  });

  app.delete('/v1/sip/credentials/:username', { preHandler: auth }, async (req) => {
    const { username } = z.object({ username: z.string() }).parse(req.params);
    await revokeDeviceCredential(pool, req.user!.id, username);
    return { revoked: true };
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, details: err.details });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'validation', details: err.issues });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });
}
