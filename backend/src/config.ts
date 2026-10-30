import 'dotenv/config';
import { z } from 'zod';
import { isLiveStripeSecret, isPlaceholder, isStripeSecretKey } from './modules/wallet/keys.js';

const bool = (d: boolean) =>
  z.string().optional().transform((v) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(v.toLowerCase())));
const int = (d: number) => z.string().optional().transform((v) => (v ? parseInt(v, 10) : d));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://dgapp:dgapp@localhost:5432/dgapp'),
  SESSION_TTL_HOURS: int(24 * 30),
  OTP_TTL_SECONDS: int(600),
  OTP_MAX_ATTEMPTS: int(5),
  OTP_PROVIDER: z.enum(['console', 'twilio', 'smtp']).default('console'),
  INTERNAL_API_TOKEN: z.string().default('change-me-dev-only'),
  INTERNAL_ALLOWED_IPS: z.string().default('127.0.0.1,::1,::ffff:127.0.0.1'),
  SIP_REALM: z.string().default('sip.dialergiants.example'),
  SIPNAV_TECH_PREFIX: z.string().default('05436#'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_STUB_MODE: bool(true),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  MAX_CALL_SECONDS: int(4 * 3600),
  MIN_CALL_SECONDS: int(6),
  DID_COOLDOWN_DAYS: int(30),
  MIGRATE_DEV_SEED: bool(false),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
});

export type Config = z.infer<typeof schema>;

/** Boot checks. Live Stripe keys (sk_live_ or rk_live_) cannot run with the stub. */
export function assertRuntimeConfig(c: Config) {
  if (c.NODE_ENV === 'production') {
    if (c.INTERNAL_API_TOKEN === 'change-me-dev-only') throw new Error('INTERNAL_API_TOKEN must be set in production');
    if (c.STRIPE_STUB_MODE) throw new Error('STRIPE_STUB_MODE must be false in production');
    if (c.OTP_PROVIDER === 'console') throw new Error('OTP_PROVIDER=console is dev-only');
    const paypalSet = !isPlaceholder(c.PAYPAL_CLIENT_ID) || !isPlaceholder(c.PAYPAL_CLIENT_SECRET);
    if (paypalSet && c.PAYPAL_MODE !== 'live') throw new Error('PAYPAL_MODE must be live in production');
  }
  if (isLiveStripeSecret(c.STRIPE_SECRET_KEY) && c.STRIPE_STUB_MODE) {
    throw new Error('STRIPE_STUB_MODE must be false when a live Stripe key is set');
  }
  if (!c.STRIPE_STUB_MODE && c.STRIPE_SECRET_KEY && !isStripeSecretKey(c.STRIPE_SECRET_KEY)) {
    throw new Error('STRIPE_SECRET_KEY must be an sk_ or rk_ key');
  }
  if (!c.STRIPE_STUB_MODE && c.STRIPE_SECRET_KEY && !c.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be set when Stripe stub mode is off');
  }
}

export const config: Config = schema.parse(process.env);
assertRuntimeConfig(config);
