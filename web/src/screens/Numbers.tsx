import { useEffect, useState } from 'react';
import { api, type AvailableDid, type Me } from '../lib/api';
import { billingConfig } from '../lib/billing';
import { dollars, friendlyFailure } from '../lib/customerCopy';
import { simulateStripeEvent } from '../lib/stubStripe';
import Verify from './Verify';

const fmt = (e164: string) => (e164.startsWith('1') && e164.length === 11 ? `+1 (${e164.slice(1, 4)}) ${e164.slice(4, 7)}-${e164.slice(7)}` : e164 ? `+${e164}` : 'Unknown');

type Mine = Me['numbers'][number];

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

function numberLabel(n: Mine): { name: string; note: string } {
  const date = when(n.current_period_end);
  const soon = n.current_period_end && new Date(n.current_period_end).getTime() - Date.now() < 7 * 86_400_000;
  if (n.status === 'past_due') return { name: 'Blocked', note: 'Renew to use this number again.' };
  if (n.status === 'pending_payment') return { name: 'Waiting for payment', note: '' };
  if (n.auto_renew === false) return { name: 'Active', note: date ? `Ends ${date}. It stays yours until then.` : '' };
  if (soon) return { name: 'Expiring', note: date ? `Renews ${date} from your card or PayPal.` : 'Renews soon.' };
  return { name: 'Active', note: date ? `Renews ${date}.` : 'Renews every 30 days.' };
}

/** Browse the pool, then pay for a 30-day number. Calling credit is a separate wallet. */
export default function Numbers({ me, onChange }: { me: Me; onChange: () => void }) {
  const [area, setArea] = useState('');
  const [results, setResults] = useState<AvailableDid[]>([]);
  const [picked, setPicked] = useState<AvailableDid | null>(null);
  const [msg, setMsg] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [paypal, setPaypal] = useState(false);
  const phoneOk = me.kyc.checks.phone === 'passed';

  const search = async (digits = area) => {
    const q = new URLSearchParams({ country: 'US', ...(digits ? { contains: digits.replace(/\D/g, '') } : {}) });
    try { setResults(await api<AvailableDid[]>(`/v1/dids/search?${q}`)); }
    catch (e) { setMsg(friendlyFailure(e)); }
    finally { setLoaded(true); }
  };
  useEffect(() => { billingConfig().then((c) => setPaypal(c.paypal)).catch(() => {}); search(''); }, []);

  const finish = async (r: { stub?: boolean; checkoutId?: string; assignmentId?: string; checkoutUrl?: string; e164?: string }, kind: 'did' | 'renew') => {
    if (r.stub && r.checkoutId && r.assignmentId) {
      await simulateStripeEvent({
        id: `evt_${r.checkoutId}`,
        type: 'checkout.session.completed',
        object: { id: r.checkoutId, mode: 'subscription', metadata: { kind: 'did_subscription', user_id: me.id, assignment_id: r.assignmentId } },
      });
      setMsg(kind === 'renew' ? 'Renewed for 30 days.' : `${fmt(r.e164 ?? '')} is active for 30 days.`);
      setPicked(null);
      onChange();
      search();
      return;
    }
    if (r.checkoutUrl) window.location.href = r.checkoutUrl;
  };

  const subscribe = async (billing: 'stripe' | 'paypal') => {
    if (!picked) return;
    setMsg('');
    try {
      const r = await api<{ stub?: boolean; checkoutId?: string; assignmentId?: string; checkoutUrl?: string; e164: string }>('/v1/dids/buy', { body: { didId: picked.id, billing } });
      await finish(r, 'did');
    } catch (e) { setMsg(friendlyFailure(e)); }
  };

  const toggleRenew = async (n: Mine) => {
    setMsg('');
    try {
      await api(`/v1/dids/${n.assignment_id}/auto-renew`, { body: { on: !n.auto_renew } });
      onChange();
    } catch (e) { setMsg(friendlyFailure(e)); }
  };

  const renew = async (n: Mine) => {
    setMsg('');
    try {
      const r = await api<{ stub?: boolean; checkoutId?: string; assignmentId?: string; checkoutUrl?: string; e164: string }>(`/v1/dids/${n.assignment_id}/renew`, { body: { billing: paypal ? 'paypal' : 'stripe' } });
      await finish({ ...r, e164: n.e164, assignmentId: n.assignment_id }, 'renew');
    } catch (e) { setMsg(friendlyFailure(e)); }
  };

  return (
    <>
      <div className="card">
        <h2>My numbers</h2>
        <p className="muted">A number is a 30-day subscription. Calling credit is separate.</p>
        {me.numbers.length === 0 && <p className="muted">You don't have a number yet.</p>}
        {me.numbers.map((n) => {
          const label = numberLabel(n);
          return (
            <div key={n.assignment_id} className="card">
              <b>{fmt(n.e164)}</b> <span className={label.name === 'Blocked' || label.name === 'Expiring' ? 'bad' : 'ok'}>{label.name}</span>
              {n.region && <p className="muted">{n.region}</p>}
              {label.note && <p className="muted">{label.note}</p>}
              <div className="row">
                {n.status !== 'pending_payment' && (
                  <button className="secondary" onClick={() => toggleRenew(n)}>{n.auto_renew ? 'Auto-renew on' : 'Auto-renew off'}</button>
                )}
                {n.status === 'past_due' && <button onClick={() => renew(n)}>Renew 30 days</button>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>United States numbers</h2>
        <div className="row">
          <input inputMode="numeric" placeholder="Area code" value={area} onChange={(e) => setArea(e.target.value.replace(/\D/g, '').slice(0, 3))} />
          <button onClick={() => search()}>Search</button>
        </div>
        {results.map((d) => (
          <button key={d.id} className={picked?.id === d.id ? 'secondary picked' : 'secondary'} onClick={() => { setPicked(d); setMsg(''); }}>
            {fmt(d.e164)}{d.region ? ` · ${d.region}` : ''} · ${dollars(d.monthly_price_usd)} / 30 days
          </button>
        ))}
        {loaded && results.length === 0 && <p className="muted">No numbers match that area code.</p>}
      </div>

      {picked && (
        <div className="card">
          <h2>Subscribe</h2>
          <p><b>{fmt(picked.e164)}</b></p>
          <p>${dollars(picked.monthly_price_usd)} for 30 days. Auto-renew is on. You can turn it off and keep the number until the period ends.</p>
          <p className="muted">This payment is only for the number. Add calling credit in Wallet when you want to place calls.</p>
          {!phoneOk ? <Verify onChange={onChange} /> : (
            <div className="row">
              <button onClick={() => subscribe('stripe')}>Pay by card</button>
              {paypal && <button className="secondary" onClick={() => subscribe('paypal')}>PayPal</button>}
            </div>
          )}
        </div>
      )}
      {msg && <p className="muted">{msg}</p>}
    </>
  );
}
