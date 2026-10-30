import { api } from './api';

export interface BillingConfig {
  stripeStub: boolean;
  stripePublishableKey: string;
  paypal: boolean;
}

/** Publishable key only. The API reads STRIPE_PUBLISHABLE_KEY; Vite may also set VITE_STRIPE_PUBLISHABLE_KEY. */
export function browserPublishableKey(): string {
  const v = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? '';
  return v.startsWith('pk_') && !v.includes('placeholder') ? v : '';
}

export async function billingConfig(): Promise<BillingConfig> {
  const cfg = await api<BillingConfig>('/v1/billing/config');
  if (!cfg.stripePublishableKey) cfg.stripePublishableKey = browserPublishableKey();
  return cfg;
}
