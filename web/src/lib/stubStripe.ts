import { api } from './api';

/**
 * Local Stripe stub. The API accepts this unsigned body only while STRIPE_STUB_MODE is on
 * (refused when NODE_ENV=production). No card data is collected.
 */
export function simulateStripeEvent(event: { id: string; type: string; object: Record<string, unknown> }) {
  return api('/v1/stripe/webhook', {
    body: { id: event.id, type: event.type, data: { object: event.object } },
  });
}
