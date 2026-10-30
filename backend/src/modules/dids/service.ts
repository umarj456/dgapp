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

function addMonth(d: Date): Date {
  const n = new Date(d);
  n.setUTCMonth(n.getUTCMonth() + 1);
  return n;
}

/**
 * Buy from the pool. 'wallet': first month + setup debited from prepaid balance and the number is live immediately.
 * 'stripe': number is reserved (pending_payment) until the Stripe checkout webhook activates it.
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
      [didId, userId, addMonth(now), !hasPrimary.rowCount],
    );
    const assignmentId = a.rows[0].id;
    await postLedger(c, userId, 'did_subscription', -total, {
      refType: 'did_assignment', refId: assignmentId, idempotencyKey: `did:${assignmentId}:first`, memo: `+${did.e164} first month`,
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
    `UPDATE did_assignments SET status='active', stripe_subscription_id=COALESCE($2, stripe_subscription_id),
            current_period_end=COALESCE($3, now() + interval '1 month')
      WHERE id=$1 AND status IN ('pending_payment','past_due') RETURNING did_id`,
    [assignmentId, subscriptionId, periodEnd],
  );
  if (r.rowCount) await db.query(`UPDATE did_pool SET status='assigned', updated_at=now() WHERE id=$1`, [r.rows[0].did_id]);
}

export async function myNumbers(db: Db, userId: string) {
  const r = await db.query(
    `SELECT a.id AS assignment_id, p.e164, p.country, p.region, a.status, a.billing_source, a.current_period_end, a.is_primary_cid
       FROM did_assignments a JOIN did_pool p ON p.id=a.did_id
      WHERE a.user_id=$1 AND a.status<>'released' ORDER BY a.created_at`,
    [userId],
  );
  return r.rows;
}

/** Daily job: renew wallet-billed numbers; past_due when balance is short; release after 7-day grace. Cooldown numbers return to pool. */
export async function runDidMaintenance(c: pg.PoolClient) {
  const due = await c.query(
    `SELECT a.id, a.user_id, p.e164, p.monthly_price_micros, a.status, a.current_period_end
       FROM did_assignments a JOIN did_pool p ON p.id=a.did_id
      WHERE a.billing_source='wallet' AND a.status IN ('active','past_due') AND a.current_period_end <= now()
      FOR UPDATE OF a`,
  );
  for (const row of due.rows) {
    const periodKey = new Date(row.current_period_end).toISOString().slice(0, 10);
    try {
      await c.query('SAVEPOINT renew');
      await postLedger(c, row.user_id, 'did_subscription', -Number(row.monthly_price_micros), {
        refType: 'did_assignment', refId: row.id, idempotencyKey: `did:${row.id}:${periodKey}`, memo: `+${row.e164} renewal`,
      });
      await c.query(`UPDATE did_assignments SET status='active', current_period_end=current_period_end + interval '1 month' WHERE id=$1`, [row.id]);
      await c.query('RELEASE SAVEPOINT renew');
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT renew');
      if (e instanceof HttpError && e.code === 'insufficient_balance') {
        const graceOver = Date.now() - new Date(row.current_period_end).getTime() > 7 * 86_400_000;
        if (graceOver) await releaseAssignment(c, row.id);
        else await c.query(`UPDATE did_assignments SET status='past_due' WHERE id=$1`, [row.id]);
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
