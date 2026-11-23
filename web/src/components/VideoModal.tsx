import { useEffect, useState } from 'react';
import { ApiError, type LibraryVideo, type VideoDetail } from '@multicam/shared';
import { api } from '../api.ts';
import { fmtBytes, fmtDuration, fmtTime } from '../format.ts';
import { CloseIcon } from './Icons.tsx';

const DEVICE = { 1: 'Android', 2: 'iOS', 4: 'Web' } as Record<number, string>;

/** Xem một clip (get_video → stream_url có hạn dùng, hỗ trợ tua). */
export function VideoModal({
  video,
  onClose,
  onDownload,
  onDelete,
  onGone,
}: {
  video: LibraryVideo;
  onClose: () => void;
  onDownload: () => void;
  onDelete: () => void;
  /** 4001: video đã bị xóa → gỡ khỏi danh sách và làm mới */
  onGone: () => void;
}) {
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getVideo(video.video_id)
      .then(setDetail)
      .catch((e) => {
        if (e instanceof ApiError && e.code === '4001') return onGone();
        setError(e instanceof ApiError ? e.uiMessage : 'Không thể kết nối Internet');
      });
  }, [video.video_id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows: [string, string][] = [
    ['Camera', video.camera_name ?? '—'],
    ['Thiết bị', `${video.device_name ?? '—'}${video.device_type ? ` · ${DEVICE[video.device_type]}` : ''}`],
    ['Người quay', video.owner.name],
    ['Bắt đầu quay', video.recorded_at ? fmtTime(video.recorded_at) : '—'],
    ['Tải lên lúc', fmtTime(video.created_at)],
    ['Thời lượng', fmtDuration(video.duration_ms)],
    ['Dung lượng', fmtBytes(video.size_bytes)],
    ['SHA-256', `${video.checksum_sha256.slice(0, 16)}…`],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal player-modal" role="dialog" aria-modal="true" aria-label={video.file_name} onClick={(e) => e.stopPropagation()}>
        <div className="invite-head">
          <h3>{video.file_name}</h3>
          <button className="icon-btn small" onClick={onClose} title="Đóng">
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="player-body">
          <div className="player-video">
            {error ? <p className="error">{error}</p> : detail?.stream_url ? <video src={detail.stream_url} controls autoPlay playsInline /> : <p className="muted">Đang tải…</p>}
          </div>
          <dl className="player-info">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="bar-actions">
          <button className="secondary" onClick={onDownload}>
            ⬇ Tải về
          </button>
          <button className="danger" onClick={onDelete}>
            <CloseIcon size={14} /> Xóa khỏi server
          </button>
        </div>
      </div>
    </div>
  );
}
