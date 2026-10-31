import { useState } from 'react';
import { api } from '../lib/api';
import { friendlyFailure } from '../lib/customerCopy';

/** Phone confirmation. A card is not collected here. */
export default function Verify({ onChange }: { onChange: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState('');

  const sendCode = async () => {
    setMsg('');
    try { await api('/v1/me/phone/start', { body: { phone } }); setSent(true); }
    catch (e) { setMsg(friendlyFailure(e)); }
  };
  const verifyCode = async () => {
    setMsg('');
    try { await api('/v1/me/phone/verify', { body: { phone, code } }); setMsg('Phone confirmed.'); onChange(); }
    catch (e) { setMsg(friendlyFailure(e)); }
  };

  return (
    <div>
      <p className="muted">Confirm your mobile number before you subscribe. No card is needed to sign up.</p>
      <input placeholder="+1 555 555 0199" value={phone} onChange={(e) => setPhone(e.target.value)} />
      {!sent ? <button onClick={sendCode} disabled={!/^\+\d{8,15}$/.test(phone)}>Text me a code</button> : (
        <div className="row">
          <input inputMode="numeric" maxLength={6} placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button onClick={verifyCode}>Confirm</button>
        </div>
      )}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
