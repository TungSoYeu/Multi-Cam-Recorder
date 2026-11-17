import { useState, type FormEvent } from 'react';
import { ApiError, passwordProblem, type StoredSession } from '@multicam/shared';
import { api } from '../api.ts';
import { CloseIcon } from './Icons.tsx';

export function SettingsModal({
  session,
  onClose,
  onLoggedOut,
}: {
  session: StoredSession;
  onClose: () => void;
  onLoggedOut: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(next, session.user.phone);
    if (!current) return setMsg({ ok: false, text: 'Nhập mật khẩu hiện tại' });
    if (problem) return setMsg({ ok: false, text: problem });
    if (next !== confirmPw) return setMsg({ ok: false, text: 'Mật khẩu nhập lại không khớp' });
    setBusy(true);
    try {
      await api.changePassword({ password: current, new_password: next });
      setMsg({ ok: true, text: 'Đã đổi mật khẩu. Các phiên ở máy khác đã bị đăng xuất.' });
      setCurrent('');
      setNext('');
      setConfirmPw('');
    } catch (err) {
      const field = err instanceof ApiError ? (err.data as { field?: string } | null)?.field : undefined;
      setMsg({
        ok: false,
        text: field === 'password' ? 'Mật khẩu hiện tại không đúng' : err instanceof ApiError ? err.uiMessage : 'Lỗi kết nối',
      });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!confirm('Đăng xuất? Phòng đang mở sẽ bị đóng.')) return;
    await api.logout().catch(() => undefined);
    onLoggedOut();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Cài đặt" onClick={(e) => e.stopPropagation()}>
        <div className="invite-head">
          <h3>Cài đặt</h3>
          <button className="icon-btn small" onClick={onClose} title="Đóng">
            <CloseIcon size={14} />
          </button>
        </div>
        <section className="profile">
          <strong>
            {session.user.first_name} {session.user.last_name}
          </strong>
          <span className="badge ok">CONTROLLER</span>
          <span className="muted">{session.user.email}</span>
          <span className="muted">{session.user.phone}</span>
        </section>
        <form onSubmit={changePassword} className="stack">
          <h4>Đổi mật khẩu</h4>
          <input type="password" placeholder="Mật khẩu hiện tại" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          <input type="password" placeholder="Mật khẩu mới (6–20 chữ/số)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          <input type="password" placeholder="Nhập lại mật khẩu mới" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
          {msg && <p className={msg.ok ? 'success' : 'error'}>{msg.text}</p>}
          <button className="primary" disabled={busy}>
            Lưu mật khẩu
          </button>
        </form>
        <button className="danger full" onClick={logout}>
          Đăng xuất
        </button>
      </div>
    </div>
  );
}
