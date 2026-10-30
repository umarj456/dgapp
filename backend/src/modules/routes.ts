/** User-facing API routes (session-authenticated). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { authenticate } from './auth/plugin.js';
import { abandonPendingPayment, buyDid, didCountry, myNumbers, releaseAssignment, searchAvailable } from './dids/service.js';
import { evaluateKyc, latestByType } from './kyc/gate.js';
import { requireKyc, type KycDeps } from './kyc/middleware.js';
import { loadCountryRequirement, loadKycChecks, recordKycCheck } from './kyc/repo.js';
import { issueDeviceCredential, revokeDeviceCredential } from './sip/service.js';
import { getWallet, microsToUsd, postLedger, usdToMicros } from './wallet/repo.js';
import { isStripePublishableKey } from './wallet/keys.js';
import { capturePayPalOrder, createPayPalOrder, encodePayPalCustom, paypalConfigured, planPayPalCapture } from './wallet/paypal.js';
import { createDidSubscriptionCheckout, createSetupIntent, createTopupCheckout, ensureCustomer } from './wallet/stripe.js';
import { activateStripeAssignment } from './dids/service.js';

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

  app.get('/v1/billing/config', async () => ({
    stripeStub: config.STRIPE_STUB_MODE,
    stripePublishableKey: isStripePublishableKey(config.STRIPE_PUBLISHABLE_KEY) ? config.STRIPE_PUBLISHABLE_KEY : '',
    paypal: paypalConfigured(),
  }));

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

  const didBody = z.object({ didId: z.string().uuid(), billing: z.enum(['wallet', 'stripe', 'paypal']).default('wallet') });
  app.post('/v1/dids/buy', {
    preHandler: [auth, requireKyc(kycDeps, 'buy_did', (req) => {
      const p = didBody.safeParse(req.body);
      return p.success ? didCountry(pool, p.data.didId) : null;
    })],
  }, async (req) => {
    const b = didBody.parse(req.body);
    if (b.billing === 'paypal' && !paypalConfigured()) throw new HttpError(503, 'paypal_not_configured');
    const res = await tx((c) => buyDid(c, req.user!.id, b.didId, b.billing));
    if (res.status === 'pending_payment' && b.billing === 'paypal') {
      try {
        const order = await createPayPalOrder({
          customId: encodePayPalCustom('did', req.user!.id, res.assignmentId),
          amountMicros: res.monthlyMicros!,
          description: `Phone number +${res.e164}`,
          returnUrl: `${config.WEB_ORIGIN}/?paypal=return`,
          cancelUrl: `${config.WEB_ORIGIN}/?paypal=cancel`,
        });
        return { ...res, checkoutUrl: order.url, checkoutId: order.id, stub: false, provider: 'paypal' as const };
      } catch (e) {
        await tx((c) => abandonPendingPayment(c, res.assignmentId, req.user!.id));
        throw e;
      }
    }
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

  app.post('/v1/wallet/paypal/order', { preHandler: auth }, async (req) => {
    if (!paypalConfigured()) throw new HttpError(503, 'paypal_not_configured');
    const b = z.object({ amountUsd: z.number().min(5).max(500) }).parse(req.body);
    const micros = usdToMicros(b.amountUsd);
    const order = await createPayPalOrder({
      customId: encodePayPalCustom('topup', req.user!.id, micros),
      amountMicros: micros,
      description: 'DG App calling credit',
      returnUrl: `${config.WEB_ORIGIN}/?paypal=return`,
      cancelUrl: `${config.WEB_ORIGIN}/?paypal=cancel`,
    });
    return { id: order.id, url: order.url };
  });

  /** Browser return from PayPal. Credits the wallet or activates the reserved DID. */
  app.post('/v1/paypal/capture', { preHandler: auth }, async (req) => {
    const b = z.object({ orderId: z.string().min(1).max(80) }).parse(req.body);
    const order = await capturePayPalOrder(b.orderId);
    const plan = planPayPalCapture(order, req.user!.id);
    if (!plan.ok) throw new HttpError(400, 'paypal_capture_rejected', plan.reason);
    if (plan.kind === 'topup') {
      const applied = await tx(async (c) => {
        const ok = await postLedger(c, plan.userId, 'topup', plan.micros, {
          idempotencyKey: `paypal:${plan.captureId}`, refType: 'paypal_capture', refId: plan.captureId, memo: 'PayPal top-up',
        });
        await recordKycCheck(c, plan.userId, 'payment_method', 'passed', { provider: 'paypal', reference: plan.captureId });
        return ok;
      });
      return { credited: applied, kind: 'topup' };
    }
    const applied = await tx(async (c) => {
      const seen = await c.query(`INSERT INTO stripe_events (id, type) VALUES ($1,'paypal.capture') ON CONFLICT DO NOTHING`, [`paypal:${plan.captureId}`]);
      if (!seen.rowCount) return false;
      const row = await c.query(
        `SELECT a.id, p.monthly_price_micros + p.setup_price_micros AS due
           FROM did_assignments a JOIN did_pool p ON p.id = a.did_id
          WHERE a.id=$1 AND a.user_id=$2 AND a.status='pending_payment' AND a.billing_source='paypal'`,
        [plan.assignmentId, plan.userId],
      );
      if (!row.rowCount) throw new HttpError(409, 'paypal_assignment_missing');
      if (Number(row.rows[0].due) !== plan.paidMicros) throw new HttpError(400, 'paypal_amount');
      await activateStripeAssignment(c, plan.assignmentId, null, null);
      await recordKycCheck(c, plan.userId, 'payment_method', 'passed', { provider: 'paypal', reference: plan.captureId });
      return true;
    });
    return { credited: applied, kind: 'did' };
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
