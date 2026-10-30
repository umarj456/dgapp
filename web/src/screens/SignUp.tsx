import { useState } from 'react';
import { api, setToken } from '../lib/api';

export default function SignUp({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');

  const start = async () => {
    setErr('');
    try { await api('/v1/auth/email/start', { body: { email } }); setSent(true); } catch (e) { setErr((e as Error).message); }
  };
  const verify = async () => {
    setErr('');
    try {
      const r = await api<{ token: string }>('/v1/auth/email/verify', { body: { email, code } });
      setToken(r.token);
      onSignedIn();
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="card">
      <h2>Sign up or log in</h2>
      <p className="muted">Get your own phone number and call from anywhere.</p>
      <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={sent} />
      {!sent ? (
        <button onClick={start} disabled={!email.includes('@')}>Email me a code</button>
      ) : (
        <>
          <p className="muted">On a local install the code is in the API log (console OTP), on the line that starts with [otp:email].</p>
          <input inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button onClick={verify} disabled={code.length !== 6}>Continue</button>
          <button className="secondary" onClick={() => setSent(false)}>Use a different email</button>
        </>
      )}
      {err && <p className="bad">{err}</p>}
    </div>
  );
}
