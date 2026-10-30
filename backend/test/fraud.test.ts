import { describe, expect, it } from 'vitest';
import { checkFraud, DEFAULT_FRAUD_POLICY as P, type BlockRule, type FraudContext } from '../src/modules/fraud/fraud.js';

const now = new Date('2026-10-23T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const block: BlockRule[] = [
  { prefix: '1900', reason: 'US premium', action: 'block' },
  { prefix: '882', reason: 'intl networks', action: 'block' },
  { prefix: '1876', reason: 'Jamaica IRSF', action: 'established_only' },
];
const ctx = (o: Partial<FraudContext> = {}): FraudContext => ({
  destination: '12125550100', accountCreatedAt: daysAgo(60), now, openCalls: 0, callsLastMinute: 0, callsLastHour: 0,
  distinctDestLastHour: 0, destSeenLastHour: false, spend24hMicros: 0, userStatus: 'active', ...o,
});

describe('destination blocklist (IRSF)', () => {
  it('blocks premium / IRSF prefixes', () => {
    expect(checkFraud(ctx({ destination: '19005551234' }), block)).toMatchObject({ allowed: false, code: 'destination_blocked' });
    expect(checkFraud(ctx({ destination: '8821234567' }), block)).toMatchObject({ allowed: false, code: 'destination_blocked' });
  });
  it('established_only allows old accounts and refuses young ones', () => {
    expect(checkFraud(ctx({ destination: '18765551234' }), block).allowed).toBe(true);
    expect(checkFraud(ctx({ destination: '18765551234', accountCreatedAt: daysAgo(10) }), block)).toMatchObject({ code: 'destination_restricted' });
  });
  it('normal destinations pass', () => {
    expect(checkFraud(ctx(), block)).toMatchObject({ allowed: true, isNewAccount: false });
  });
});

describe('account state', () => {
  it('suspended accounts cannot call', () => {
    expect(checkFraud(ctx({ userStatus: 'suspended' }), block)).toMatchObject({ allowed: false, code: 'account_suspended' });
  });
});

describe('concurrency + velocity (established account)', () => {
  const L = P.standard;
  it('concurrency limit', () => {
    expect(checkFraud(ctx({ openCalls: L.maxConcurrent - 1 }), block).allowed).toBe(true);
    expect(checkFraud(ctx({ openCalls: L.maxConcurrent }), block)).toMatchObject({ code: 'concurrency_limit' });
  });
  it('per-minute and per-hour limits', () => {
    expect(checkFraud(ctx({ callsLastMinute: L.maxCallsPerMinute }), block)).toMatchObject({ code: 'velocity_minute' });
    expect(checkFraud(ctx({ callsLastHour: L.maxCallsPerHour }), block)).toMatchObject({ code: 'velocity_hour' });
  });
  it('distinct destinations per hour (robocall pattern), re-dialling a seen number is fine', () => {
    expect(checkFraud(ctx({ distinctDestLastHour: L.maxDistinctDestPerHour }), block)).toMatchObject({ code: 'velocity_distinct' });
    expect(checkFraud(ctx({ distinctDestLastHour: L.maxDistinctDestPerHour, destSeenLastHour: true }), block).allowed).toBe(true);
  });
  it('24h spend cap', () => {
    expect(checkFraud(ctx({ spend24hMicros: L.maxSpend24hMicros }), block)).toMatchObject({ code: 'spend_cap' });
  });
});

describe('new-account caps', () => {
  const fresh = (o: Partial<FraudContext> = {}) => ctx({ accountCreatedAt: daysAgo(1), ...o });
  it('1 concurrent call only', () => {
    expect(checkFraud(fresh({ openCalls: 1 }), block)).toMatchObject({ code: 'concurrency_limit' });
  });
  it('no international calls in the first days', () => {
    expect(checkFraud(fresh({ destination: '447700900123' }), block)).toMatchObject({ code: 'new_account_international' });
    expect(checkFraud(ctx({ destination: '447700900123' }), block).allowed).toBe(true);
  });
  it('lower velocity + spend limits and a per-call reserve cap', () => {
    expect(checkFraud(fresh({ callsLastMinute: P.newAccount.maxCallsPerMinute }), block)).toMatchObject({ code: 'velocity_minute' });
    expect(checkFraud(fresh({ spend24hMicros: P.newAccount.maxSpend24hMicros }), block)).toMatchObject({ code: 'spend_cap' });
    const d = checkFraud(fresh({ spend24hMicros: 9_000_000 }), block);
    expect(d).toMatchObject({ allowed: true, isNewAccount: true, perCallReserveCapMicros: 1_000_000 });
  });
  it('graduates after newAccountDays', () => {
    expect(checkFraud(ctx({ accountCreatedAt: daysAgo(P.newAccountDays), openCalls: 1 }), block)).toMatchObject({ allowed: true, isNewAccount: false });
  });
});
