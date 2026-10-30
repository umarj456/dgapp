/**
 * PayPal Orders v2. Client id and secret come from the environment only.
 * A capture credits the prepaid wallet (top-up) or activates a reserved DID.
 */
import { config } from '../../config.js';
import { HttpError } from '../../lib/errors.js';
import { isPlaceholder } from './keys.js';

export type PayPalMode = 'sandbox' | 'live';

export function paypalConfigured(): boolean {
  return !isPlaceholder(config.PAYPAL_CLIENT_ID) && !isPlaceholder(config.PAYPAL_CLIENT_SECRET);
}

export function paypalBaseUrl(mode: PayPalMode = config.PAYPAL_MODE): string {
  return mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

export function encodePayPalCustom(kind: 'topup', userId: string, micros: number): string;
export function encodePayPalCustom(kind: 'did', userId: string, assignmentId: string): string;
export function encodePayPalCustom(kind: 'topup' | 'did', userId: string, extra: number | string): string {
  const id = kind === 'topup' ? `t:${userId}:${extra}` : `d:${userId}:${extra}`;
  if (id.length > 127) throw new Error('paypal custom_id too long');
  return id;
}

export type PayPalPlan =
  | { ok: true; kind: 'topup'; userId: string; micros: number; captureId: string }
  | { ok: true; kind: 'did'; userId: string; assignmentId: string; paidMicros: number; captureId: string }
  | { ok: false; reason: string };

export function microsToPayPalValue(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}

export function payPalValueToMicros(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return -1;
  return Math.round(n * 1_000_000);
}

/** Decide what a completed capture should do. The session user must own the custom id. */
export function planPayPalCapture(order: unknown, sessionUserId: string): PayPalPlan {
  const o = order as {
    purchase_units?: Array<{
      custom_id?: string;
      payments?: { captures?: Array<{ id?: string; status?: string; amount?: { currency_code?: string; value?: string } }> };
    }>;
  };
  const unit = o.purchase_units?.[0];
  const cap = unit?.payments?.captures?.find((c) => c.status === 'COMPLETED') ?? unit?.payments?.captures?.[0];
  if (!cap?.id || cap.status !== 'COMPLETED') return { ok: false, reason: 'not_completed' };
  if (cap.amount?.currency_code !== 'USD') return { ok: false, reason: 'currency' };
  const paid = payPalValueToMicros(cap.amount.value ?? '');
  if (paid <= 0) return { ok: false, reason: 'amount' };
  const custom = unit?.custom_id ?? '';
  const topup = /^t:([0-9a-f-]{36}):(\d+)$/i.exec(custom);
  if (topup) {
    if (topup[1] !== sessionUserId) return { ok: false, reason: 'user' };
    if (Number(topup[2]) !== paid) return { ok: false, reason: 'amount' };
    return { ok: true, kind: 'topup', userId: topup[1], micros: paid, captureId: cap.id };
  }
  const did = /^d:([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(custom);
  if (did) {
    if (did[1] !== sessionUserId) return { ok: false, reason: 'user' };
    return { ok: true, kind: 'did', userId: did[1], assignmentId: did[2], paidMicros: paid, captureId: cap.id };
  }
  return { ok: false, reason: 'custom_id' };
}

type FetchFn = typeof fetch;

let tokenCache: { value: string; exp: number } | null = null;

async function accessToken(fetchFn: FetchFn): Promise<string> {
  if (!paypalConfigured()) throw new HttpError(503, 'paypal_not_configured');
  if (tokenCache && tokenCache.exp > Date.now()) return tokenCache.value;
  const basic = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetchFn(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new HttpError(502, 'paypal_auth_failed');
  const body = await res.json() as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new HttpError(502, 'paypal_auth_failed');
  tokenCache = { value: body.access_token, exp: Date.now() + Math.max(30, (body.expires_in ?? 60) - 60) * 1000 };
  return body.access_token;
}

export async function createPayPalOrder(input: {
  customId: string;
  amountMicros: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}, fetchFn: FetchFn = fetch): Promise<{ id: string; url: string }> {
  const token = await accessToken(fetchFn);
  const res = await fetchFn(`${paypalBaseUrl()}/v2/checkout/orders`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: input.customId,
        description: input.description,
        amount: { currency_code: 'USD', value: microsToPayPalValue(input.amountMicros) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
          },
        },
      },
    }),
  });
  if (!res.ok) throw new HttpError(502, 'paypal_order_failed');
  const body = await res.json() as { id?: string; links?: { rel: string; href: string }[] };
  const url = body.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  if (!body.id || !url) throw new HttpError(502, 'paypal_order_failed');
  return { id: body.id, url };
}

export async function capturePayPalOrder(orderId: string, fetchFn: FetchFn = fetch): Promise<unknown> {
  const token = await accessToken(fetchFn);
  const res = await fetchFn(`${paypalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  if (!res.ok) throw new HttpError(502, 'paypal_capture_failed');
  return res.json();
}

/** Test hook. */
export function clearPayPalTokenCache() { tokenCache = null; }
