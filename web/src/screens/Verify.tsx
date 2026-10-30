import { useEffect, useRef, useState } from 'react';
import { loadStripe, type Stripe, type StripeCardElement } from '@stripe/stripe-js';
import { api, type Me } from '../lib/api';
import { billingConfig } from '../lib/billing';
import { simulateStripeEvent } from '../lib/stubStripe';

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
  const [clientSecret, setClientSecret] = useState('');
  const [publishableKey, setPublishableKey] = useState('');
  const cardHost = useRef<HTMLDivElement>(null);
  const cardRef = useRef<{ stripe: Stripe; card: StripeCardElement } | null>(null);
  const st = (k: string) => me.kyc.checks[k] ?? 'missing';

  const sendCode = async () => {
    try { await api('/v1/me/phone/start', { body: { phone } }); setSent(true); setMsg(''); } catch (e) { setMsg((e as Error).message); }
  };
  const verifyCode = async () => {
    try { await api('/v1/me/phone/verify', { body: { phone, code } }); setMsg('Phone verified'); onChange(); } catch (e) { setMsg((e as Error).message); }
  };
  const addCard = async () => {
    try {
      const si = await api<{ clientSecret: string; stub: boolean; id: string }>('/v1/kyc/payment-method/setup', { body: {} });
      // Live mode mounts Stripe Elements with VITE_STRIPE_PUBLISHABLE_KEY and confirmCardSetup(si.clientSecret).
      // The API marks the check passed when Stripe sends setup_intent.succeeded to the webhook.
      if (si.stub) {
        await simulateStripeEvent({
          id: `evt_${si.id}`,
          type: 'setup_intent.succeeded',
          object: { id: si.id, metadata: { user_id: me.id } },
        });
        setMsg('Dev stub recorded a verified payment method.');
        onChange();
        return;
      }
      const cfg = await billingConfig();
      if (!cfg.stripePublishableKey) { setMsg('Set STRIPE_PUBLISHABLE_KEY on the server, then reload.'); return; }
      setPublishableKey(cfg.stripePublishableKey);
      setClientSecret(si.clientSecret);
      setMsg('Enter the card. Stripe confirms it. This server does not see the card number.');
    } catch (e) { setMsg((e as Error).message); }
  };
  useEffect(() => {
    if (!clientSecret || !publishableKey || !cardHost.current) return;
    let gone = false;
    let card: StripeCardElement | undefined;
    (async () => {
      const stripe = await loadStripe(publishableKey);
      if (!stripe || gone || !cardHost.current) return;
      card = stripe.elements().create('card');
      card.mount(cardHost.current);
      cardRef.current = { stripe, card };
    })();
    return () => { gone = true; card?.unmount(); cardRef.current = null; };
  }, [clientSecret, publishableKey]);
  const confirmCard = async () => {
    const held = cardRef.current;
    if (!held) return;
    const result = await held.stripe.confirmCardSetup(clientSecret, { payment_method: { card: held.card } });
    if (result.error) { setMsg(result.error.message ?? 'Card setup failed'); return; }
    setMsg('Card sent to Stripe. The payment method shows as verified after the webhook.');
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
          {sent && <p className="muted">On a local install the code is in the API log (console OTP), on the line that starts with [otp:sms].</p>}
        </>
      )}
      {st('payment_method') !== 'passed' && <button onClick={addCard}>Add a card</button>}
      {clientSecret && <div ref={cardHost} />}
      {clientSecret && <button onClick={confirmCard}>Save card</button>}
      {me.kyc.canCall && <p className="ok">All set. You can buy a number and call.</p>}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
