import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ApiError, type RoomData, type RoomMember, type StoredSession } from '@multicam/shared';
import { api } from '../api.ts';
import { CameraIcon, CloseIcon, CopyIcon, DoorIcon, FolderIcon, GearIcon, QrIcon } from '../components/Icons.tsx';
import { SettingsModal } from '../components/SettingsModal.tsx';

const POLL_MS = 2000;
const DEVICE_LABEL: Record<number, string> = { 1: 'Android', 2: 'iOS', 4: 'Web' };

function useCountdown(target: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!target) return 0;
  return Math.max(0, Math.floor((Date.parse(target) - now) / 1000));
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export function RoomPage({ session, onLoggedOut }: { session: StoredSession; onLoggedOut: () => void }) {
  const [room, setRoom] = useState<RoomData | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState('');
  const [showInvite, setShowInvite] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const roomRef = useRef<RoomData | null>(null);
  const remaining = useCountdown(room?.expires_at);

  // create_room: "Mở màn hình" → server trả phòng đang mở hoặc tạo phòng mới
  const openRoom = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createRoom();
      roomRef.current = r;
      setRoom(r);
      setMembers(r.members);
      setClosed(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.uiMessage : 'Không thể kết nối Internet');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    openRoom();
  }, [openRoom]);

  // QR chứa đúng nội dung mã mời (slide create_room)
  useEffect(() => {
    if (!room) return;
    QRCode.toDataURL(room.invite_code, { margin: 1, width: 360, color: { dark: '#111111', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(''));
  }, [room?.invite_code]);

  // Polling danh sách máy
  useEffect(() => {
    if (!room || closed) return;
    let stop = false;
    const tick = async () => {
      try {
        const d = await api.getRoomMembers(room.room_id);
        if (!stop) {
          setMembers(d.members);
          setError(null);
        }
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiError && e.code === '2005') setClosed(true);
        else if (e instanceof ApiError && e.code === 'NETWORK') setError('Mất kết nối tới server, đang thử lại…');
      }
    };
    const t = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [room?.room_id, closed]);

  async function kick(m: RoomMember) {
    if (!room || !confirm(`Loại "${m.camera_name}" ra khỏi phòng?`)) return;
    try {
      await api.kickMember(room.room_id, m.member_id);
      setMembers((list) => list.filter((x) => x.member_id !== m.member_id));
    } catch (e) {
      alert(e instanceof ApiError ? e.uiMessage : 'Không thể kết nối Internet');
    }
  }

  async function closeRoom() {
    if (!room || !confirm('Đóng phòng? Tất cả máy Remote sẽ bị đưa ra khỏi phòng.')) return;
    try {
      await api.closeRoom(room.room_id);
      setClosed(true);
      setMembers([]);
    } catch (e) {
      alert(e instanceof ApiError ? e.uiMessage : 'Không thể kết nối Internet');
    }
  }

  async function copyCode() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.invite_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard bị chặn */
    }
  }

  const online = members.filter((m) => m.is_online === '1').length;
  const slots = Math.max(4, members.length + (members.length < (room?.max_members ?? 8) ? 1 : 0));
  const initials = `${session.user.first_name[0] ?? ''}${session.user.last_name[0] ?? ''}`.toUpperCase() || 'C';
  const expired = remaining === 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <CameraIcon />
          </span>
          <strong>Multi-Cam Recorder</strong>
        </div>
        {room && !closed && (
          <button className="code-chip" onClick={copyCode} title="Sao chép mã phòng">
            <span className="label">MÃ PHÒNG</span>
            <span className={`code ${expired ? 'muted' : ''}`}>{room.invite_code}</span>
            <CopyIcon size={14} />
            {copied && <span className="toast">Đã chép</span>}
          </button>
        )}
        <div className="top-actions">
          <button className="icon-btn" onClick={() => setShowInvite((v) => !v)} title="Mời thiết bị" disabled={closed}>
            <QrIcon />
          </button>
          <button className="icon-btn" onClick={() => setShowSettings(true)} title="Cài đặt">
            <GearIcon />
          </button>
          <span className="avatar" title={session.user.email}>
            {initials}
          </span>
        </div>
      </header>

      {error && <div className="banner warn">{error}</div>}

      <main className="stage">
        {closed ? (
          <div className="empty-state">
            <DoorIcon size={40} />
            <h2>Phòng đã đóng</h2>
            <p>Các máy Remote đã được đưa ra khỏi phòng.</p>
            <button className="primary" onClick={openRoom} disabled={busy}>
              Mở phòng mới
            </button>
          </div>
        ) : !room ? (
          <div className="empty-state">{busy ? 'Đang mở phòng…' : <button className="primary" onClick={openRoom}>Thử lại</button>}</div>
        ) : (
          <div className={`grid count-${Math.min(slots, 9)}`}>
            {members.map((m, i) => (
              <article key={m.member_id} className={`tile ${m.is_online === '1' ? 'online' : 'offline'}`}>
                <div className="tile-head">
                  <span className="pill">
                    <span className={`dot ${m.is_online === '1' ? 'ok' : ''}`} />
                    Cam {String(i + 1).padStart(2, '0')} · {m.camera_name}
                  </span>
                  <button className="icon-btn small" title="Loại khỏi phòng" onClick={() => kick(m)}>
                    <CloseIcon size={14} />
                  </button>
                </div>
                <div className="tile-body">
                  <CameraIcon size={34} />
                  <span>{m.is_online === '1' ? 'Sẵn sàng nhận lệnh' : 'Mất kết nối'}</span>
                </div>
                <div className="tile-foot">
                  <span className="mono">
                    {m.device_name} · {DEVICE_LABEL[m.device_type] ?? ''}
                  </span>
                  <span className={`badge ${m.is_online === '1' ? 'ok' : 'off'}`}>{m.is_online === '1' ? 'ONLINE' : 'OFFLINE'}</span>
                </div>
              </article>
            ))}
            {Array.from({ length: slots - members.length }, (_, i) => (
              <article key={`empty-${i}`} className="tile empty">
                <div className="tile-body">
                  <CameraIcon size={34} />
                  <span>Đang chờ thiết bị tham gia…</span>
                </div>
              </article>
            ))}
          </div>
        )}

        {room && !closed && showInvite && (
          <aside className="invite">
            <div className="invite-head">
              <h3>Mời máy Remote</h3>
              <button className="icon-btn small" onClick={() => setShowInvite(false)} title="Ẩn">
                <CloseIcon size={14} />
              </button>
            </div>
            <p className="muted">Mở app trên điện thoại → Quét QR hoặc nhập mã</p>
            <div className={`qr ${expired ? 'expired' : ''}`}>{qr && <img src={qr} alt={`Mã QR của mã mời ${room.invite_code}`} />}</div>
            <div className="big-code">{room.invite_code}</div>
            {expired ? (
              <button className="primary" onClick={openRoom} disabled={busy}>
                Mã đã hết hạn · Tạo mã mới
              </button>
            ) : (
              <p className="muted">
                Hết hạn sau <strong className="mono">{mmss(remaining)}</strong>
              </p>
            )}
            <p className="muted small">
              {room.room_name} · tối đa {room.max_members} máy
            </p>
          </aside>
        )}
      </main>

      <footer className="control-bar">
        <div className="timer">
          <span className="mono big">00:00:00</span>
          <span className="muted">
            {online}/{members.length} thiết bị kết nối
          </span>
        </div>
        <div className="rec">
          <button className="rec-btn" disabled title="Điều khiển quay Start/Stop — Tuần 3">
            <span />
          </button>
          <span className="muted small">REC</span>
        </div>
        <div className="bar-actions">
          <button className="secondary" disabled title="Thư viện video — Tuần 5">
            <FolderIcon /> Thư viện
          </button>
          <button className="danger" onClick={closeRoom} disabled={!room || closed}>
            <DoorIcon /> Đóng phòng
          </button>
        </div>
      </footer>

      {showSettings && <SettingsModal session={session} onClose={() => setShowSettings(false)} onLoggedOut={onLoggedOut} />}
    </div>
  );
}
