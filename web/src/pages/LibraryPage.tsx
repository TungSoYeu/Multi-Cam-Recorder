import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, type LibraryVideo } from '@multicam/shared';
import { api } from '../api.ts';
import { CameraIcon, CloseIcon } from '../components/Icons.tsx';
import { VideoModal } from '../components/VideoModal.tsx';
import { SyncPlayer } from '../components/SyncPlayer.tsx';
import { fmtBytes, fmtDuration, fmtTime } from '../format.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof ApiError ? e.uiMessage : 'Không thể kết nối Internet');

interface Group {
  key: string;
  title: string;
  subtitle: string;
  videos: LibraryVideo[];
  syncable: boolean;
}

function triggerDownload(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function LibraryPage({ onBack }: { onBack: () => void }) {
  const [videos, setVideos] = useState<LibraryVideo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<LibraryVideo | null>(null);
  const [syncGroup, setSyncGroup] = useState<LibraryVideo[] | null>(null);
  const [dlStatus, setDlStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // get_list_videos: tải hết các trang (100 clip/trang)
  const load = useCallback(async () => {
    setError(null);
    try {
      const all: LibraryVideo[] = [];
      for (let index = 0; ; ) {
        const page = await api.listVideos({ index, count: 100 });
        all.push(...page.videos);
        if (page.has_more !== '1' || !page.count) break;
        index += page.count;
      }
      setVideos(all);
    } catch (e) {
      setError(errMsg(e));
      setVideos((v) => v ?? []);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Gom theo buổi quay đồng bộ; clip quay độc lập để riêng
  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, LibraryVideo[]>();
    for (const v of videos ?? []) {
      const key = v.recording_session_id ?? 'solo';
      map.set(key, [...(map.get(key) ?? []), v]);
    }
    const list: Group[] = [...map.entries()].map(([key, vs]) => {
      vs.sort((a, b) => (a.camera_name ?? '').localeCompare(b.camera_name ?? ''));
      const size = vs.reduce((s, v) => s + v.size_bytes, 0);
      if (key === 'solo')
        return { key, title: 'Quay độc lập', subtitle: `${vs.length} clip · ${fmtBytes(size)}`, videos: vs, syncable: false };
      const started = vs[0].session_started_at ?? vs[0].recorded_at ?? vs[0].created_at;
      const cams = new Set(vs.map((v) => v.device_id)).size;
      return {
        key,
        title: `Buổi quay ${fmtTime(started)}`,
        subtitle: `${cams} góc quay · ${vs.length} clip · ${fmtBytes(size)}`,
        videos: vs,
        syncable: vs.filter((v) => v.recorded_at_ms !== null).length >= 2,
      };
    });
    const time = (g: Group) => Math.max(...g.videos.map((v) => Date.parse(v.recorded_at ?? v.created_at)));
    return list.sort((a, b) => (a.key === 'solo' ? 1 : b.key === 'solo' ? -1 : time(b) - time(a)));
  }, [videos]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  /** Tải lần lượt; server trả 4002 khi lượt trước chưa xong → chờ rồi xin link lại (hàng đợi). */
  async function download(list: LibraryVideo[]) {
    for (const [i, v] of list.entries()) {
      setDlStatus(`Đang tải ${i + 1}/${list.length}: ${v.file_name}`);
      for (let tries = 0; ; tries++) {
        try {
          const link = await api.getDownloadUrl(v.video_id);
          triggerDownload(link.download_url, link.file_name);
          break;
        } catch (e) {
          if (e instanceof ApiError && e.code === '4002' && tries < 600) {
            setDlStatus(`Chờ clip trước tải xong… (${i + 1}/${list.length})`);
            await sleep(1500);
            continue;
          }
          alert(`${v.file_name}: ${errMsg(e)}`);
          break;
        }
      }
      await sleep(1000); // để trình duyệt kịp bắt đầu tải trước khi xin link tiếp
    }
    setDlStatus(null);
  }

  async function remove(ids: string[]) {
    if (!ids.length || !confirm(`Xóa vĩnh viễn ${ids.length} clip khỏi server?`)) return;
    setBusy(true);
    try {
      for (let i = 0; i < ids.length; i += 50) await api.deleteVideosBulk(ids.slice(i, i + 50));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === '4001')) alert(errMsg(e));
    } finally {
      setBusy(false);
      setSelected(new Set());
      setSelecting(false);
      setPlaying(null);
      load();
    }
  }

  const chosen = (videos ?? []).filter((v) => selected.has(v.video_id));
  const totalSize = (videos ?? []).reduce((s, v) => s + v.size_bytes, 0);

  return (
    <div className="app library">
      <header className="topbar">
        <div className="brand">
          <button className="icon-btn" onClick={onBack} title="Quay lại phòng" aria-label="Quay lại phòng">
            ‹
          </button>
          <strong>{selecting ? `Đã chọn ${selected.size}` : 'Video đã upload trên server'}</strong>
          {videos && !selecting ? (
            <span className="muted small">
              {videos.length} clip · {fmtBytes(totalSize)}
            </span>
          ) : null}
        </div>
        <div className="top-actions">
          <button className="secondary" onClick={load} title="Tải lại danh sách">
            Làm mới
          </button>
          {videos?.length ? (
            <button
              className={selecting ? 'secondary' : 'primary'}
              onClick={() => {
                setSelecting((s) => !s);
                setSelected(new Set());
              }}
            >
              {selecting ? 'Hủy' : 'Chọn'}
            </button>
          ) : null}
        </div>
      </header>

      {error && <div className="banner warn">{error}</div>}
      {dlStatus && <div className="banner warn">{dlStatus}</div>}

      <main className="lib-main">
        {videos === null ? (
          <div className="empty-state">Đang tải…</div>
        ) : videos.length === 0 ? (
          <div className="empty-state">
            <CameraIcon size={40} />
            <h2>Chưa có video nào</h2>
            <p>Clip sẽ tự xuất hiện ở đây sau khi máy Remote dừng quay và tải lên xong.</p>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="lib-group">
              <div className="lib-group-head">
                <div>
                  <h3>{g.title}</h3>
                  <span className="muted small">{g.subtitle}</span>
                </div>
                <div className="lib-group-actions">
                  {selecting ? (
                    <button
                      className="secondary"
                      onClick={() =>
                        setSelected((s) => {
                          const n = new Set(s);
                          const all = g.videos.every((v) => n.has(v.video_id));
                          for (const v of g.videos) all ? n.delete(v.video_id) : n.add(v.video_id);
                          return n;
                        })
                      }
                    >
                      Chọn cả buổi
                    </button>
                  ) : g.syncable ? (
                    <button className="primary" onClick={() => setSyncGroup(g.videos)}>
                      ▶ Xem đồng bộ {g.videos.length} góc
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="lib-grid">
                {g.videos.map((v) => {
                  const isSel = selected.has(v.video_id);
                  return (
                    <button
                      key={v.video_id}
                      className={`lib-card ${isSel ? 'selected' : ''}`}
                      onClick={() => (selecting ? toggle(v.video_id) : setPlaying(v))}
                      title={v.file_name}
                    >
                      <div className="lib-thumb">
                        {v.thumbnail_url ? <img src={v.thumbnail_url} alt="" loading="lazy" /> : <CameraIcon size={30} />}
                        <span className="lib-duration">{fmtDuration(v.duration_ms)}</span>
                        {v.camera_name ? <span className="lib-cam">{v.camera_name}</span> : null}
                        {selecting ? <span className={`lib-check ${isSel ? 'on' : ''}`}>{isSel ? '✓' : ''}</span> : null}
                      </div>
                      <span className="lib-name">{v.file_name}</span>
                      <span className="muted small">
                        {fmtBytes(v.size_bytes)} · {fmtTime(v.recorded_at ?? v.created_at)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </main>

      {selecting && (
        <footer className="control-bar lib-bar">
          <span className="muted">{selected.size ? `${selected.size} clip · ${fmtBytes(chosen.reduce((s, v) => s + v.size_bytes, 0))}` : 'Chọn clip để tải về hoặc xóa'}</span>
          <div className="bar-actions">
            <button className="secondary" disabled={!selected.size || !!dlStatus} onClick={() => download(chosen)}>
              ⬇ Tải về
            </button>
            <button className="danger" disabled={!selected.size || busy} onClick={() => remove([...selected])}>
              <CloseIcon size={14} /> Xóa
            </button>
          </div>
        </footer>
      )}

      {playing && (
        <VideoModal
          video={playing}
          onClose={() => setPlaying(null)}
          onDownload={() => download([playing])}
          onDelete={() => remove([playing.video_id])}
        />
      )}
      {syncGroup && <SyncPlayer videos={syncGroup} onClose={() => setSyncGroup(null)} />}
    </div>
  );
}
