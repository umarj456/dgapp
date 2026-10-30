import { useState } from 'react';
import { api, ApiError, type AvailableDid, type Me } from '../lib/api';

const fmt = (e164: string) => (e164.startsWith('1') && e164.length === 11 ? `+1 (${e164.slice(1, 4)}) ${e164.slice(4, 7)}-${e164.slice(7)}` : `+${e164}`);

/** Number picker: search the DG App pool, buy (wallet or Stripe subscription), release. */
export default function Numbers({ me, onChange }: { me: Me; onChange: () => void }) {
  const [country, setCountry] = useState('US');
  const [contains, setContains] = useState('');
  const [results, setResults] = useState<AvailableDid[]>([]);
  const [msg, setMsg] = useState('');

  const search = async () => {
    const q = new URLSearchParams({ country, ...(contains ? { contains } : {}) });
    setResults(await api<AvailableDid[]>(`/v1/dids/search?${q}`));
  };
  const buy = async (d: AvailableDid, billing: 'wallet' | 'stripe') => {
    try {
      const r = await api<{ status: string; checkoutUrl?: string }>('/v1/dids/buy', { body: { didId: d.id, billing } });
      if (r.checkoutUrl) window.location.href = r.checkoutUrl;
      else { setMsg(`${fmt(d.e164)} is yours.`); onChange(); setResults([]); }
    } catch (e) {
      const b = e instanceof ApiError ? e.body : null;
      setMsg(b?.error === 'kyc_required' ? `Verification needed: ${[...b.missing, ...b.failed].join(', ')}` : (e as Error).message);
    }
  };
  const release = async (id: string) => {
    if (!confirm('Release this number? You may not get it back.')) return;
    await api(`/v1/dids/${id}/release`, { method: 'POST', body: {} });
    onChange();
  };

  return (
    <>
      <div className="card">
        <h2>My numbers</h2>
        {me.numbers.length === 0 && <p className="muted">No number yet. Your number is your caller ID.</p>}
        {me.numbers.map((n) => (
          <div key={n.assignment_id} className="row">
            <span>{fmt(n.e164)} <span className="muted">{n.region} · {n.status}</span></span>
            <button className="secondary" onClick={() => release(n.assignment_id)}>Release</button>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Get a number</h2>
        <div className="row">
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="US">United States</option>
            <option value="CA">Canada</option>
            <option value="GB">United Kingdom</option>
          </select>
          <input placeholder="Digits (e.g. 212)" value={contains} onChange={(e) => setContains(e.target.value)} />
        </div>
        <button onClick={search}>Search</button>
        {results.map((d) => (
          <div key={d.id} className="card">
            <b>{fmt(d.e164)}</b> <span className="muted">{d.region} · ${d.monthly_price_usd}/mo</span>
            <div className="row">
              <button onClick={() => buy(d, 'wallet')}>Pay from balance</button>
              <button className="secondary" onClick={() => buy(d, 'stripe')}>Subscribe by card</button>
            </div>
          </div>
        ))}
        {msg && <p className="muted">{msg}</p>}
      </div>
    </>
  );
}
