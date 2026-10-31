/**
 * Edge-facing call control. The Kamailio edge calls these through /internal/v1/* (see edge/kamailio).
 *   authorizeOutbound -> KYC gate + fraud + rate + prepaid pre-auth (hold) -> max duration + caller ID
 *   lookupInbound     -> DID -> owner's SIP AoR
 *   endCall           -> settle the hold against the real duration and write the CDR
 */
import type pg from 'pg';
import { config } from '../../config.js';
import { tx, type Db } from '../../db.js';
import { normalizeDialed } from '../../lib/phone.js';
import { checkFraud, DEFAULT_FRAUD_POLICY, type BlockRule, type FraudPolicy } from '../fraud/fraud.js';
import { evaluateKyc } from '../kyc/gate.js';
import { loadKycChecks } from '../kyc/repo.js';
import { preauthorize, settle } from '../rating/preauth.js';
import { billableSeconds, type Rate } from '../rating/rating.js';
import { addHold, lockWallet, postLedger } from '../wallet/repo.js';

export type AuthorizeResponse =
  | { allow: true; auth_id: string; max_duration: number; caller_id: string; ruri_user: string; destination: string }
  | { allow: false; code: string; reason: string; sip_code: number };

const deny = (code: string, reason: string, sip_code = 403): AuthorizeResponse => ({ allow: false, code, reason, sip_code });

let blockCache: { at: number; rules: BlockRule[] } | null = null;
async function blocklist(db: Db): Promise<BlockRule[]> {
  if (blockCache && Date.now() - blockCache.at < 60_000) return blockCache.rules;
  const r = await db.query(`SELECT prefix, reason, action FROM destination_blocklist`);
  blockCache = { at: Date.now(), rules: r.rows };
  return blockCache.rules;
}

export async function findRateSql(db: Db, number: string): Promise<Rate | null> {
  const r = await db.query(
    `SELECT id, prefix, description, rate_per_min_micros, connect_fee_micros, initial_increment, billing_increment
       FROM rate_deck
      WHERE $1 LIKE prefix || '%' AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
      ORDER BY length(prefix) DESC, effective_from DESC LIMIT 1`,
    [number],
  );
  if (!r.rowCount) return null;
  const x = r.rows[0];
  return {
    id: x.id, prefix: x.prefix, description: x.description, ratePerMinMicros: x.rate_per_min_micros,
    connectFeeMicros: x.connect_fee_micros, initialIncrement: x.initial_increment, billingIncrement: x.billing_increment,
  };
}

export interface AuthorizeInput { callId: string; aor: string; authUsername: string; destination: string }

export async function authorizeOutbound(input: AuthorizeInput, policy: FraudPolicy = DEFAULT_FRAUD_POLICY): Promise<AuthorizeResponse> {
  return tx(async (c) => {
    const existing = await c.query(
      `SELECT id, max_duration_sec, caller_id, destination, status FROM call_authorizations WHERE sip_call_id=$1`, [input.callId]);
    if (existing.rowCount) {
      const e = existing.rows[0];
      if (e.status !== 'open') return deny('duplicate_call_id', 'call already finished');
      return { allow: true, auth_id: e.id, max_duration: e.max_duration_sec, caller_id: e.caller_id, ruri_user: config.SIPNAV_TECH_PREFIX + e.destination, destination: e.destination };
    }

    const u = await c.query(
      `SELECT u.id, u.status, u.created_at FROM users u JOIN sip_credentials s ON s.user_id=u.id
        WHERE u.sip_aor=$1 AND s.auth_username=$2 AND s.revoked_at IS NULL`,
      [input.aor, input.authUsername],
    );
    if (!u.rowCount) return deny('unknown_user', 'unknown SIP user');
    const user = u.rows[0];

    // Umar rule #1: KYC before any call.
    const kyc = evaluateKyc(await loadKycChecks(c, user.id), 'place_call');
    if (!kyc.allowed) return deny('kyc_required', `KYC incomplete: ${[...kyc.missing, ...kyc.failed].join(',')}`);

    const dest = normalizeDialed(input.destination, policy.homeCountryCode);
    if (!dest) return deny('invalid_number', 'invalid destination', 484);

    const cid = await c.query(
      `SELECT p.e164 FROM did_assignments a JOIN did_pool p ON p.id=a.did_id
        WHERE a.user_id=$1 AND a.status='active' ORDER BY a.is_primary_cid DESC, a.created_at LIMIT 1`,
      [user.id],
    );
    if (!cid.rowCount) return deny('no_number', 'buy a number first: it is your caller ID');
    const callerId: string = cid.rows[0].e164;

    // Serialise per-user decisions: lock the wallet first, then count.
    const wallet = await lockWallet(c, user.id);
    const stats = await c.query(
      `SELECT
         count(*) FILTER (WHERE status='open')::int AS open_calls, -- inbound + outbound share the concurrency limit
         count(*) FILTER (WHERE direction='outbound' AND created_at > now() - interval '1 minute')::int AS last_min,
         count(*) FILTER (WHERE direction='outbound' AND created_at > now() - interval '1 hour')::int AS last_hour,
         count(DISTINCT destination) FILTER (WHERE direction='outbound' AND created_at > now() - interval '1 hour')::int AS distinct_hour,
         bool_or(direction='outbound' AND destination=$2 AND created_at > now() - interval '1 hour') AS seen
       FROM call_authorizations WHERE user_id=$1 AND created_at > now() - interval '1 day'`,
      [user.id, dest],
    );
    const spend = await c.query(
      `SELECT COALESCE(-sum(amount_micros),0)::bigint AS s FROM ledger_entries
        WHERE user_id=$1 AND kind='call' AND created_at > now() - interval '1 day'`,
      [user.id],
    );
    const s = stats.rows[0];
    const fraud = checkFraud(
      {
        destination: dest, accountCreatedAt: user.created_at, now: new Date(), userStatus: user.status,
        openCalls: s.open_calls, callsLastMinute: s.last_min, callsLastHour: s.last_hour,
        distinctDestLastHour: s.distinct_hour, destSeenLastHour: !!s.seen, spend24hMicros: Number(spend.rows[0].s),
      },
      await blocklist(c),
      policy,
    );
    if (!fraud.allowed) return deny(fraud.code, fraud.reason);

    // Umar rule #2: prepaid only, per-call pre-auth caps max duration.
    const rate = await findRateSql(c, dest);
    const pa = preauthorize(wallet, rate, {
      maxCallSeconds: config.MAX_CALL_SECONDS,
      minCallSeconds: config.MIN_CALL_SECONDS,
      perCallReserveCapMicros: fraud.perCallReserveCapMicros,
    });
    if (!pa.ok) return pa.reason === 'no_rate' ? deny('no_rate', 'destination not supported', 404) : deny('insufficient_balance', 'top up to call', 402);

    await addHold(c, user.id, pa.reserveMicros);
    const ins = await c.query(
      `INSERT INTO call_authorizations (user_id, sip_call_id, direction, caller_id, destination, rate_id, rate_snapshot, max_duration_sec, reserved_micros)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8) RETURNING id`,
      [user.id, input.callId, callerId, dest, rate!.id ?? null, JSON.stringify(rate), pa.maxDurationSec, pa.reserveMicros],
    );
    return {
      allow: true, auth_id: ins.rows[0].id, max_duration: pa.maxDurationSec, caller_id: callerId,
      ruri_user: config.SIPNAV_TECH_PREFIX + dest, destination: dest,
    };
  });
}

/** Inbound from SIPNAV: DID -> owner AoR. Number must be on an active (or past_due grace) assignment. */
export async function lookupInbound(db: Db, didRaw: string, callId: string, from: string) {
  let did = didRaw.replace(/^\+/, '');
  const tp = config.SIPNAV_TECH_PREFIX;
  if (tp && did.startsWith(tp)) did = did.slice(tp.length);
  const r = await db.query(
    `SELECT u.id, u.sip_aor, u.status FROM did_pool p
       JOIN did_assignments a ON a.did_id=p.id AND a.status='active'
       JOIN users u ON u.id=a.user_id
      WHERE p.e164=$1`,
    [did],
  );
  if (!r.rowCount || r.rows[0].status !== 'active') return { allow: false as const, code: 'not_assigned', sip_code: 404 };
  await db.query(
    `INSERT INTO call_authorizations (user_id, sip_call_id, direction, caller_id, destination, max_duration_sec, reserved_micros)
     VALUES ($1,$2,'inbound',$3,$4,$5,0) ON CONFLICT (sip_call_id) DO NOTHING`,
    [r.rows[0].id, callId, from.replace(/\D/g, '').slice(0, 20), did, config.MAX_CALL_SECONDS],
  );
  return { allow: true as const, aor: r.rows[0].sip_aor as string, did };
}

export interface EndCallInput {
  callId: string; billsec: number; sipCode?: number; hangupCause?: string;
  startTime?: string; answerTime?: string; endTime?: string;
}

/** Settles the hold and writes the CDR. Idempotent on call id. */
export async function endCall(input: EndCallInput) {
  return tx(async (c: pg.PoolClient) => {
    const a = await c.query(`SELECT * FROM call_authorizations WHERE sip_call_id=$1 FOR UPDATE`, [input.callId]);
    if (!a.rowCount) return { ok: false, code: 'unknown_call' };
    const auth = a.rows[0];
    if (auth.status !== 'open') return { ok: true, duplicate: true };

    const billsec = Math.max(0, Math.round(input.billsec));
    let charge = 0, billable = 0, overrun = 0;
    const rate: Rate | null = auth.rate_snapshot;
    if (auth.direction === 'outbound' && rate) {
      const s = settle(Number(auth.reserved_micros), billsec, rate);
      charge = s.chargeMicros; overrun = s.overrunMicros;
      billable = billableSeconds(Math.min(billsec, Number(auth.max_duration_sec)), rate);
      await postLedger(c, auth.user_id, 'call', -charge, {
        releaseHeldMicros: Number(auth.reserved_micros), idempotencyKey: `call:${auth.id}`,
        refType: 'call', refId: auth.id, memo: `Call to +${auth.destination} (${billsec}s)`,
      });
    }
    await c.query(`UPDATE call_authorizations SET status='settled', settled_at=now() WHERE id=$1`, [auth.id]);
    await c.query(
      `INSERT INTO cdrs (authorization_id, user_id, sip_call_id, direction, caller_id, destination, start_time, answer_time, end_time,
                         billsec, billable_sec, sip_code, hangup_cause, charged_micros, rate_per_min_micros)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (sip_call_id) DO NOTHING`,
      [auth.id, auth.user_id, input.callId, auth.direction, auth.caller_id, auth.destination,
       input.startTime ?? null, input.answerTime ?? null, input.endTime ?? new Date().toISOString(),
       billsec, billable, input.sipCode ?? null, input.hangupCause ?? null, charge, rate?.ratePerMinMicros ?? null],
    );
    return { ok: true, charged_micros: charge, overrun_micros: overrun };
  });
}

/** Safety net: holds whose CDR never arrived are released after max duration + 10 min (flagged for reconciliation). */
export async function expireStaleAuthorizations(c: pg.PoolClient) {
  const r = await c.query(
    `SELECT id, user_id, reserved_micros FROM call_authorizations
      WHERE status='open' AND created_at + make_interval(secs => max_duration_sec + 600) < now() FOR UPDATE`,
  );
  for (const x of r.rows) {
    if (Number(x.reserved_micros) > 0) await postLedger(c, x.user_id, 'call', 0, { releaseHeldMicros: Number(x.reserved_micros) });
    await c.query(`UPDATE call_authorizations SET status='expired', settled_at=now() WHERE id=$1`, [x.id]);
  }
  return r.rowCount ?? 0;
}
