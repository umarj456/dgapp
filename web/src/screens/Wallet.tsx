import { useEffect, useState } from 'react';
import { api, type Me } from '../lib/api';

interface Entry { id: number; kind: string; amount_micros: number; balance_after: number; memo: string | null; created_at: string }
const usd = (m: number) => (m / 1e6).toFixed(m % 10000 === 0 ? 2 : 4);

export default function Wallet({ me }: { me: Me }) {
  const [ledger, setLedger] = useState<Entry[]>([]);
  const [amount, setAmount] = useState(10);
  useEffect(() => { api<Entry[]>('/v1/wallet/ledger').then(setLedger).catch(() => {}); }, []);

  const topup = async () => {
    const r = await api<{ url: string }>('/v1/wallet/topup', { body: { amountUsd: amount } });
    window.location.href = r.url; // Stripe Checkout (or stub URL in dev)
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
        </div>
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
