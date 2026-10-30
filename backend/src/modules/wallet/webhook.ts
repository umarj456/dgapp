import type pg from 'pg';
import { activateStripeAssignment, releaseAssignment } from '../dids/service.js';
import { recordKycCheck } from '../kyc/repo.js';
import { postLedger } from './repo.js';
import type { WebhookEvent } from './stripe.js';

/** Applies one Stripe event inside a transaction. Idempotent per event id. Returns false for duplicates. */
export async function handleStripeEvent(c: pg.PoolClient, ev: WebhookEvent): Promise<boolean> {
  const ins = await c.query(`INSERT INTO stripe_events (id, type) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ev.id, ev.type]);
  if (!ins.rowCount) return false;
  const o = ev.data.object;
  const md = o.metadata ?? {};

  switch (ev.type) {
    case 'checkout.session.completed': {
      if (o.payment_status !== 'paid' && o.mode === 'payment') break;
      const userId = md.user_id;
      if (!userId) break;
      // A completed card payment also proves a working payment method.
      await recordKycCheck(c, userId, 'payment_method', 'passed', { provider: 'stripe', reference: o.id });
      if (md.kind === 'topup') {
        const micros = Number(o.amount_total ?? 0) * 10_000; // cents -> micros (trust Stripe's amount, not metadata)
        if (micros > 0) {
          await postLedger(c, userId, 'topup', micros, { idempotencyKey: `stripe:${ev.id}`, refType: 'stripe_checkout', refId: o.id, memo: 'Card top-up' });
        }
      } else if (md.kind === 'did_subscription' && md.assignment_id) {
        await activateStripeAssignment(c, md.assignment_id, o.subscription ?? null, null);
      }
      break;
    }
    case 'setup_intent.succeeded':
      if (md.user_id) await recordKycCheck(c, md.user_id, 'payment_method', 'passed', { provider: 'stripe', reference: o.id });
      break;
    case 'setup_intent.setup_failed':
      if (md.user_id) await recordKycCheck(c, md.user_id, 'payment_method', 'failed', { provider: 'stripe', reference: o.id });
      break;
    case 'invoice.paid': {
      const subId = o.subscription ?? o.parent?.subscription_details?.subscription;
      const periodEnd = o.lines?.data?.[0]?.period?.end;
      if (subId) {
        const a = await c.query(`SELECT id FROM did_assignments WHERE stripe_subscription_id=$1`, [subId]);
        if (a.rowCount) await activateStripeAssignment(c, a.rows[0].id, subId, periodEnd ? new Date(periodEnd * 1000) : null);
        await c.query(
          `UPDATE did_assignments SET status='active', current_period_end=COALESCE($2, current_period_end) WHERE stripe_subscription_id=$1 AND status<>'released'`,
          [subId, periodEnd ? new Date(periodEnd * 1000) : null],
        );
      }
      break;
    }
    case 'invoice.payment_failed': {
      const subId = o.subscription ?? o.parent?.subscription_details?.subscription;
      if (subId) await c.query(`UPDATE did_assignments SET status='past_due' WHERE stripe_subscription_id=$1 AND status='active'`, [subId]);
      break;
    }
    case 'customer.subscription.deleted': {
      const a = await c.query(`SELECT id FROM did_assignments WHERE stripe_subscription_id=$1 AND status<>'released'`, [o.id]);
      if (a.rowCount) await releaseAssignment(c, a.rows[0].id);
      break;
    }
    case 'charge.dispute.created': {
      // Chargebacks are a strong fraud signal: suspend the account until reviewed.
      // Dispute objects carry `charge`; the API layer expands it so `customer` is available (see routes.ts).
      const cust = o.customer ?? o.charge?.customer ?? null;
      if (cust) await c.query(`UPDATE users SET status='suspended', updated_at=now() WHERE stripe_customer_id=$1`, [cust]);
      break;
    }
    default:
      break;
  }
  return true;
}
