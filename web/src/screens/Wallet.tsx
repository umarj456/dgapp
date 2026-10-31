import { useEffect, useState } from 'react';
import { api, type Me } from '../lib/api';
import { billingConfig } from '../lib/billing';
import { dollars, friendlyFailure } from '../lib/customerCopy';
import { simulateStripeEvent } from '../lib/stubStripe';

interface Entry { id: number; kind: string; amount_micros: number; balance_after: number; memo: string | null; created_at: string }
interface CallRow { id: number; direction: string; number: string | null; seconds: number; costUsd: string; at: string }
const usd = (m: number) => (m / 1e6).toFixed(m % 10000 === 0 ? 2 : 4);

export default function Wallet({ me, onChange }: { me: Me; onChange: () => void }) {
  const [ledger, setLedger] = useState<Entry[]>([]);
  const [amount, setAmount] = useState(10);
  const [msg, setMsg] = useState('');
  const [paypal, setPaypal] = useState(false);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const load = () => {
    api<Entry[]>('/v1/wallet/ledger').then(setLedger).catch(() => {});
    api<CallRow[]>('/v1/calls').then(setCalls).catch(() => {});
  };
  useEffect(() => { billingConfig().then((c) => setPaypal(c.paypal)).catch(() => {}); }, []);
  useEffect(() => { load(); const id = setInterval(() => { load(); onChange(); }, 4000); return () => clearInterval(id); }, [onChange]);

  const topup = async () => {
    setMsg('');
    try {
    const r = await api<{ url: string; stub?: boolean; id: string }>('/v1/wallet/topup', { body: { amountUsd: amount } });
    if (r.stub) {
      await simulateStripeEvent({
        id: `evt_${r.id}`,
        type: 'checkout.session.completed',
        object: {
          id: r.id, mode: 'payment', payment_status: 'paid', amount_total: amount * 100,
          metadata: { kind: 'topup', user_id: me.id },
        },
      });
      setMsg(`Added $${amount} calling credit.`);
      load();
      onChange();
      return;
    }
    window.location.href = r.url;
    } catch (e) { setMsg(friendlyFailure(e)); }
  };
  const paypalTopup = async () => {
    setMsg('');
    try {
      const r = await api<{ url: string }>('/v1/wallet/paypal/order', { body: { amountUsd: amount } });
      window.location.href = r.url;
    } catch (e) { setMsg(friendlyFailure(e)); }
  };

  return (
    <>
      <div className="card">
        <h2>Calling credit ${dollars(me.wallet?.availableUsd)}</h2>
        <p className="muted">For outbound calls only. Your phone number is a separate 30-day subscription.</p>
        <div className="row">
          <select value={amount} onChange={(e) => setAmount(Number(e.target.value))}>
            {[5, 10, 25, 50].map((a) => <option key={a} value={a}>${a}</option>)}
          </select>
          <button onClick={topup}>Add calling credit</button>
          {paypal && <button className="secondary" onClick={paypalTopup}>PayPal</button>}
        </div>
        {msg && <p className="muted">{msg}</p>}
      </div>
      <div className="card">
        <h2>Calls</h2>
        {calls.length === 0 && <p className="muted">No calls yet.</p>}
        {calls.map((c) => (
          <div key={c.id} className="row muted">
            <span>{new Date(c.at).toLocaleString()}</span>
            <span>{c.direction === 'inbound' ? 'In' : 'Out'} {c.number ? `+${String(c.number).replace(/^\+/, '')}` : ''}</span>
            <span>{c.direction === 'inbound' && Number(c.costUsd) === 0 ? 'Free' : `$${dollars(c.costUsd)}`}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Credit history</h2>
        {ledger.map((e) => (
          <div key={e.id} className="row muted">
            <span>{new Date(e.created_at).toLocaleString()}</span><span>{e.memo ?? e.kind}</span>
            <span className={e.amount_micros < 0 ? 'bad' : 'ok'}>{e.amount_micros < 0 ? '-' : '+'}${usd(Math.abs(e.amount_micros))}</span>
          </div>
        ))}
      </div>
    </>
  );
}
