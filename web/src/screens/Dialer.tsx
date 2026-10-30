import { useEffect, useRef, useState } from 'react';
import { api, type Me, type SipCredential } from '../lib/api';
import { Phone, type CallState } from '../lib/phone';
import IncomingCall from './IncomingCall';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

export default function Dialer({ me }: { me: Me }) {
  const [state, setState] = useState<CallState>('idle');
  const [detail, setDetail] = useState('');
  const [number, setNumber] = useState('');
  const [incoming, setIncoming] = useState<string | null>(null);
  const phone = useRef<Phone | null>(null);
  const primary = me.numbers.find((n) => n.status === 'active');

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
          onState: (s, d) => { setState(s); setDetail(d ?? ''); if (s !== 'ringing') setIncoming(null); },
          onIncoming: (from) => setIncoming(from),
        });
        await phone.current.start();
      } catch (e) { setState('error'); setDetail((e as Error).message); }
    })();
    return () => { cancelled = true; phone.current?.stop(); };
  }, [me.id]);

  const press = (k: string) => (state === 'in_call' ? phone.current?.dtmf(k) : setNumber((n) => n + k));

  return (
    <div className="card">
      <h2>Dialer</h2>
      <p className="muted">
        Calling as {primary ? `+${primary.e164}` : '(no number yet: buy one first)'} · Balance ${me.wallet?.availableUsd ?? '0'} · <b>{state}</b> {detail}
      </p>
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
