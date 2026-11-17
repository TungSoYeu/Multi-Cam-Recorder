import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { StoredSession } from '@multicam/shared';
import { api, onSessionExpired } from './api.ts';
import { LoginPage } from './pages/LoginPage.tsx';
import { RoomPage } from './pages/RoomPage.tsx';
import './styles.css';

function App() {
  const [session, setSession] = useState<StoredSession | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.getSession().then((s) => setSession(s?.account_role === 'controller' ? s : null));
    return onSessionExpired(() => {
      setNotice('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
      setSession(null);
    });
  }, []);

  if (session === undefined) return <div className="splash">Đang tải…</div>;
  if (!session)
    return (
      <LoginPage
        notice={notice}
        onLoggedIn={(s) => {
          setNotice(null);
          setSession(s);
        }}
      />
    );
  return <RoomPage session={session} onLoggedOut={() => setSession(null)} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
