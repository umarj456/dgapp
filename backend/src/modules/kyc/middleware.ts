import type { FastifyReply, FastifyRequest } from 'fastify';
import { evaluateKyc, type CountryRequirement, type KycAction, type KycCheck } from './gate.js';

export interface KycDeps {
  loadChecks(userId: string): Promise<KycCheck[]>;
  loadCountryRequirement(country: string): Promise<CountryRequirement | null>;
}

/**
 * Fastify preHandler factory. Requires request.user (set by auth). For buy_did, the DID country is
 * resolved by `countryOf(request)` so country-specific ID/address rules apply.
 */
export function requireKyc(
  deps: KycDeps,
  action: KycAction,
  countryOf?: (req: FastifyRequest) => Promise<string | null> | string | null,
) {
  return async function kycGate(req: FastifyRequest, reply: FastifyReply) {
    const user = req.user;
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    const checks = await deps.loadChecks(user.id);
    const country = countryOf ? await countryOf(req) : null;
    const reqmt = country ? await deps.loadCountryRequirement(country) : null;
    const d = evaluateKyc(checks, action, reqmt);
    if (!d.allowed) {
      return reply.code(403).send({ error: 'kyc_required', action, missing: d.missing, failed: d.failed });
    }
  };
}
