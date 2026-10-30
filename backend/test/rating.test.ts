import { describe, expect, it } from 'vitest';
import { RateIndex, billableSeconds, callCost, findRate, maxDurationForBalance, type Rate } from '../src/modules/rating/rating.js';

const r = (prefix: string, perMin: number, inc: [number, number] = [6, 6], fee = 0): Rate =>
  ({ prefix, ratePerMinMicros: perMin, connectFeeMicros: fee, initialIncrement: inc[0], billingIncrement: inc[1] });

const deck = [r('1', 10_000), r('1212', 8_000), r('44', 20_000, [60, 60]), r('447', 50_000, [60, 60]), r('92', 80_000, [60, 60])];

describe('longest-prefix rate match', () => {
  it('picks the most specific prefix', () => {
    expect(findRate('12125551234', deck)!.prefix).toBe('1212');
    expect(findRate('13105551234', deck)!.prefix).toBe('1');
    expect(findRate('447700900123', deck)!.prefix).toBe('447');
    expect(findRate('442079460000', deck)!.prefix).toBe('44');
  });
  it('returns null when nothing matches', () => {
    expect(findRate('8613800000000', deck)).toBeNull();
  });
  it('RateIndex agrees with linear scan', () => {
    const idx = new RateIndex(deck);
    for (const n of ['12125551234', '13105551234', '447700900123', '442079460000', '923001234567', '8613800000000']) {
      expect(idx.find(n)?.prefix ?? null).toBe(findRate(n, deck)?.prefix ?? null);
    }
  });
});

describe('billing increments', () => {
  it('6/6', () => {
    const x = r('1', 10_000, [6, 6]);
    expect(billableSeconds(0, x)).toBe(0);
    expect(billableSeconds(1, x)).toBe(6);
    expect(billableSeconds(6, x)).toBe(6);
    expect(billableSeconds(7, x)).toBe(12);
    expect(billableSeconds(61, x)).toBe(66);
  });
  it('60/60', () => {
    const x = r('44', 20_000, [60, 60]);
    expect(billableSeconds(1, x)).toBe(60);
    expect(billableSeconds(60, x)).toBe(60);
    expect(billableSeconds(61, x)).toBe(120);
  });
  it('60/6 and 30/6', () => {
    expect(billableSeconds(61, r('x', 1, [60, 6]))).toBe(66);
    expect(billableSeconds(20, r('x', 1, [30, 6]))).toBe(30);
    expect(billableSeconds(31, r('x', 1, [30, 6]))).toBe(36);
  });
});

describe('call cost', () => {
  it('charges nothing for unanswered calls', () => {
    expect(callCost(0, r('1', 10_000, [6, 6], 5_000))).toBe(0);
  });
  it('per-second pricing on 6/6 ($0.01/min)', () => {
    expect(callCost(60, r('1', 10_000))).toBe(10_000);   // 1 minute = $0.01
    expect(callCost(7, r('1', 10_000))).toBe(2_000);     // 12s
  });
  it('rounds up fractional micros and adds connect fee', () => {
    // 6s at 1_001 micro/min = 100.1 -> 101
    expect(callCost(6, r('1', 1_001))).toBe(101);
    expect(callCost(60, r('44', 20_000, [60, 60], 3_000))).toBe(23_000);
  });
});

describe('max duration from balance', () => {
  it('fits the balance exactly on increment boundaries', () => {
    const x = r('1', 10_000); // $0.01/min, 6/6
    expect(maxDurationForBalance(10_000, x, 14_400)).toBe(60);
    expect(maxDurationForBalance(10_999, x, 14_400)).toBe(60);
    expect(maxDurationForBalance(11_000, x, 14_400)).toBe(66);
  });
  it('60/60 rounds down to whole minutes', () => {
    const x = r('92', 80_000, [60, 60]);
    expect(maxDurationForBalance(239_999, x, 14_400)).toBe(120);
    expect(maxDurationForBalance(240_000, x, 14_400)).toBe(180);
  });
  it('0 when even the first increment is unaffordable', () => {
    expect(maxDurationForBalance(999, r('1', 10_000), 14_400)).toBe(0); // 6s costs 1000
    expect(maxDurationForBalance(0, r('1', 10_000), 14_400)).toBe(0);
    expect(maxDurationForBalance(-5, r('1', 10_000), 14_400)).toBe(0);
  });
  it('accounts for the connect fee', () => {
    const x = r('44', 20_000, [60, 60], 5_000);
    expect(maxDurationForBalance(24_999, x, 14_400)).toBe(0);
    expect(maxDurationForBalance(25_000, x, 14_400)).toBe(60);
  });
  it('is capped', () => {
    expect(maxDurationForBalance(1_000_000_000, r('1', 10_000), 14_400)).toBe(14_400);
  });
  it('invariant: cost(max) <= balance < cost(max + increment) (property check)', () => {
    const rates = [r('a', 10_000), r('b', 1_001, [60, 6]), r('c', 77_777, [60, 60], 1_234), r('d', 3, [30, 6])];
    for (const x of rates) {
      for (let bal = 0; bal < 400_000; bal += 997) {
        const d = maxDurationForBalance(bal, x, 1e9);
        if (d > 0) {
          expect(callCost(d, x)).toBeLessThanOrEqual(bal);
          expect(callCost(d + x.billingIncrement, x)).toBeGreaterThan(bal);
        } else {
          expect(callCost(1, x)).toBeGreaterThan(bal);
        }
      }
    }
  });
});
