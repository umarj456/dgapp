import { useEffect, useRef, useState } from 'react';
import { api, type Me, type SipCredential } from '../lib/api';
import { customerCallHint, customerCallStatus, dollars } from '../lib/customerCopy';
import { Phone, type CallState } from '../lib/phone';
import IncomingCall from './IncomingCall';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

export default function Dialer({ me, onChange }: { me: Me; onChange: () => void }) {
  const [state, setState] = useState<CallState>('idle');
  const [hint, setHint] = useState('');
  const [number, setNumber] = useState('');
  const [incoming, setIncoming] = useState<string | null>(null);
  const phone = useRef<Phone | null>(null);
  const primary = me.numbers.find((n) => n.status === 'active');
  const blocked = !primary && me.numbers.some((n) => n.status === 'past_due');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // one SIP credential per browser: reuse it instead of minting a new one on every visit
        const key = `dg_sip_${me.id}`;
        const cached = localStorage.getItem(key);
        const cred: SipCredential = cached ? JSON.parse(cached) : await api<SipCredential>('/v1/sip/credentials', { body: { deviceLabel: 'web' } });
        if (!cached) localStorage.setItem(key, JSON.stringify(cred));
        if (cancelled) return;
        phone.current = new Phone(cred, {
          onState: (s, d) => { setState(s); setHint(customerCallHint(s, d)); if (s !== 'ringing') setIncoming(null); },
          onIncoming: (from) => setIncoming(from),
        });
        await phone.current.start();
      } catch (e) { console.error(e); setState('error'); setHint(''); }
    })();
    return () => { cancelled = true; phone.current?.stop(); };
  }, [me.id]);

  const live = state === 'calling' || state === 'in_call' || state === 'ringing';
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => onChange(), 3000);
    return () => clearInterval(id);
  }, [live, onChange]);
  const prev = useRef(state);
  useEffect(() => {
    const wasLive = prev.current === 'calling' || prev.current === 'in_call' || prev.current === 'ringing';
    if (wasLive && !live) onChange();
    prev.current = state;
  }, [state, live, onChange]);

  const press = (k: string) => (state === 'in_call' ? phone.current?.dtmf(k) : setNumber((n) => n + k));

  return (
    <div className="card">
      <h2>Dialer</h2>
      <p className="muted">
        {primary ? `Calling as +${primary.e164}` : blocked ? 'Your number is blocked until you renew.' : 'Choose a number first.'}
      </p>
      <p>Calling credit ${dollars(me.wallet?.availableUsd)}</p>
      <p><b>{customerCallStatus(state)}</b>{hint ? ` · ${hint}` : ''}</p>
      <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+1 212 555 0100" />
      <div className="keypad">{KEYS.map((k) => <button key={k} onClick={() => press(k)}>{k}</button>)}</div>
      {state === 'in_call' || state === 'calling' ? (
        <button className="danger" onClick={() => phone.current?.hangup()}>Hang up</button>
      ) : (
        <button onClick={() => phone.current?.call(number)} disabled={state !== 'ready' || !number || !primary}>Call</button>
      )}
      {incoming && <IncomingCall from={incoming} onAnswer={() => phone.current?.answer()} onDecline={() => phone.current?.decline()} />}
    </div>
  );
}
