/**
 * End-to-end API flow against a real Postgres. Skipped unless TEST_DATABASE_URL is set, e.g.
 *   TEST_DATABASE_URL=postgres://dgapp:dgapp@localhost:5432/dgapp_test npm test
 * WARNING: the target database is WIPED (schema public dropped) at the start.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('API integration (real Postgres)', () => {
  let app: any, otp: any, pool: any;
  let token = '';
  const H = () => ({ authorization: `Bearer ${token}` });
  const I = { authorization: 'Bearer test-internal-token' };
  let sipUser = '', aor = '', userId = '', didE164 = '';

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: url, MIGRATE_DEV_SEED: 'true', INTERNAL_API_TOKEN: 'test-internal-token', STRIPE_STUB_MODE: 'true', NODE_ENV: 'test',
    });
    ({ pool } = await import('../src/db.js'));
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const { migrate } = await import('../src/migrate.js');
    await migrate();
    const { ConsoleOtpProvider } = await import('../src/modules/auth/otp-provider.js');
    otp = new ConsoleOtpProvider();
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ otp, logger: false });
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  const webhook = (ev: object) => app.inject({ method: 'POST', url: '/v1/stripe/webhook', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(ev) });
  const authorize = (destination: string, call_id: string) => app.inject({
    method: 'POST', url: '/internal/v1/calls/authorize', headers: I, payload: { call_id, aor, auth_username: sipUser, destination },
  });

  it('signs up with email OTP', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/auth/email/start', payload: { email: 'Test@Example.com' } })).statusCode).toBe(200);
    const code: string = otp.last.get('test@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await app.inject({ method: 'POST', url: '/v1/auth/email/verify', payload: { email: 'test@example.com', code: wrong } })).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/email/verify', payload: { email: 'test@example.com', code } });
    expect(res.statusCode).toBe(200);
    token = res.json().token;
    const me = (await app.inject({ url: '/v1/me', headers: H() })).json();
    userId = me.id; aor = me.sipAor;
    expect(me.numbers).toEqual([]);
    expect(me.kyc).toMatchObject({ canCall: false, missing: ['phone'] });
  });

  it('issues SIP device credentials and serves HA1 to the edge only', async () => {
    const c = (await app.inject({ method: 'POST', url: '/v1/sip/credentials', headers: H(), payload: { deviceLabel: 'test' } })).json();
    sipUser = c.authUsername;
    expect(c.password).toBeTruthy();
    expect((await app.inject({ url: `/internal/v1/sip/auth?username=${sipUser}` })).statusCode).toBe(403);
    const r = (await app.inject({ url: `/internal/v1/sip/auth?username=${sipUser}`, headers: I })).json();
    expect(r).toMatchObject({ found: 1, aor });
    expect(r.ha1).toMatch(/^[a-f0-9]{32}$/);
  });

  it('refuses calls and DID purchase before KYC', async () => {
    expect((await authorize('12125550199', 'c-0')).json()).toMatchObject({ allow: 0, code: 'kyc_required' });
    const did = (await app.inject({ url: '/v1/dids/search?country=US', headers: H() })).json()[0];
    const buy = await app.inject({ method: 'POST', url: '/v1/dids/buy', headers: H(), payload: { didId: did.id } });
    expect(buy.statusCode).toBe(403);
    expect(buy.json().error).toBe('kyc_required');
  });

  it('completes phone OTP + payment method (Stripe stub webhook) + top-up', async () => {
    await app.inject({ method: 'POST', url: '/v1/me/phone/start', headers: H(), payload: { phone: '+923001234567' } });
    const code = otp.last.get('+923001234567');
    expect((await app.inject({ method: 'POST', url: '/v1/me/phone/verify', headers: H(), payload: { phone: '+923001234567', code } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/me', headers: H() })).json().kyc.canCall).toBe(true);
    await webhook({ id: 'evt_1', type: 'setup_intent.succeeded', data: { object: { id: 'seti_1', metadata: { user_id: userId } } } });
    const topup = { id: 'evt_2', type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'paid', amount_total: 1000, metadata: { kind: 'topup', user_id: userId } } } };
    expect((await webhook(topup)).json().duplicate).toBe(false);
    expect((await webhook(topup)).json().duplicate).toBe(true); // idempotent
    const me = (await app.inject({ url: '/v1/me', headers: H() })).json();
    expect(me.kyc.canCall).toBe(true);
    expect(me.wallet.balanceUsd).toBe('10.0000');
  });

  it('cannot call without a number (caller ID), then buys one from the pool with wallet', async () => {
    expect((await authorize('12125550199', 'c-1')).json()).toMatchObject({ allow: 0, code: 'no_number' });
    const did = (await app.inject({ url: '/v1/dids/search?country=US&region=NY-212', headers: H() })).json()[0];
    const buy = await app.inject({ method: 'POST', url: '/v1/dids/buy', headers: H(), payload: { didId: did.id, billing: 'wallet' } });
    expect(buy.statusCode).toBe(200);
    didE164 = buy.json().e164;
    expect((await app.inject({ method: 'POST', url: '/v1/dids/buy', headers: H(), payload: { didId: did.id } })).statusCode).toBe(409);
    const mine = (await app.inject({ url: '/v1/dids/mine', headers: H() })).json();
    expect(mine[0].auto_renew).toBe(true);
    const daysLeft = (new Date(mine[0].current_period_end).getTime() - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThan(29);
    expect(daysLeft).toBeLessThan(31);
    expect((await app.inject({ url: '/v1/me', headers: H() })).json().wallet.balanceUsd).toBe('5.0000');
  });

  it('authorizes an outbound call with a prepaid hold, then settles on hangup', async () => {
    const a = (await authorize('(212) 555-0199', 'c-2')).json();
    expect(a).toMatchObject({ allow: 1, caller_id: didE164, ruri_user: '05436#12125550199', destination: '12125550199' });
    // new account: per-call hold capped at $2 => at $0.01/min = 200 min = 12000 s
    expect(a.max_duration).toBe(12_000);
    expect((await app.inject({ url: '/v1/me', headers: H() })).json().wallet.availableUsd).toBe('3.0000');
    expect((await authorize('12125550198', 'c-3')).json()).toMatchObject({ allow: 0, code: 'concurrency_limit' });
    const end = (await app.inject({ method: 'POST', url: '/internal/v1/calls/end', headers: I, payload: { call_id: 'c-2', billsec: 45, sip_code: 200 } })).json();
    expect(end).toMatchObject({ ok: true, charged_micros: 8_000 });
    expect((await app.inject({ method: 'POST', url: '/internal/v1/calls/end', headers: I, payload: { call_id: 'c-2', billsec: 45 } })).json().duplicate).toBe(true);
    const me = (await app.inject({ url: '/v1/me', headers: H() })).json();
    expect(me.wallet).toMatchObject({ balanceUsd: '4.9920', availableUsd: '4.9920' });
    const cdr = await pool.query(`SELECT billsec, billable_sec, charged_micros FROM cdrs WHERE sip_call_id='c-2'`);
    expect(cdr.rows[0]).toMatchObject({ billsec: 45, billable_sec: 48, charged_micros: 8_000 });
  });

  it('fraud: blocks IRSF/premium and international on a new account', async () => {
    expect((await authorize('19005550100', 'c-4')).json()).toMatchObject({ allow: 0, code: 'destination_blocked' });
    expect((await authorize('+447700900123', 'c-5')).json()).toMatchObject({ allow: 0, code: 'new_account_international' });
  });

  it('routes an inbound DID to the owner and rejects unassigned DIDs', async () => {
    const r = (await app.inject({ method: 'POST', url: '/internal/v1/calls/inbound', headers: I, payload: { call_id: 'in-1', did: '+' + didE164, from: '13105550000' } })).json();
    expect(r).toMatchObject({ allow: 1, aor });
    const no = (await app.inject({ method: 'POST', url: '/internal/v1/calls/inbound', headers: I, payload: { call_id: 'in-2', did: '17135550105' } })).json();
    expect(no).toMatchObject({ allow: 0, code: 'not_assigned' });
    // inbound is free; ending it writes a CDR and frees the concurrency slot
    expect((await app.inject({ method: 'POST', url: '/internal/v1/calls/end', headers: I, payload: { call_id: 'in-1', billsec: 30 } })).json()).toMatchObject({ ok: true, charged_micros: 0 });
  });

  it('blocks at zero balance', async () => {
    await pool.query(`UPDATE wallets SET balance_micros=0, held_micros=0 WHERE user_id=$1`, [userId]);
    expect((await authorize('12125550199', 'c-6')).json()).toMatchObject({ allow: 0, code: 'insufficient_balance', sip_code: 402 });
  });

  it('imports DIDs into the pool via the internal admin API and can disable them', async () => {
    const imp = await app.inject({ method: 'POST', url: '/internal/v1/dids/pool/import', headers: I, payload: { numbers: [
      { e164: '+1 (646) 555-0199', country: 'us', region: 'NY-646', monthlyPriceMicros: 5000000 },
    ] } });
    expect(imp.json()).toEqual({ inserted: 1, updated: 0 });
    const again = await app.inject({ method: 'POST', url: '/internal/v1/dids/pool/import', headers: I, payload: { numbers: [{ e164: '16465550199', country: 'US', monthlyPriceMicros: 6000000 }] } });
    expect(again.json()).toEqual({ inserted: 0, updated: 1 });
    expect((await app.inject({ method: 'POST', url: '/internal/v1/dids/pool/16465550199/status', headers: I, payload: { status: 'disabled' } })).json().status).toBe('disabled');
    expect((await app.inject({ method: 'POST', url: `/internal/v1/dids/pool/${didE164}/status`, headers: I, payload: { status: 'disabled' } })).statusCode).toBe(409);
    expect((await app.inject({ url: '/internal/v1/dids/pool', headers: I })).statusCode).toBe(200);
    expect((await app.inject({ url: '/internal/v1/dids/pool', headers: H() })).statusCode).toBe(403);
  });

  it('releases a number into cooldown and runs maintenance', async () => {
    const mine = (await app.inject({ url: '/v1/dids/mine', headers: H() })).json();
    expect((await app.inject({ method: 'POST', url: `/v1/dids/${mine[0].assignment_id}/release`, headers: H() })).statusCode).toBe(200);
    const st = await pool.query(`SELECT status FROM did_pool WHERE e164=$1`, [didE164]);
    expect(st.rows[0].status).toBe('cooldown');
    expect((await app.inject({ method: 'POST', url: '/internal/v1/jobs/maintenance', headers: I })).json().ok).toBe(true);
  });
});
