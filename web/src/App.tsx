import { useCallback, useEffect, useState } from 'react';
import { api, hasToken, setToken, type Me } from './lib/api';
import SignUp from './screens/SignUp';
import Verify from './screens/Verify';
import Numbers from './screens/Numbers';
import Dialer from './screens/Dialer';
import Wallet from './screens/Wallet';

type Tab = 'dialer' | 'numbers' | 'wallet' | 'verify';

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>('dialer');
  const [loading, setLoading] = useState(hasToken());

  const refresh = useCallback(async () => {
    try { setMe(await api<Me>('/v1/me')); } catch { setToken(''); setMe(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (hasToken()) refresh(); }, [refresh]);

  if (loading) return <div className="app">Loading...</div>;
  if (!me) return <div className="app"><h1>DG App</h1><SignUp onSignedIn={refresh} /></div>;

  // KYC gate in the UI mirrors the server rule: nothing until email + phone + payment method pass.
  const kycDone = me.kyc.canCall;
  const current: Tab = kycDone ? tab : 'verify';

  return (
    <div className="app">
      <h1>DG App</h1>
      <div className="tabs">
        {(['dialer', 'numbers', 'wallet', 'verify'] as Tab[]).map((t) => (
          <button key={t} className={current === t ? 'active' : ''} disabled={!kycDone && t !== 'verify'} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {current === 'verify' && <Verify me={me} onChange={refresh} />}
      {current === 'numbers' && <Numbers me={me} onChange={refresh} />}
      {current === 'wallet' && <Wallet me={me} />}
      {current === 'dialer' && <Dialer me={me} />}
      <p className="muted">
        {me.email} · <a href="#" onClick={async (e) => { e.preventDefault(); await api('/v1/auth/logout', { method: 'POST', body: {} }).catch(() => {}); setToken(''); setMe(null); }}>Sign out</a>
      </p>
    </div>
  );
}
