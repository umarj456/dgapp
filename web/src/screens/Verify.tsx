import { useState } from 'react';
import { api, type Me } from '../lib/api';

const LABEL: Record<string, string> = {
  email: 'Email verified', phone: 'Phone number verified', payment_method: 'Payment method verified',
  id_document: 'ID document', address: 'Proof of address',
};

/** KYC steps: phone OTP + payment method (Stripe SetupIntent). ID/address only when a DID country needs it. */
export default function Verify({ me, onChange }: { me: Me; onChange: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState('');
  const st = (k: string) => me.kyc.checks[k] ?? 'missing';

  const sendCode = async () => {
    try { await api('/v1/me/phone/start', { body: { phone } }); setSent(true); setMsg(''); } catch (e) { setMsg((e as Error).message); }
  };
  const verifyCode = async () => {
    try { await api('/v1/me/phone/verify', { body: { phone, code } }); setMsg('Phone verified'); onChange(); } catch (e) { setMsg((e as Error).message); }
  };
  const addCard = async () => {
    try {
      const si = await api<{ clientSecret: string; stub: boolean }>('/v1/kyc/payment-method/setup', { body: {} });
      // TODO(phase 1 live): mount Stripe Elements with VITE_STRIPE_PUBLISHABLE_KEY and confirmCardSetup(si.clientSecret).
      // The API marks the check passed when Stripe sends setup_intent.succeeded to the webhook.
      setMsg(si.stub ? 'Stripe is in stub mode: payment setup is simulated by the backend webhook in dev.' : 'Complete card setup in the form.');
    } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <div className="card">
      <h2>Verify your account</h2>
      <p className="muted">Required before you can buy a number or make calls.</p>
      <ul>
        {['email', 'phone', 'payment_method'].map((k) => (
          <li key={k} className={st(k) === 'passed' ? 'ok' : 'bad'}>{LABEL[k]}: {st(k)}</li>
        ))}
      </ul>
      {st('phone') !== 'passed' && (
        <>
          <input placeholder="+15551234567" value={phone} onChange={(e) => setPhone(e.target.value)} />
          {!sent ? <button onClick={sendCode} disabled={!/^\+\d{8,15}$/.test(phone)}>Text me a code</button> : (
            <div className="row">
              <input inputMode="numeric" maxLength={6} placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} />
              <button onClick={verifyCode}>Verify</button>
            </div>
          )}
        </>
      )}
      {st('payment_method') !== 'passed' && <button onClick={addCard}>Add a card</button>}
      {me.kyc.canCall && <p className="ok">All set. You can buy a number and call.</p>}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
