import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { evaluateKyc, type CountryRequirement, type KycCheck } from '../src/modules/kyc/gate.js';
import { requireKyc } from '../src/modules/kyc/middleware.js';

const t = (n: number) => new Date(2026, 0, 1, 0, 0, n);
const pass = (checkType: KycCheck['checkType'], n = 1, country?: string): KycCheck => ({ checkType, status: 'passed', createdAt: t(n), country });
const base = [pass('email'), pass('phone')];
const DE: CountryRequirement = { country: 'DE', requiresId: true, requiresAddress: true, addressMustBeLocal: true };
const GB: CountryRequirement = { country: 'GB', requiresId: false, requiresAddress: true, addressMustBeLocal: false };

describe('KYC gate rules', () => {
  it('new user can do nothing', () => {
    const d = evaluateKyc([], 'place_call');
    expect(d.allowed).toBe(false);
    expect(d.missing).toEqual(['email', 'phone']);
  });
  it('email + phone is enough to call and to buy a US number', () => {
    expect(evaluateKyc([pass('email'), pass('phone')], 'place_call').allowed).toBe(true);
    expect(evaluateKyc([pass('email'), pass('phone')], 'buy_did', { country: 'US', requiresId: false, requiresAddress: false, addressMustBeLocal: false }).allowed).toBe(true);
  });
  it('base checks allow calls and US numbers', () => {
    expect(evaluateKyc(base, 'place_call').allowed).toBe(true);
    expect(evaluateKyc(base, 'buy_did', { country: 'US', requiresId: false, requiresAddress: false, addressMustBeLocal: false }).allowed).toBe(true);
  });
  it('country that needs ID + local address', () => {
    expect(evaluateKyc(base, 'buy_did', DE)).toMatchObject({ allowed: false, missing: ['id_document', 'address'] });
    expect(evaluateKyc([...base, pass('id_document', 2), pass('address', 2, 'PK')], 'buy_did', DE)).toMatchObject({ allowed: false, failed: ['address'] });
    expect(evaluateKyc([...base, pass('id_document', 2), pass('address', 2, 'DE')], 'buy_did', DE).allowed).toBe(true);
  });
  it('address required but may be foreign', () => {
    expect(evaluateKyc([...base, pass('address', 2, 'PK')], 'buy_did', GB).allowed).toBe(true);
  });
  it('pending counts as missing; latest result wins', () => {
    const pending: KycCheck = { checkType: 'phone', status: 'pending', createdAt: t(5) };
    expect(evaluateKyc([pass('email'), pending], 'place_call').missing).toEqual(['phone']);
    const revoked: KycCheck = { checkType: 'phone', status: 'failed', createdAt: t(9) };
    expect(evaluateKyc([pass('email'), pass('phone'), revoked], 'place_call')).toMatchObject({ allowed: false, failed: ['phone'] });
    expect(evaluateKyc([pass('email'), revoked, pass('phone', 10)], 'place_call').allowed).toBe(true);
  });
});

describe('KYC gate middleware', () => {
  async function appWith(checks: KycCheck[], req: CountryRequirement | null = null) {
    const app = Fastify();
    app.addHook('preHandler', async (r) => { if (r.headers['x-user']) r.user = { id: 'u1', email: 'a@b.c', sipAor: 'ux', status: 'active' }; });
    const deps = { loadChecks: async () => checks, loadCountryRequirement: async () => req };
    app.post('/buy', { preHandler: requireKyc(deps, 'buy_did', () => 'DE') }, async () => ({ bought: true }));
    app.post('/call', { preHandler: requireKyc(deps, 'place_call') }, async () => ({ called: true }));
    return app;
  }
  it('401 without a user', async () => {
    const app = await appWith(base);
    expect((await app.inject({ method: 'POST', url: '/call' })).statusCode).toBe(401);
  });
  it('403 kyc_required lists what is missing', async () => {
    const app = await appWith([pass('email')]);
    const res = await app.inject({ method: 'POST', url: '/call', headers: { 'x-user': '1' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'kyc_required', missing: ['phone'] });
  });
  it('applies the DID country requirement on buy', async () => {
    const app = await appWith(base, DE);
    const res = await app.inject({ method: 'POST', url: '/buy', headers: { 'x-user': '1' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().missing).toEqual(['id_document', 'address']);
    expect((await app.inject({ method: 'POST', url: '/call', headers: { 'x-user': '1' } })).statusCode).toBe(200);
  });
});
