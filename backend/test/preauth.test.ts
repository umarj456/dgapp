import { describe, expect, it } from 'vitest';
import { applySettle, availableMicros, preauthorize, settle } from '../src/modules/rating/preauth.js';
import { callCost, type Rate } from '../src/modules/rating/rating.js';

const us: Rate = { prefix: '1', ratePerMinMicros: 10_000, connectFeeMicros: 0, initialIncrement: 6, billingIncrement: 6 };
const policy = { maxCallSeconds: 14_400, minCallSeconds: 6 };

describe('pre-authorization (prepaid only)', () => {
  it('blocks at zero balance', () => {
    expect(preauthorize({ balanceMicros: 0, heldMicros: 0 }, us, policy)).toEqual({ ok: false, reason: 'insufficient_balance' });
  });
  it('blocks when everything is already held by other calls', () => {
    expect(preauthorize({ balanceMicros: 50_000, heldMicros: 50_000 }, us, policy).ok).toBe(false);
  });
  it('blocks when no rate exists for the destination', () => {
    expect(preauthorize({ balanceMicros: 50_000, heldMicros: 0 }, null, policy)).toEqual({ ok: false, reason: 'no_rate' });
  });
  it('caps max duration to the available balance and reserves its cost', () => {
    const p = preauthorize({ balanceMicros: 100_000, heldMicros: 40_000 }, us, policy); // $0.06 available
    expect(p).toEqual({ ok: true, maxDurationSec: 360, reserveMicros: 60_000 });
  });
  it('never reserves more than available', () => {
    for (let bal = 1_000; bal < 200_000; bal += 1_337) {
      const w = { balanceMicros: bal, heldMicros: 0 };
      const p = preauthorize(w, us, policy);
      if (p.ok) expect(p.reserveMicros).toBeLessThanOrEqual(availableMicros(w));
    }
  });
  it('honours the absolute cap', () => {
    const p = preauthorize({ balanceMicros: 1e12, heldMicros: 0 }, us, policy);
    expect(p.ok && p.maxDurationSec).toBe(14_400);
  });
  it('honours a per-call reserve cap (new-account limit)', () => {
    const p = preauthorize({ balanceMicros: 50_000_000, heldMicros: 0 }, us, { ...policy, perCallReserveCapMicros: 20_000 });
    expect(p).toEqual({ ok: true, maxDurationSec: 120, reserveMicros: 20_000 });
  });
  it('refuses if the balance cannot cover minCallSeconds', () => {
    const p = preauthorize({ balanceMicros: 1_000, heldMicros: 0 }, us, { maxCallSeconds: 14_400, minCallSeconds: 30 });
    expect(p.ok).toBe(false);
  });
});

describe('settlement', () => {
  it('charges the actual cost and releases the full hold', () => {
    const w0 = { balanceMicros: 100_000, heldMicros: 60_000 };
    const s = settle(60_000, 45, us);
    expect(s).toEqual({ chargeMicros: callCost(45, us), releaseMicros: 60_000, overrunMicros: 0, billedSec: 45 });
    expect(applySettle(w0, s)).toEqual({ balanceMicros: 100_000 - 8_000, heldMicros: 0 });
  });
  it('unanswered call costs nothing', () => {
    expect(settle(60_000, 0, us).chargeMicros).toBe(0);
  });
  it('never charges above the reservation (balance can not go negative)', () => {
    const s = settle(60_000, 1_000, us);
    expect(s.chargeMicros).toBe(60_000);
    expect(s.overrunMicros).toBe(callCost(1_000, us) - 60_000);
    expect(applySettle({ balanceMicros: 60_000, heldMicros: 60_000 }, s).balanceMicros).toBe(0);
  });
});
