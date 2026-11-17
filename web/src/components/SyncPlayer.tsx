import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type LibraryVideo } from '@multicam/shared';
import { api } from '../api.ts';
import { fmtClock } from '../format.ts';
import { CloseIcon } from './Icons.tsx';

/** Lệch quá ngưỡng này (giây) thì kéo video về đúng vị trí theo đồng hồ chung */
const DRIFT_SEC = 0.2;

interface Track {
  video: LibraryVideo;
  url: string | null;
  /** Bắt đầu muộn hơn góc quay sớm nhất bao nhiêu giây */
  offset: number;
  duration: number;
}

/**
 * Phát cùng lúc mọi góc quay của một buổi, căn khớp theo `recorded_at_ms`
 * (giờ server lúc máy thực sự bắt đầu quay). Một đồng hồ chung điều khiển mọi video.
 */
export function SyncPlayer({ videos, onClose }: { videos: LibraryVideo[]; onClose: () => void }) {
  const base = useMemo(() => Math.min(...videos.map((v) => v.recorded_at_ms ?? Infinity)), [videos]);
  const [tracks, setTracks] = useState<Track[]>(() =>
    videos
      .filter((v) => v.recorded_at_ms !== null)
      .map((v) => ({ video: v, url: null, offset: (v.recorded_at_ms! - base) / 1000, duration: (v.duration_ms ?? 0) / 1000 })),
  );
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [audio, setAudio] = useState(0);
  const refs = useRef<(HTMLVideoElement | null)[]>([]);
  const clock = useRef({ startPerf: 0, startT: 0, playing: false });
  const total = Math.max(0.1, ...tracks.map((t) => t.offset + t.duration));

  // get_video cho từng góc để lấy stream_url
  useEffect(() => {
    Promise.all(videos.filter((v) => v.recorded_at_ms !== null).map((v) => api.getVideo(v.video_id)))
      .then((details) => setTracks((ts) => ts.map((t, i) => ({ ...t, url: details[i].stream_url }))))
      .catch((e) => setError(e instanceof ApiError ? e.uiMessage : 'Không thể kết nối Internet'));
  }, [videos]);

  const now = () => (clock.current.playing ? clock.current.startT + (performance.now() - clock.current.startPerf) / 1000 : clock.current.startT);

  /** Đưa mọi video về đúng vị trí của đồng hồ chung. */
  function align(t: number, hard = false) {
    tracks.forEach((tr, i) => {
      const el = refs.current[i];
      if (!el) return;
      const local = t - tr.offset;
      const inside = local >= 0 && local < (el.duration || tr.duration || Infinity);
      const target = Math.min(Math.max(local, 0), Math.max(0, (el.duration || tr.duration) - 0.05));
      if (hard || Math.abs(el.currentTime - target) > DRIFT_SEC) el.currentTime = target;
      if (clock.current.playing && inside) {
        if (el.paused) el.play().catch(() => undefined);
      } else if (!el.paused) el.pause();
    });
  }

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const t = now();
      if (t >= total) {
        clock.current = { startPerf: 0, startT: total, playing: false };
        setPlaying(false);
      }
      setTime(Math.min(t, total));
      align(Math.min(t, total));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  function play() {
    const t = time >= total ? 0 : time;
    clock.current = { startPerf: performance.now(), startT: t, playing: true };
    setPlaying(true);
    align(t, true);
  }
  function pause() {
    clock.current = { startPerf: 0, startT: now(), playing: false };
    setPlaying(false);
  }
  function seek(t: number) {
    clock.current = { startPerf: performance.now(), startT: t, playing: clock.current.playing };
    setTime(t);
    align(t, true);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === ' ') {
        e.preventDefault();
        clock.current.playing ? pause() : play();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const cols = tracks.length <= 1 ? 1 : tracks.length <= 4 ? 2 : 3;
  return (
    <div className="modal-backdrop sync-backdrop">
      <div className="sync-player" role="dialog" aria-modal="true" aria-label="Xem đồng bộ các góc quay">
        <div className="invite-head">
          <h3>Xem đồng bộ · {tracks.length} góc quay</h3>
          <button className="icon-btn small" onClick={onClose} title="Đóng (Esc)">
            <CloseIcon size={14} />
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="sync-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {tracks.map((tr, i) => {
            const local = time - tr.offset;
            const state = local < 0 ? `Bắt đầu sau ${(-local).toFixed(1)} s` : local > tr.duration && tr.duration > 0 ? 'Đã kết thúc' : null;
            return (
              <div key={tr.video.video_id} className={`sync-cell ${audio === i ? 'audio' : ''}`} onClick={() => setAudio(i)} title="Bấm để nghe tiếng góc này">
                {tr.url ? (
                  <video
                    ref={(el) => {
                      refs.current[i] = el;
                    }}
                    src={tr.url}
                    muted={audio !== i}
                    playsInline
                    preload="auto"
                  />
                ) : (
                  <div className="sync-loading">Đang tải…</div>
                )}
                <span className="pill sync-label">
                  {audio === i ? '🔊' : '🔇'} {tr.video.camera_name ?? tr.video.file_name}
                </span>
                <span className="sync-offset mono">+{Math.round(tr.offset * 1000)} ms</span>
                {state ? <div className="sync-state">{state}</div> : null}
              </div>
            );
          })}
        </div>
        <div className="sync-controls">
          <button className="primary" onClick={playing ? pause : play} aria-label={playing ? 'Tạm dừng' : 'Phát'}>
            {playing ? '❚❚ Tạm dừng' : '▶ Phát'}
          </button>
          <input type="range" min={0} max={total} step={0.05} value={time} onChange={(e) => seek(Number(e.target.value))} aria-label="Tua" />
          <span className="mono">
            {fmtClock(time)} / {fmtClock(total)}
          </span>
        </div>
        <p className="muted small">
          Các góc được căn theo thời điểm bắt đầu quay thực tế (giờ server). Độ lệch so với góc sớm nhất hiện ở góc trên phải mỗi khung. Bấm vào một khung để nghe tiếng của góc đó; Space để phát/dừng.
        </p>
      </div>
    </div>
  );
}
