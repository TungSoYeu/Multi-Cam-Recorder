import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { StoredSession } from '@multicam/shared';
import { api, onSessionExpired } from './api.ts';
import { ForgotPage } from './pages/ForgotPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { RoomPage } from './pages/RoomPage.tsx';
import { LibraryPage } from './pages/LibraryPage.tsx';
import './styles.css';

function App() {
  const [session, setSession] = useState<StoredSession | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const [view, setView] = useState<'room' | 'library'>('room');

  useEffect(() => {
    api.getSession().then((s) => setSession(s?.account_role === 'controller' ? s : null));
    return onSessionExpired(() => {
      setNotice('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
      setSession(null);
    });
  }, []);

  if (session === undefined) return <div className="splash">Đang tải…</div>;
  if (!session && forgot)
    return (
      <ForgotPage
        onBack={() => setForgot(false)}
        onDone={(n) => {
          setNotice(n);
          setForgot(false);
        }}
      />
    );
  if (!session)
    return (
      <LoginPage
        onForgot={() => setForgot(true)}
        notice={notice}
        onLoggedIn={(s) => {
          setNotice(null);
          setSession(s);
        }}
      />
    );
  if (view === 'library') return <LibraryPage onBack={() => setView('room')} />;
  return <RoomPage session={session} onLoggedOut={() => setSession(null)} onOpenLibrary={() => setView('library')} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
