import { useState, type FormEvent } from 'react';
import { ApiError, isEmail, type StoredSession } from '@multicam/shared';
import { api, browserName, clientDeviceId } from '../api.ts';
import { CameraIcon } from '../components/Icons.tsx';

export function LoginPage({ notice, onLoggedIn, onForgot }: { notice: string | null; onLoggedIn: (s: StoredSession) => void; onForgot: () => void }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const id = identifier.trim();
    if (!id) return setError({ field: 'id', text: 'Nhập email hoặc số điện thoại' });
    if (!password) return setError({ field: 'password', text: 'Nhập mật khẩu' });
    setBusy(true);
    setError(null);
    try {
      const d = await api.login({
        ...(isEmail(id) ? { email: id } : { phone: id }),
        password,
        device_id: clientDeviceId(),
        device_type: 4,
        device_name: browserName(),
      });
      if (d.account_role !== 'controller') {
        await api.logout().catch(() => api.clearSession());
        setError({ text: 'Giao diện web dành cho tài khoản Controller. Tài khoản Remote hãy dùng app trên điện thoại.' });
        return;
      }
      const s = await api.getSession();
      if (s) onLoggedIn(s);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === '9995') setError({ field: 'id', text: (err.data as { reason?: string } | null)?.reason === 'locked' ? 'Tài khoản đã bị khóa' : 'Tài khoản không tồn tại' });
        else if (err.code === '1004' && (err.data as { field?: string } | null)?.field === 'password')
          setError({ field: 'password', text: 'Sai mật khẩu' });
        else setError({ text: err.uiMessage });
      } else setError({ text: 'Không thể kết nối Internet' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="brand-mark">
          <CameraIcon size={28} />
        </div>
        <h1>Multi-Cam Recorder</h1>
        <p className="tag">CONTROLLER</p>
        {notice && <div className="banner warn">{notice}</div>}
        <label className="field">
          <span>Email hoặc số điện thoại</span>
          <input
            autoFocus
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            aria-invalid={error?.field === 'id'}
          />
        </label>
        <label className="field">
          <span>Mật khẩu</span>
          <div className="pw">
            <input
              type={showPw ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error?.field === 'password'}
            />
            <button type="button" className="ghost small" onClick={() => setShowPw((v) => !v)}>
              {showPw ? 'Ẩn' : 'Hiện'}
            </button>
          </div>
        </label>
        {error && <p className="error">{error.text}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
        <button type="button" className="ghost" onClick={onForgot}>
          Quên mật khẩu?
        </button>
        <p className="hint">Tài khoản Controller do nhà phát hành cấp sẵn, không đăng ký được.</p>
      </form>
    </main>
  );
}
