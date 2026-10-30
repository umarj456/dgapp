/**
 * Fraud controls (pure). Inputs are gathered by the DB layer; this decides.
 *  - IRSF / high-risk destination blocklist (longest prefix)
 *  - concurrency limit (open authorizations)
 *  - velocity limits (calls per minute / hour, distinct destinations per hour)
 *  - new-account caps (lower limits, spend cap, no international) for the first N days
 */
import { findRate } from '../rating/rating.js';

export interface BlockRule { prefix: string; reason: string; action: 'block' | 'established_only' }

export interface FraudLimits {
  maxConcurrent: number;
  maxCallsPerMinute: number;
  maxCallsPerHour: number;
  maxDistinctDestPerHour: number;
  maxSpend24hMicros: number;
}

export interface FraudPolicy {
  standard: FraudLimits;
  newAccount: FraudLimits & { allowInternational: boolean; perCallReserveCapMicros: number };
  newAccountDays: number;
  homeCountryCode: string; // calling code treated as domestic, e.g. '1'
  establishedDays: number; // account age needed for 'established_only' destinations
}

export const DEFAULT_FRAUD_POLICY: FraudPolicy = {
  standard: { maxConcurrent: 3, maxCallsPerMinute: 10, maxCallsPerHour: 200, maxDistinctDestPerHour: 100, maxSpend24hMicros: 100_000_000 },
  newAccount: {
    maxConcurrent: 1, maxCallsPerMinute: 3, maxCallsPerHour: 30, maxDistinctDestPerHour: 20,
    maxSpend24hMicros: 10_000_000, allowInternational: false, perCallReserveCapMicros: 2_000_000,
  },
  newAccountDays: 7,
  homeCountryCode: '1',
  establishedDays: 30,
};

export interface FraudContext {
  destination: string;          // E.164 digits
  accountCreatedAt: Date;
  now: Date;
  openCalls: number;
  callsLastMinute: number;
  callsLastHour: number;
  distinctDestLastHour: number;
  destSeenLastHour: boolean;    // already dialled this hour (doesn't count as a new distinct dest)
  spend24hMicros: number;
  userStatus: 'active' | 'suspended' | 'closed';
}

export type FraudDecision =
  | { allowed: true; isNewAccount: boolean; perCallReserveCapMicros?: number }
  | { allowed: false; code: string; reason: string };

const DAY = 86_400_000;

export function isNewAccount(created: Date, now: Date, days: number): boolean {
  return now.getTime() - created.getTime() < days * DAY;
}

export function checkFraud(ctx: FraudContext, blocklist: readonly BlockRule[], policy: FraudPolicy = DEFAULT_FRAUD_POLICY): FraudDecision {
  if (ctx.userStatus !== 'active') return { allowed: false, code: 'account_suspended', reason: `account ${ctx.userStatus}` };

  const ageMs = ctx.now.getTime() - ctx.accountCreatedAt.getTime();
  const rule = findRate(ctx.destination, blocklist);
  if (rule) {
    if (rule.action === 'block') return { allowed: false, code: 'destination_blocked', reason: rule.reason };
    if (ageMs < policy.establishedDays * DAY) return { allowed: false, code: 'destination_restricted', reason: rule.reason };
  }

  const fresh = isNewAccount(ctx.accountCreatedAt, ctx.now, policy.newAccountDays);
  const lim: FraudLimits = fresh ? policy.newAccount : policy.standard;

  if (fresh && !policy.newAccount.allowInternational && !ctx.destination.startsWith(policy.homeCountryCode)) {
    return { allowed: false, code: 'new_account_international', reason: `international calling unlocks after ${policy.newAccountDays} days` };
  }
  if (ctx.openCalls >= lim.maxConcurrent) return { allowed: false, code: 'concurrency_limit', reason: `max ${lim.maxConcurrent} simultaneous calls` };
  if (ctx.callsLastMinute >= lim.maxCallsPerMinute) return { allowed: false, code: 'velocity_minute', reason: `max ${lim.maxCallsPerMinute} calls per minute` };
  if (ctx.callsLastHour >= lim.maxCallsPerHour) return { allowed: false, code: 'velocity_hour', reason: `max ${lim.maxCallsPerHour} calls per hour` };
  if (!ctx.destSeenLastHour && ctx.distinctDestLastHour >= lim.maxDistinctDestPerHour) {
    return { allowed: false, code: 'velocity_distinct', reason: `max ${lim.maxDistinctDestPerHour} different numbers per hour` };
  }
  if (ctx.spend24hMicros >= lim.maxSpend24hMicros) return { allowed: false, code: 'spend_cap', reason: '24h spend cap reached' };

  return fresh
    ? { allowed: true, isNewAccount: true, perCallReserveCapMicros: Math.min(policy.newAccount.perCallReserveCapMicros, lim.maxSpend24hMicros - ctx.spend24hMicros) }
    : { allowed: true, isNewAccount: false, perCallReserveCapMicros: lim.maxSpend24hMicros - ctx.spend24hMicros };
}
