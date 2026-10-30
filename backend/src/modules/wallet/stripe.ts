/**
 * Stripe wrapper. In STRIPE_STUB_MODE (dev) no network calls are made and fake ids/urls are returned,
 * so the full flow can be exercised locally. Real keys only come from env (see .env.example).
 */
import Stripe from 'stripe';
import { config } from '../../config.js';
import { randomToken } from '../../lib/crypto.js';

let client: Stripe | null = null;
export function stripe(): Stripe | null {
  if (config.STRIPE_STUB_MODE || !config.STRIPE_SECRET_KEY) return null;
  client ??= new Stripe(config.STRIPE_SECRET_KEY);
  return client;
}

export interface CheckoutResult { id: string; url: string; stub: boolean }

export async function createTopupCheckout(userId: string, customerId: string | null, amountMicros: number): Promise<CheckoutResult> {
  const s = stripe();
  const cents = Math.round(amountMicros / 10_000);
  if (!s) {
    const id = 'cs_stub_' + randomToken(8);
    return { id, url: `${config.WEB_ORIGIN}/stub-checkout?session=${id}&kind=topup&cents=${cents}`, stub: true };
  }
  const session = await s.checkout.sessions.create({
    mode: 'payment',
    customer: customerId ?? undefined,
    line_items: [{ price_data: { currency: 'usd', unit_amount: cents, product_data: { name: 'DG App calling credit' } }, quantity: 1 }],
    metadata: { kind: 'topup', user_id: userId, amount_micros: String(amountMicros) },
    payment_intent_data: { setup_future_usage: 'off_session' },
    success_url: `${config.WEB_ORIGIN}/wallet?topup=ok`,
    cancel_url: `${config.WEB_ORIGIN}/wallet?topup=cancel`,
  });
  return { id: session.id, url: session.url!, stub: false };
}

export async function createDidSubscriptionCheckout(
  userId: string, customerId: string | null, assignmentId: string, e164: string, monthlyMicros: number,
): Promise<CheckoutResult> {
  const s = stripe();
  const cents = Math.round(monthlyMicros / 10_000);
  if (!s) {
    const id = 'cs_stub_' + randomToken(8);
    return { id, url: `${config.WEB_ORIGIN}/stub-checkout?session=${id}&kind=did&assignment=${assignmentId}`, stub: true };
  }
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId ?? undefined,
    line_items: [{
      price_data: { currency: 'usd', unit_amount: cents, recurring: { interval: 'month' }, product_data: { name: `Phone number +${e164}` } },
      quantity: 1,
    }],
    metadata: { kind: 'did_subscription', user_id: userId, assignment_id: assignmentId },
    subscription_data: { metadata: { kind: 'did_subscription', user_id: userId, assignment_id: assignmentId } },
    success_url: `${config.WEB_ORIGIN}/numbers?buy=ok`,
    cancel_url: `${config.WEB_ORIGIN}/numbers?buy=cancel`,
  });
  return { id: session.id, url: session.url!, stub: false };
}

/** SetupIntent to verify a payment method (KYC 'payment_method' check passes on setup_intent.succeeded). */
export async function createSetupIntent(userId: string, customerId: string | null): Promise<{ clientSecret: string; id: string; stub: boolean }> {
  const s = stripe();
  if (!s) {
    const id = 'seti_stub_' + randomToken(8);
    return { id, clientSecret: id + '_secret_stub', stub: true };
  }
  const si = await s.setupIntents.create({ customer: customerId ?? undefined, usage: 'off_session', metadata: { user_id: userId } });
  return { id: si.id, clientSecret: si.client_secret!, stub: false };
}

export async function ensureCustomer(email: string, existing: string | null): Promise<string | null> {
  const s = stripe();
  if (!s) return existing ?? 'cus_stub_' + randomToken(6);
  if (existing) return existing;
  const c = await s.customers.create({ email });
  return c.id;
}

export interface WebhookEvent { id: string; type: string; data: { object: any } }

/** Verifies the signature (live) or accepts unsigned JSON (stub mode only). */
export function parseWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent {
  if (config.STRIPE_WEBHOOK_SECRET && !config.STRIPE_STUB_MODE) {
    const s = stripe() ?? new Stripe(config.STRIPE_SECRET_KEY ?? 'sk_placeholder');
    return s.webhooks.constructEvent(rawBody, signature ?? '', config.STRIPE_WEBHOOK_SECRET) as unknown as WebhookEvent;
  }
  if (!config.STRIPE_STUB_MODE) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  return JSON.parse(rawBody.toString('utf8')) as WebhookEvent;
}
