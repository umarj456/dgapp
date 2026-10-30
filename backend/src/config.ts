import 'dotenv/config';
import { z } from 'zod';

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
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_STUB_MODE: bool(true),
  MAX_CALL_SECONDS: int(4 * 3600),
  MIN_CALL_SECONDS: int(6),
  DID_COOLDOWN_DAYS: int(30),
  MIGRATE_DEV_SEED: bool(false),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
});

export type Config = z.infer<typeof schema>;
export const config: Config = schema.parse(process.env);

if (config.NODE_ENV === 'production') {
  if (config.INTERNAL_API_TOKEN === 'change-me-dev-only') throw new Error('INTERNAL_API_TOKEN must be set in production');
  if (config.STRIPE_STUB_MODE) throw new Error('STRIPE_STUB_MODE must be false in production');
  if (config.OTP_PROVIDER === 'console') throw new Error('OTP_PROVIDER=console is dev-only');
}
