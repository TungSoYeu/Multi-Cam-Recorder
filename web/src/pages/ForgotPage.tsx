import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, isEmail, passwordProblem, type Identifier } from '@multicam/shared';
import { api } from '../api.ts';

const toIdent = (s: string): Identifier => (isEmail(s) ? { email: s.trim().toLowerCase() } : { phone: s.trim() });

/**
 * Quên mật khẩu Controller. Mã KHÔNG hiện trên web: gửi qua email (nếu server có SMTP) và hiện trên
 * màn hình terminal của server — máy Controller chính là server.
 */
export function ForgotPage({ onDone, onBack }: { onDone: (notice: string) => void; onBack: () => void }) {
  const [id, setId] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!id.trim()) return setError('Nhập email hoặc số điện thoại');
    setBusy(true);
    setError(null);
    try {
      const d = await api.getVerifyCode({ ...toIdent(id), purpose: 'forgot_password' } as Parameters<typeof api.getVerifyCode>[0]);
      setSentTo(d.masked_target);
      setWait(d.resend_after);
    } catch (err) {
      if (err instanceof ApiError && err.code === '1012') {
        setSentTo((s) => s ?? id);
        setWait((err.data as { retry_after?: number } | null)?.retry_after ?? 120);
      } else setError(err instanceof ApiError ? err.uiMessage : 'Không thể kết nối Internet');
    } finally {
      setBusy(false);
    }
  }

  async function reset(e: FormEvent) {
    e.preventDefault();
    const ident = toIdent(id);
    const problem = passwordProblem(pw, ident.phone);
    if (!/^\d{6}$/.test(code)) return setError('Nhập đủ 6 số');
    if (problem) return setError(problem);
    if (pw !== pw2) return setError('Mật khẩu nhập lại không khớp');
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword({ ...ident, code_verify: code, new_password: pw } as Parameters<typeof api.forgotPassword>[0]);
      onDone('Đã đặt lại mật khẩu. Hãy đăng nhập bằng mật khẩu mới.');
    } catch (err) {
      if (err instanceof ApiError && err.code === '9993') setCode('');
      setError(err instanceof ApiError ? err.uiMessage : 'Không thể kết nối Internet');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={sentTo ? reset : send} noValidate>
        <h1>Khôi phục mật khẩu</h1>
        {!sentTo ? (
          <label className="field">
            <span>Email hoặc số điện thoại</span>
            <input autoFocus value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" />
          </label>
        ) : (
          <>
            <p className="hint">Mã 6 số đã gửi tới {sentTo}. Nếu server chưa cấu hình email, xem mã ở cửa sổ terminal đang chạy server.</p>
            <label className="field">
              <span>Mã xác thực</span>
              <input autoFocus inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" />
            </label>
            <label className="field">
              <span>Mật khẩu mới (6–20 chữ và số)</span>
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
            </label>
            <label className="field">
              <span>Nhập lại mật khẩu mới</span>
              <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
            </label>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {sentTo ? 'Lưu mật khẩu' : 'Gửi mã xác minh'}
        </button>
        {sentTo ? (
          <button type="button" className="ghost" disabled={wait > 0 || busy} onClick={() => send()}>
            {wait > 0 ? `Gửi lại mã sau ${wait} giây` : 'Gửi lại mã'}
          </button>
        ) : null}
        <button type="button" className="ghost" onClick={onBack}>
          Quay lại đăng nhập
        </button>
      </form>
    </main>
  );
}
