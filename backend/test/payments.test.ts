import { describe, expect, it } from 'vitest';
import { assertRuntimeConfig, type Config } from '../src/config.js';
import { isLiveStripeSecret, isStripePublishableKey, isStripeSecretKey } from '../src/modules/wallet/keys.js';
import { encodePayPalCustom, paypalBaseUrl, planPayPalCapture } from '../src/modules/wallet/paypal.js';

const user = '11111111-1111-4111-8111-111111111111';
const assignment = '22222222-2222-4222-8222-222222222222';

function base(over: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'development', PORT: 8080, HOST: '127.0.0.1', DATABASE_URL: 'postgres://localhost/dgapp',
    SESSION_TTL_HOURS: 1, OTP_TTL_SECONDS: 60, OTP_MAX_ATTEMPTS: 5, OTP_PROVIDER: 'console',
    INTERNAL_API_TOKEN: 'change-me-dev-only', INTERNAL_ALLOWED_IPS: '127.0.0.1',
    SIP_REALM: 'example', SIPNAV_TECH_PREFIX: '05436#',
    STRIPE_SECRET_KEY: undefined, STRIPE_PUBLISHABLE_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_STUB_MODE: true, PAYPAL_CLIENT_ID: undefined, PAYPAL_CLIENT_SECRET: undefined, PAYPAL_MODE: 'sandbox',
    MAX_CALL_SECONDS: 60, MIN_CALL_SECONDS: 6, DID_COOLDOWN_DAYS: 30, MIGRATE_DEV_SEED: false, WEB_ORIGIN: 'http://127.0.0.1:4200',
    ...over,
  };
}

describe('stripe key shape', () => {
  it('accepts restricted live keys and secret keys, and rejects placeholders', () => {
    expect(isStripeSecretKey('rk_live_abcDEF123')).toBe(true);
    expect(isStripeSecretKey('sk_live_abcDEF123')).toBe(true);
    expect(isStripeSecretKey('sk_test_abcDEF123')).toBe(true);
    expect(isStripeSecretKey('rk_test_abcDEF123')).toBe(true);
    expect(isStripeSecretKey('sk_test_placeholder')).toBe(false);
    expect(isStripeSecretKey('pk_live_abcDEF123')).toBe(false);
    expect(isLiveStripeSecret('rk_live_abcDEF123')).toBe(true);
    expect(isLiveStripeSecret('sk_test_abcDEF123')).toBe(false);
    expect(isStripePublishableKey('pk_live_abcDEF123')).toBe(true);
    expect(isStripePublishableKey('pk_test_placeholder')).toBe(false);
  });

  it('refuses stub mode for a live key and in production', () => {
    expect(() => assertRuntimeConfig(base({ STRIPE_SECRET_KEY: 'rk_live_abcDEF123', STRIPE_STUB_MODE: true }))).toThrow(/STRIPE_STUB_MODE must be false/);
    expect(() => assertRuntimeConfig(base({ NODE_ENV: 'production', STRIPE_STUB_MODE: true, INTERNAL_API_TOKEN: 'real-token', OTP_PROVIDER: 'smtp' }))).toThrow(/STRIPE_STUB_MODE must be false in production/);
    expect(() => assertRuntimeConfig(base({
      STRIPE_STUB_MODE: false, STRIPE_SECRET_KEY: 'rk_live_abcDEF123', STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
    }))).not.toThrow();
  });
});

describe('paypal capture plan', () => {
  it('credits a top-up only when the captured USD matches the custom id', () => {
    const custom = encodePayPalCustom('topup', user, 10_000_000);
    const order = {
      purchase_units: [{
        custom_id: custom,
        payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' } }] },
      }],
    };
    expect(planPayPalCapture(order, user)).toMatchObject({ ok: true, kind: 'topup', micros: 10_000_000, captureId: 'CAP1' });
    expect(planPayPalCapture(order, assignment).ok).toBe(false);
    expect(paypalBaseUrl('live')).toBe('https://api-m.paypal.com');
    expect(paypalBaseUrl('sandbox')).toBe('https://api-m.sandbox.paypal.com');
  });

  it('plans a DID activation from the custom id', () => {
    const order = {
      purchase_units: [{
        custom_id: encodePayPalCustom('did', user, assignment),
        payments: { captures: [{ id: 'CAP2', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' } }] },
      }],
    };
    expect(planPayPalCapture(order, user)).toMatchObject({ ok: true, kind: 'did', assignmentId: assignment, paidMicros: 5_000_000 });
  });
});
