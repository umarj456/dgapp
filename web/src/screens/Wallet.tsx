import { useEffect, useState } from 'react';
import { api, type Me } from '../lib/api';
import { billingConfig } from '../lib/billing';
import { simulateStripeEvent } from '../lib/stubStripe';

interface Entry { id: number; kind: string; amount_micros: number; balance_after: number; memo: string | null; created_at: string }
const usd = (m: number) => (m / 1e6).toFixed(m % 10000 === 0 ? 2 : 4);

export default function Wallet({ me, onChange }: { me: Me; onChange: () => void }) {
  const [ledger, setLedger] = useState<Entry[]>([]);
  const [amount, setAmount] = useState(10);
  const [msg, setMsg] = useState('');
  const [paypal, setPaypal] = useState(false);
  const load = () => { api<Entry[]>('/v1/wallet/ledger').then(setLedger).catch(() => {}); };
  useEffect(() => { billingConfig().then((c) => setPaypal(c.paypal)).catch(() => {}); }, []);
  useEffect(() => { load(); }, []);

  const topup = async () => {
    setMsg('');
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
      setMsg(`Dev stub added $${amount} of calling credit.`);
      load();
      onChange();
      return;
    }
    window.location.href = r.url;
  };
  const paypalTopup = async () => {
    setMsg('');
    const r = await api<{ url: string }>('/v1/wallet/paypal/order', { body: { amountUsd: amount } });
    window.location.href = r.url;
  };

  return (
    <>
      <div className="card">
        <h2>Balance: ${me.wallet?.balanceUsd ?? '0'}</h2>
        <p className="muted">Available for calls: ${me.wallet?.availableUsd ?? '0'} (prepaid only)</p>
        <div className="row">
          <select value={amount} onChange={(e) => setAmount(Number(e.target.value))}>
            {[5, 10, 25, 50].map((a) => <option key={a} value={a}>${a}</option>)}
          </select>
          <button onClick={topup}>Add credit</button>
          {paypal && <button className="secondary" onClick={paypalTopup}>PayPal</button>}
        </div>
        {msg && <p className="muted">{msg}</p>}
      </div>
      <div className="card">
        <h2>History</h2>
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
