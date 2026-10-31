import type pg from 'pg';
import { config } from '../../config.js';
import type { Db } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { postLedger } from '../wallet/repo.js';

export interface DidSearch { country?: string; region?: string; contains?: string; type?: string; limit?: number }

export async function searchAvailable(db: Db, q: DidSearch) {
  const where = [`status='available'`];
  const args: unknown[] = [];
  if (q.country) { args.push(q.country.toUpperCase()); where.push(`country=$${args.length}`); }
  if (q.region) { args.push(q.region); where.push(`region=$${args.length}`); }
  if (q.type) { args.push(q.type); where.push(`number_type=$${args.length}`); }
  if (q.contains) { args.push(`%${q.contains.replace(/\D/g, '')}%`); where.push(`e164 LIKE $${args.length}`); }
  args.push(Math.min(q.limit ?? 20, 100));
  const r = await db.query(
    `SELECT id, e164, country, region, number_type, capabilities, monthly_price_micros, setup_price_micros
       FROM did_pool WHERE ${where.join(' AND ')} ORDER BY random() LIMIT $${args.length}`,
    args,
  );
  return r.rows;
}

export async function didCountry(db: Db, didId: string): Promise<string | null> {
  const r = await db.query(`SELECT country FROM did_pool WHERE id=$1`, [didId]);
  return r.rowCount ? r.rows[0].country : null;
}

export const SUBSCRIPTION_DAYS = 30;

export function addSubscriptionPeriod(from = new Date()): Date {
  return new Date(from.getTime() + SUBSCRIPTION_DAYS * 86_400_000);
}

/**
 * Buy from the pool. 'wallet': 30 days + setup debited from calling credit and the number is live immediately.
 * 'stripe' or 'paypal': reserved until that checkout completes, then live for 30 days.
 * No SIPNAV change is needed: the whole pool already routes to the DG App account.
 */
export async function buyDid(c: pg.PoolClient, userId: string, didId: string, billing: 'wallet' | 'stripe' | 'paypal') {
  const d = await c.query(`SELECT * FROM did_pool WHERE id=$1 FOR UPDATE`, [didId]);
  if (!d.rowCount) throw new HttpError(404, 'did_not_found');
  const did = d.rows[0];
  if (did.status !== 'available') throw new HttpError(409, 'did_unavailable');

  const hasPrimary = await c.query(`SELECT 1 FROM did_assignments WHERE user_id=$1 AND status='active' AND is_primary_cid`, [userId]);
  const now = new Date();
  if (billing === 'wallet') {
    const total = Number(did.monthly_price_micros) + Number(did.setup_price_micros);
    const a = await c.query(
      `INSERT INTO did_assignments (did_id, user_id, status, billing_source, current_period_end, is_primary_cid)
       VALUES ($1,$2,'active','wallet',$3,$4) RETURNING id`,
      [didId, userId, addSubscriptionPeriod(now), !hasPrimary.rowCount],
    );
    const assignmentId = a.rows[0].id;
    await postLedger(c, userId, 'did_subscription', -total, {
      refType: 'did_assignment', refId: assignmentId, idempotencyKey: `did:${assignmentId}:first`, memo: `+${did.e164} 30 days`,
    });
    await c.query(`UPDATE did_pool SET status='assigned', updated_at=now() WHERE id=$1`, [didId]);
    return { assignmentId, e164: did.e164, status: 'active' as const };
  }
  const a = await c.query(
    `INSERT INTO did_assignments (did_id, user_id, status, billing_source, is_primary_cid)
     VALUES ($1,$2,'pending_payment',$3,$4) RETURNING id`,
    [didId, userId, billing, !hasPrimary.rowCount],
  );
  await c.query(`UPDATE did_pool SET status='reserved', updated_at=now() WHERE id=$1`, [didId]);
  return { assignmentId: a.rows[0].id as string, e164: did.e164 as string, status: 'pending_payment' as const, monthlyMicros: Number(did.monthly_price_micros) };
}

/** Cancel keeps the number until period end. on=false stops the next renewal. */
export async function setAutoRenew(c: pg.PoolClient, assignmentId: string, userId: string, on: boolean) {
  const r = await c.query(
    `UPDATE did_assignments SET auto_renew=$3
      WHERE id=$1 AND user_id=$2 AND status IN ('active','past_due')
      RETURNING stripe_subscription_id`,
    [assignmentId, userId, on],
  );
  if (!r.rowCount) throw new HttpError(404, 'assignment_not_found');
  return (r.rows[0].stripe_subscription_id as string | null) ?? null;
}

/** Pay another 30 days from calling credit and unblock the number. */
export async function renewFromWallet(c: pg.PoolClient, userId: string, assignmentId: string) {
  const r = await c.query(
    `SELECT a.id, a.status, p.e164, p.monthly_price_micros
       FROM did_assignments a JOIN did_pool p ON p.id=a.did_id
      WHERE a.id=$1 AND a.user_id=$2 AND a.status IN ('active','past_due')
      FOR UPDATE OF a`,
    [assignmentId, userId],
  );
  if (!r.rowCount) throw new HttpError(404, 'assignment_not_found');
  const row = r.rows[0];
  const periodKey = new Date().toISOString().slice(0, 16);
  await postLedger(c, userId, 'did_subscription', -Number(row.monthly_price_micros), {
    refType: 'did_assignment', refId: assignmentId, idempotencyKey: `did:${assignmentId}:renew:${periodKey}`, memo: `+${row.e164} 30 days`,
  });
  const end = addSubscriptionPeriod();
  await c.query(
    `UPDATE did_assignments SET status='active', auto_renew=true, billing_source='wallet', current_period_end=$2 WHERE id=$1`,
    [assignmentId, end],
  );
  await c.query(`UPDATE did_pool SET status='assigned', updated_at=now() WHERE e164=$1`, [row.e164]);
  return { assignmentId, e164: row.e164 as string, status: 'active' as const, monthlyMicros: Number(row.monthly_price_micros) };
}

/** Checkout failed before the payer approved. Put the number back on sale. */
export async function abandonPendingPayment(c: pg.PoolClient, assignmentId: string, userId: string) {
  const r = await c.query(
    `UPDATE did_assignments SET status='released', released_at=now()
      WHERE id=$1 AND user_id=$2 AND status='pending_payment' RETURNING did_id`,
    [assignmentId, userId],
  );
  if (r.rowCount) {
    await c.query(`UPDATE did_pool SET status='available', updated_at=now() WHERE id=$1 AND status='reserved'`, [r.rows[0].did_id]);
  }
}

/** Release: assignment ends, number rests in cooldown before it can be resold. */
export async function releaseAssignment(db: Db, assignmentId: string, userId?: string) {
  const r = await db.query(
    `UPDATE did_assignments SET status='released', released_at=now()
      WHERE id=$1 AND status<>'released' ${userId ? 'AND user_id=$2' : ''} RETURNING did_id, status`,
    userId ? [assignmentId, userId] : [assignmentId],
  );
  if (!r.rowCount) throw new HttpError(404, 'assignment_not_found');
  await db.query(
    `UPDATE did_pool SET status='cooldown', cooldown_until = now() + make_interval(days => $2), updated_at=now() WHERE id=$1`,
    [r.rows[0].did_id, config.DID_COOLDOWN_DAYS],
  );
}

export async function activateStripeAssignment(db: Db, assignmentId: string, subscriptionId: string | null, periodEnd: Date | null) {
  const r = await db.query(
    `UPDATE did_assignments SET status='active', auto_renew=true, stripe_subscription_id=COALESCE($2, stripe_subscription_id),
            current_period_end=COALESCE($3, now() + interval '30 days')
      WHERE id=$1 AND status IN ('pending_payment','past_due') RETURNING did_id`,
    [assignmentId, subscriptionId, periodEnd],
  );
  if (r.rowCount) await db.query(`UPDATE did_pool SET status='assigned', updated_at=now() WHERE id=$1`, [r.rows[0].did_id]);
}

export async function myNumbers(db: Db, userId: string) {
  const r = await db.query(
    `SELECT a.id AS assignment_id, p.e164, p.country, p.region, a.status, a.billing_source, a.auto_renew, a.current_period_end, a.is_primary_cid
       FROM did_assignments a JOIN did_pool p ON p.id=a.did_id
      WHERE a.user_id=$1 AND a.status<>'released' ORDER BY a.created_at`,
    [userId],
  );
  return r.rows;
}

const GRACE_MS = 7 * 86_400_000;

/** Daily job. Wallet auto-renew charges calling credit. Anything else blocks at period end. Blocked numbers release after 7 days. */
export async function runDidMaintenance(c: pg.PoolClient) {
  const due = await c.query(
    `SELECT a.id, a.user_id, a.billing_source, a.auto_renew, a.status, a.stripe_subscription_id,
            a.current_period_end, p.e164, p.monthly_price_micros
       FROM did_assignments a JOIN did_pool p ON p.id=a.did_id
      WHERE a.status IN ('active','past_due') AND a.current_period_end IS NOT NULL AND a.current_period_end <= now()
      FOR UPDATE OF a`,
  );
  for (const row of due.rows) {
    const ended = new Date(row.current_period_end).getTime();
    const graceOver = Date.now() - ended > GRACE_MS;
    if (row.status === 'past_due') {
      if (graceOver) await releaseAssignment(c, row.id);
      continue;
    }
    const walletRenew = row.billing_source === 'wallet' && row.auto_renew;
    const liveStripe = row.billing_source === 'stripe' && row.auto_renew && row.stripe_subscription_id;
    if (liveStripe) continue;
    if (!walletRenew) {
      await c.query(`UPDATE did_assignments SET status='past_due' WHERE id=$1`, [row.id]);
      continue;
    }
    const periodKey = new Date(row.current_period_end).toISOString().slice(0, 10);
    try {
      await c.query('SAVEPOINT renew');
      await postLedger(c, row.user_id, 'did_subscription', -Number(row.monthly_price_micros), {
        refType: 'did_assignment', refId: row.id, idempotencyKey: `did:${row.id}:${periodKey}`, memo: `+${row.e164} 30 days`,
      });
      await c.query(`UPDATE did_assignments SET status='active', current_period_end=current_period_end + interval '30 days' WHERE id=$1`, [row.id]);
      await c.query('RELEASE SAVEPOINT renew');
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT renew');
      if (e instanceof HttpError && e.code === 'insufficient_balance') {
        await c.query(`UPDATE did_assignments SET status='past_due' WHERE id=$1`, [row.id]);
      } else throw e;
    }
  }
  await c.query(`UPDATE did_pool SET status='available', cooldown_until=NULL WHERE status='cooldown' AND cooldown_until <= now()`);
  await c.query(
    `UPDATE did_assignments SET status='released', released_at=now() WHERE status='pending_payment' AND created_at < now() - interval '1 hour'
      RETURNING did_id`,
  ).then(async (r) => {
    for (const x of r.rows) await c.query(`UPDATE did_pool SET status='available' WHERE id=$1 AND status='reserved'`, [x.did_id]);
  });
}
