/**
 * Internal API for the Kamailio edge (and ops). Protected by a shared bearer token AND a source-IP allow-list.
 * Never expose these paths publicly: the edge reaches the API over the private network.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { safeEqual } from '../lib/crypto.js';
import { authorizeOutbound, endCall, expireStaleAuthorizations, lookupInbound } from './calls/service.js';
import { runDidMaintenance } from './dids/service.js';
import { importPool, poolEntrySchema, poolStats, setPoolStatus } from './dids/pool-admin.js';
import { recordKycCheck } from './kyc/repo.js';
import { lookupHa1 } from './sip/service.js';

const allowedIps = new Set(config.INTERNAL_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean));

export function internalGuard(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!allowedIps.has(req.ip) || !safeEqual(token, config.INTERNAL_API_TOKEN)) {
    reply.code(403).send({ error: 'forbidden' });
    return;
  }
  done();
}

export async function internalRoutes(app: FastifyInstance) {
  app.addHook('onRequest', internalGuard);

  // Digest auth for REGISTER / INVITE from WebRTC clients.
  app.get('/internal/v1/sip/auth', async (req, reply) => {
    const { username } = z.object({ username: z.string().min(1).max(64) }).parse(req.query);
    const r = await lookupHa1(pool, username);
    if (!r) return reply.code(404).send({ found: 0 });
    return { found: 1, ha1: r.ha1, aor: r.aor };
  });

  // Outbound pre-auth: KYC + fraud + rate + prepaid hold.
  app.post('/internal/v1/calls/authorize', async (req) => {
    const b = z.object({
      call_id: z.string().min(1).max(255), aor: z.string().min(1), auth_username: z.string().min(1), destination: z.string().min(1).max(32),
    }).parse(req.body);
    const r = await authorizeOutbound({ callId: b.call_id, aor: b.aor, authUsername: b.auth_username, destination: b.destination });
    // flat JSON with numeric 'allow' is easiest for Kamailio's jansson json_get_field
    return { ...r, allow: r.allow ? 1 : 0 };
  });

  // Inbound DID from SIPNAV -> owner's AoR.
  app.post('/internal/v1/calls/inbound', async (req) => {
    const b = z.object({ call_id: z.string().min(1), did: z.string().min(1), from: z.string().default('') }).parse(req.body);
    const r = await lookupInbound(pool, b.did, b.call_id, b.from);
    return { ...r, allow: r.allow ? 1 : 0 };
  });

  // End of call: settle and CDR.
  app.post('/internal/v1/calls/end', async (req) => {
    const b = z.object({
      call_id: z.string().min(1), billsec: z.coerce.number().min(0), sip_code: z.coerce.number().int().optional(),
      hangup_cause: z.string().optional(), start_time: z.string().optional(), answer_time: z.string().optional(), end_time: z.string().optional(),
    }).parse(req.body);
    return endCall({ callId: b.call_id, billsec: b.billsec, sipCode: b.sip_code, hangupCause: b.hangup_cause, startTime: b.start_time, answerTime: b.answer_time, endTime: b.end_time });
  });

  // Ops: manual KYC review for ID / address documents.
  app.post('/internal/v1/kyc/review', async (req) => {
    const b = z.object({
      user_id: z.string().uuid(), check_type: z.enum(['id_document', 'address']), status: z.enum(['passed', 'failed']),
      country: z.string().length(2).optional(), reviewer: z.string().min(1),
    }).parse(req.body);
    await recordKycCheck(pool, b.user_id, b.check_type, b.status, { provider: 'manual', country: b.country, details: { reviewer: b.reviewer } });
    return { ok: true };
  });

  // Ops / cron: renewals, cooldown recycling, stale hold release.
  // ---- DID pool admin (DB only; never calls SIPNAV) ----
  app.get('/internal/v1/dids/pool', async () => poolStats(pool));

  app.post('/internal/v1/dids/pool/import', async (req) => {
    const b = z.object({ numbers: z.array(poolEntrySchema).min(1).max(5000) }).parse(req.body);
    return tx((c) => importPool(c, b.numbers));
  });

  app.post('/internal/v1/dids/pool/:e164/status', async (req, reply) => {
    const { e164 } = z.object({ e164: z.string() }).parse(req.params);
    const { status } = z.object({ status: z.enum(['disabled', 'available']) }).parse(req.body);
    const r = await setPoolStatus(pool, e164, status);
    if (!r) return reply.code(409).send({ error: 'not_changeable', details: 'unknown number or currently assigned/reserved' });
    return r;
  });

  app.post('/internal/v1/jobs/maintenance', async () => {
    await tx((c) => runDidMaintenance(c));
    const expired = await tx((c) => expireStaleAuthorizations(c));
    return { ok: true, expiredHolds: expired };
  });
}
