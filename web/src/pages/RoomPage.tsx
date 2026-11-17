import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ApiError, ClockSync, type RecordingState, type RoomData, type StoredSession, type SyncRoomData } from '@multicam/shared';
import { api } from '../api.ts';
import { CameraIcon, CloseIcon, CopyIcon, DoorIcon, FolderIcon, GearIcon, QrIcon } from '../components/Icons.tsx';
import { SettingsModal } from '../components/SettingsModal.tsx';

type Member = SyncRoomData['members'][number];

const DEVICE_LABEL: Record<number, string> = { 1: 'Android', 2: 'iOS', 4: 'Web' };
const CMD_LABEL = { start_recording: 'Start', stop_recording: 'Stop', switch_camera: 'Đổi camera' } as const;

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const hhmmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${mmss(s % 3600)}`;
};
const uuid = () => crypto.randomUUID();
const errMsg = (e: unknown) => (e instanceof ApiError ? e.uiMessage : 'Không thể kết nối Internet');

function useNow(ms = 250) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Battery({ level }: { level: number | null }) {
  if (level === null || level < 0) return null;
  const cls = level <= 20 ? 'low' : level <= 50 ? 'mid' : 'high';
  return (
    <span className={`battery ${cls}`} title="Pin">
      <span className="battery-body">
        <span style={{ width: `${level}%` }} />
      </span>
      {level}%
    </span>
  );
}

/** Gọi lại đúng một lần khi lỗi mạng, với CÙNG client_command_id (server trả 1010 nếu lệnh đã nhận). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'NETWORK') return fn();
    throw e;
  }
}

export function RoomPage({
  session,
  onLoggedOut,
  onOpenLibrary,
}: {
  session: StoredSession;
  onLoggedOut: () => void;
  onOpenLibrary: () => void;
}) {
  const [room, setRoom] = useState<RoomData | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [lastDuration, setLastDuration] = useState(0);
  const [videosReceived, setVideosReceived] = useState(0);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState('');
  const [showInvite, setShowInvite] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const clock = useRef(new ClockSync());
  /** Bỏ qua kết quả poll cũ trả về sau khi vừa gửi lệnh (tránh nút REC nhấp nháy) */
  const holdUntil = useRef(0);
  const now = useNow();

  // create_room: "Mở màn hình" → server trả phòng đang mở hoặc tạo phòng mới
  const openRoom = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createRoom();
      setRoom(r);
      setMembers(r.members.map((m) => ({ ...m, last_command: null })));
      setClosed(false);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    openRoom();
  }, [openRoom]);

  // QR chứa đúng nội dung mã mời (đề bài create_room)
  useEffect(() => {
    if (!room) return;
    QRCode.toDataURL(room.invite_code, { margin: 1, width: 360, color: { dark: '#111111', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(''));
  }, [room?.invite_code]);

  // sync_room: 1 giây/lần — danh sách máy, trạng thái, phiên quay
  useEffect(() => {
    if (!room || closed) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const sentAt = Date.now();
        const d = await api.syncRoom(room.room_id);
        if (stop) return;
        clock.current.sample(sentAt, Date.now(), d.server_time_ms);
        setMembers(d.members);
        setVideosReceived(d.videos_received);
        if (Date.now() > holdUntil.current) setRecording(d.recording);
        if (d.invite_code !== room.invite_code) setRoom((r) => (r ? { ...r, invite_code: d.invite_code, expires_at: d.expires_at } : r));
        setError(null);
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiError && e.code === '2005') setClosed(true);
        else if (e instanceof ApiError && e.code === 'NETWORK') setError('Mất kết nối tới server, đang thử lại…');
      }
      if (!stop) timer = setTimeout(tick, 1000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [room?.room_id, closed]);

  const serverNow = now + clock.current.offset;
  const isRecording = !!recording && !recording.stop_at_ms;
  const startsIn = recording ? recording.started_at_ms - serverNow : 0;

  async function toggleRecording() {
    if (!room || sending) return;
    setSending(true);
    const id = uuid();
    try {
      if (!isRecording) {
        const r = await withRetry(() => api.startRecording(room.room_id, id));
        holdUntil.current = Date.now() + 1500;
        setRecording({
          recording_session_id: r.recording_session_id,
          status: 'recording',
          started_at: r.execute_at,
          started_at_ms: r.execute_at_ms,
          stop_at: null,
          stop_at_ms: null,
        });
      } else {
        const r = await withRetry(() => api.stopRecording(room.room_id, id));
        holdUntil.current = Date.now() + 1500;
        setRecording((cur) => (cur ? { ...cur, status: 'stopped', stop_at: r.execute_at, stop_at_ms: r.execute_at_ms } : cur));
        setLastDuration(r.duration_ms ?? 0);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === '9994') alert('Phòng chưa có máy Remote nào.');
      else if (e instanceof ApiError && e.code === '2006') holdUntil.current = 0; // lệch trạng thái → lấy lại ở lần sync tới
      else alert(errMsg(e));
    } finally {
      setSending(false);
    }
  }

  async function switchCamera(m: Member) {
    if (!room) return;
    const next = m.state?.camera_facing === 'front' ? 'back' : 'front';
    try {
      await withRetry(() => api.switchCamera(room.room_id, m.member_id, next, uuid()));
    } catch (e) {
      alert(e instanceof ApiError && e.code === '2006' ? 'Không đổi được camera khi đang quay.' : errMsg(e));
    }
  }

  async function kick(m: Member) {
    if (!room || !confirm(`Loại "${m.camera_name}" ra khỏi phòng?`)) return;
    try {
      await api.kickMember(room.room_id, m.member_id);
      setMembers((list) => list.filter((x) => x.member_id !== m.member_id));
    } catch (e) {
      alert(errMsg(e));
    }
  }

  async function closeRoom() {
    if (!room) return;
    const warn = isRecording ? 'Phòng đang quay! ' : '';
    if (!confirm(`${warn}Đóng phòng? Tất cả máy Remote sẽ bị đưa ra khỏi phòng.`)) return;
    try {
      await api.closeRoom(room.room_id);
      setClosed(true);
      setMembers([]);
      setRecording(null);
    } catch (e) {
      alert(errMsg(e));
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
  const remaining = room ? Math.max(0, Math.floor((Date.parse(room.expires_at) - now) / 1000)) : 0;
  const expired = remaining === 0;

  let timerText = hhmmss(lastDuration);
  let timerNote = `${online}/${members.length} thiết bị kết nối · ${videosReceived} clip đã lên server`;
  if (recording && startsIn > 0) {
    timerText = hhmmss(0);
    timerNote = `Bắt đầu quay sau ${Math.ceil(startsIn / 1000)} giây…`;
  } else if (recording) {
    const endMs = recording.stop_at_ms ? Math.min(serverNow, recording.stop_at_ms) : serverNow;
    timerText = hhmmss(endMs - recording.started_at_ms);
    if (recording.stop_at_ms) timerNote = 'Đang dừng…';
  }

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
            {members.map((m, i) => {
              const on = m.is_online === '1';
              const s = m.state;
              const rec = on && s?.is_recording === '1';
              const cmd = m.last_command;
              return (
                <article key={m.member_id} className={`tile ${rec ? 'recording' : on ? 'online' : 'offline'}`}>
                  <div className="tile-head">
                    <span className="pill">
                      <span className={`dot ${rec ? 'rec' : on ? 'ok' : ''}`} />
                      Cam {String(i + 1).padStart(2, '0')} · {m.camera_name}
                    </span>
                    <span className="stats">
                      {s ? <Battery level={s.battery_level} /> : null}
                      {s?.free_storage_bytes != null ? <span title="Dung lượng trống">💾 {gb(s.free_storage_bytes)}</span> : null}
                      <button className="icon-btn small" title="Loại khỏi phòng" onClick={() => kick(m)}>
                        <CloseIcon size={14} />
                      </button>
                    </span>
                  </div>
                  <div className="tile-body">
                    <CameraIcon size={34} />
                    <span>
                      {!on ? 'Mất kết nối' : rec ? 'Đang quay' : 'Sẵn sàng nhận lệnh'}
                      {on && s ? ` · ${s.camera_facing === 'front' ? 'Camera trước' : 'Camera sau'}` : ''}
                    </span>
                    {s && s.uploads_pending > 0 ? (
                      <span className="upload" title="Clip đang chờ / đang tải lên server">
                        ⬆ {s.uploads_pending} clip{s.upload_progress !== null ? ` · ${s.upload_progress}%` : ' chờ tải lên'}
                        {s.upload_progress !== null ? (
                          <span className="upload-track">
                            <span style={{ width: `${s.upload_progress}%` }} />
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                    {cmd ? (
                      <span className={`cmd ${cmd.status}`} title="Trạng thái lệnh gần nhất">
                        {CMD_LABEL[cmd.type]}: {cmd.status === 'done' ? 'đã thực hiện' : cmd.status === 'failed' ? 'thất bại' : 'chờ máy nhận…'}
                      </span>
                    ) : null}
                  </div>
                  <div className="tile-foot">
                    <span className="mono">
                      {s?.resolution ? `${s.resolution} · ${s.fps ?? 30}fps` : `${m.device_name} · ${DEVICE_LABEL[m.device_type] ?? ''}`}
                    </span>
                    <span className="foot-actions">
                      <button
                        className="icon-btn small"
                        title={recording ? 'Không đổi được camera khi đang quay' : 'Đổi camera trước/sau'}
                        disabled={!!recording || !on}
                        onClick={() => switchCamera(m)}
                      >
                        🔄
                      </button>
                      <span className={`badge ${rec ? 'rec' : on ? 'ok' : 'off'}`}>{rec ? 'ON AIR' : on ? 'ONLINE' : 'OFFLINE'}</span>
                    </span>
                  </div>
                </article>
              );
            })}
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
          <span className={`mono big ${isRecording && startsIn <= 0 ? 'live' : ''}`}>{timerText}</span>
          <span className="muted">{timerNote}</span>
        </div>
        <div className="rec">
          <button
            className={`rec-btn ${isRecording ? 'on' : ''}`}
            onClick={toggleRecording}
            disabled={!room || closed || sending || members.length === 0 || (!!recording && !!recording.stop_at_ms)}
            title={members.length === 0 ? 'Phòng chưa có máy nào' : isRecording ? 'Dừng quay tất cả máy' : 'Bắt đầu quay tất cả máy'}
            aria-label={isRecording ? 'Dừng quay' : 'Bắt đầu quay'}
          >
            <span />
          </button>
          <span className="muted small">{isRecording ? 'STOP' : 'REC'}</span>
        </div>
        <div className="bar-actions">
          <button className="secondary" onClick={onOpenLibrary} title="Video đã upload trên server">
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
