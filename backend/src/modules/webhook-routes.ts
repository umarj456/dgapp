import type { FastifyInstance } from 'fastify';
import { tx } from '../db.js';
import { handleStripeEvent } from './wallet/webhook.js';
import { parseWebhook, stripe } from './wallet/stripe.js';

export async function webhookRoutes(app: FastifyInstance) {
  // Stripe needs the exact raw body to verify the signature.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/v1/stripe/webhook', async (req, reply) => {
    let ev;
    try {
      ev = parseWebhook(req.body as Buffer, req.headers['stripe-signature'] as string | undefined);
    } catch (e) {
      req.log.warn({ err: e }, 'stripe webhook rejected');
      return reply.code(400).send({ error: 'invalid_signature' });
    }
    if (ev.type === 'charge.dispute.created' && typeof ev.data.object.charge === 'string') {
      const s = stripe();
      if (s) ev.data.object.charge = await s.charges.retrieve(ev.data.object.charge);
    }
    const applied = await tx((c) => handleStripeEvent(c, ev));
    return { received: true, duplicate: !applied };
  });
}
