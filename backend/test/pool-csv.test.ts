import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePoolCsv } from '../src/modules/dids/pool-admin.js';

describe('parsePoolCsv', () => {
  it('parses rows, normalises numbers and converts USD to micros', () => {
    const r = parsePoolCsv('# c\ne164,country,region,number_type,monthly_usd,setup_usd,sipnav_ref\n+1 212 555 0111,us,NY,local,5.5,1,ref1\n');
    expect(r).toEqual([{ e164: '12125550111', country: 'US', region: 'NY', numberType: 'local', monthlyPriceMicros: 5500000, setupPriceMicros: 1000000, sipnavRef: 'ref1' }]);
  });
  it('accepts E.164 and monthly_price_cents (500 cents = $5)', () => {
    const r = parsePoolCsv('E.164,country,monthly_price_cents\n+1 212 555 0121,us,500\n');
    expect(r[0]).toMatchObject({ e164: '12125550121', country: 'US', numberType: 'local', monthlyPriceMicros: 5_000_000, setupPriceMicros: 0 });
    expect(r[0].region ?? null).toBeNull();
    expect(r[0].sipnavRef ?? null).toBeNull();
  });
  it('parses the fictional 555 sample and refuses a cents/usd mismatch', () => {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../seed/pool.example.csv'), 'utf8');
    expect(text).toMatch(/NOT real inventory/);
    const rows = parsePoolCsv(text);
    expect(rows.map((r) => r.e164)).toEqual(['12125550121', '13105550122', '17135550123']);
    expect(rows.every((r) => r.e164.includes('555') && r.country === 'US' && r.monthlyPriceMicros === 5_000_000)).toBe(true);
    expect(() => parsePoolCsv('e164,country,monthly_price_cents,monthly_usd\n12125550121,US,500,6.00')).toThrow(/disagree/);
  });
  it('rejects bad rows with the line number', () => {
    expect(() => parsePoolCsv('e164,country,monthly_usd\nabc,US,5')).toThrow(/row 2/);
    expect(() => parsePoolCsv('e164,country,monthly_price_cents\n12125550121,US,5.5')).toThrow(/whole number of cents/);
  });
});
