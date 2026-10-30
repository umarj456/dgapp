import { describe, expect, it } from 'vitest';
import { parsePoolCsv } from '../src/modules/dids/pool-admin.js';

describe('parsePoolCsv', () => {
  it('parses rows, normalises numbers and converts USD to micros', () => {
    const r = parsePoolCsv('# c\ne164,country,region,number_type,monthly_usd,setup_usd,sipnav_ref\n+1 212 555 0111,us,NY,local,5.5,1,ref1\n');
    expect(r).toEqual([{ e164: '12125550111', country: 'US', region: 'NY', numberType: 'local', monthlyPriceMicros: 5500000, setupPriceMicros: 1000000, sipnavRef: 'ref1' }]);
  });
  it('rejects bad rows with the line number', () => {
    expect(() => parsePoolCsv('e164,country,monthly_usd\nabc,US,5')).toThrow(/row 2/);
  });
});
