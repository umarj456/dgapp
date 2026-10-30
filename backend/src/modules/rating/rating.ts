/**
 * Rating engine (pure functions). All money in integer micro-USD.
 * Billing increments follow the usual "initial/subsequent" notation: 6/6, 60/60, 60/6, 30/6 ...
 */
export interface Rate {
  id?: number;
  prefix: string;
  description?: string | null;
  ratePerMinMicros: number;
  connectFeeMicros: number;
  initialIncrement: number; // seconds
  billingIncrement: number; // seconds
}

/** Longest-prefix match. Rates are matched against E.164 digits (no '+'). */
export function findRate<T extends { prefix: string }>(number: string, deck: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of deck) {
    if (number.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
  }
  return best;
}

/** Build a lookup index once per deck version for fast matching on large decks. */
export class RateIndex<T extends { prefix: string }> {
  private map = new Map<string, T>();
  private maxLen = 0;
  constructor(deck: readonly T[]) {
    for (const r of deck) {
      this.map.set(r.prefix, r);
      this.maxLen = Math.max(this.maxLen, r.prefix.length);
    }
  }
  find(number: string): T | null {
    for (let len = Math.min(this.maxLen, number.length); len > 0; len--) {
      const hit = this.map.get(number.slice(0, len));
      if (hit) return hit;
    }
    return null;
  }
}

/** Seconds actually billed for a call of `durationSec` connected seconds. */
export function billableSeconds(durationSec: number, rate: Pick<Rate, 'initialIncrement' | 'billingIncrement'>): number {
  const d = Math.max(0, Math.ceil(durationSec));
  if (d === 0) return 0;
  if (d <= rate.initialIncrement) return rate.initialIncrement;
  return rate.initialIncrement + Math.ceil((d - rate.initialIncrement) / rate.billingIncrement) * rate.billingIncrement;
}

/** Cost for billable seconds; rounded UP to the next micro so we never under-charge. */
function costForBillable(billable: number, rate: Rate): number {
  if (billable === 0) return 0;
  return Math.ceil((billable * rate.ratePerMinMicros) / 60) + rate.connectFeeMicros;
}

/** Cost of a call that lasted `durationSec` answered seconds. Unanswered (0s) calls cost nothing. */
export function callCost(durationSec: number, rate: Rate): number {
  return costForBillable(billableSeconds(durationSec, rate), rate);
}

/**
 * Longest duration (seconds) whose cost fits within `availableMicros`, capped at `capSec`.
 * Returns a value aligned to the increment boundary, so callCost(result) <= availableMicros.
 * Returns 0 when not even the first increment is affordable.
 */
export function maxDurationForBalance(availableMicros: number, rate: Rate, capSec: number): number {
  if (availableMicros <= 0) return 0;
  if (rate.ratePerMinMicros === 0) return rate.connectFeeMicros <= availableMicros ? capSec : 0;
  if (costForBillable(rate.initialIncrement, rate) > availableMicros) return 0;

  const afterFee = availableMicros - rate.connectFeeMicros;
  const affordableSec = Math.floor((afterFee * 60) / rate.ratePerMinMicros);
  let steps = Math.max(0, Math.floor((affordableSec - rate.initialIncrement) / rate.billingIncrement));
  let billable = rate.initialIncrement + steps * rate.billingIncrement;
  // guard against ceil rounding pushing us a micro over
  while (billable > rate.initialIncrement && costForBillable(billable, rate) > availableMicros) {
    steps -= 1;
    billable = rate.initialIncrement + steps * rate.billingIncrement;
  }
  return Math.min(billable, capSec);
}
