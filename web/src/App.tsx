import { useCallback, useEffect, useRef, useState } from 'react';
import { api, hasToken, setToken, type Me } from './lib/api';
import SignUp from './screens/SignUp';
import Numbers from './screens/Numbers';
import Dialer from './screens/Dialer';
import Wallet from './screens/Wallet';

type Tab = 'numbers' | 'dialer' | 'wallet';

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>('numbers');
  const [loading, setLoading] = useState(hasToken());

  const refresh = useCallback(async () => {
    try { setMe(await api<Me>('/v1/me')); } catch { setToken(''); setMe(null); } finally { setLoading(false); }
  }, []);
  const paypalOnce = useRef(false);
  useEffect(() => { if (hasToken()) refresh(); }, [refresh]);
  useEffect(() => {
    if (paypalOnce.current || !hasToken()) return;
    const q = new URLSearchParams(window.location.search);
    const orderId = q.get('token');
    if (q.get('paypal') !== 'return' || !orderId) return;
    paypalOnce.current = true;
    api('/v1/paypal/capture', { body: { orderId } })
      .then(() => { window.history.replaceState({}, '', window.location.pathname); setTab('numbers'); return refresh(); })
      .catch(() => setTab('numbers'));
  }, [refresh]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('buy')) { setTab('numbers'); if (hasToken()) refresh(); window.history.replaceState({}, '', window.location.pathname); }
    if (q.get('topup')) { setTab('wallet'); if (hasToken()) refresh(); window.history.replaceState({}, '', window.location.pathname); }
  }, [refresh]);

  if (loading) return <div className="app">Loading...</div>;
  if (!me) return <div className="app"><h1>DG App</h1><SignUp onSignedIn={refresh} /></div>;

  return (
    <div className="app">
      <h1>DG App</h1>
      <div className="tabs">
        {(['numbers', 'dialer', 'wallet'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'numbers' && <Numbers me={me} onChange={refresh} />}
      {tab === 'wallet' && <Wallet me={me} onChange={refresh} />}
      <div style={{ display: tab === 'dialer' ? 'block' : 'none' }}>
        <Dialer me={me} onChange={refresh} />
      </div>
      <p className="muted">
        {me.email} · <a href="#" onClick={async (e) => { e.preventDefault(); await api('/v1/auth/logout', { method: 'POST', body: {} }).catch(() => {}); setToken(''); setMe(null); }}>Sign out</a>
      </p>
    </div>
  );
}
