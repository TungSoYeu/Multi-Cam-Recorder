import { ApiError, type UploadStatus as ServerUpload } from '@multicam/shared';
import { api } from '../api';
import { cameraState } from '../cameraState';
import { chunkSha256, fileSha256, readRange } from './hash';
import { clipFile, getClip, listClips, thumbFile, updateClip, type LocalClip } from './library';

/**
 * Hàng đợi tự động upload.
 * - Clip được gửi trước ngay trong lúc quay (liveUpload.ts); dừng quay thì hàng đợi gửi nốt và hoàn tất.
 * - Mỗi mảnh gửi lại tối đa 3 lần; vẫn lỗi thì tạm dừng và thử lại khi mở lại ứng dụng (mã 1007).
 * - Trạng thái (upload_id, checksum) lưu cùng clip để resume sau khi tắt app.
 */

export type UploadStatus = 'queued' | 'hashing' | 'uploading' | 'done' | 'paused' | 'error';
export interface UploadUi {
  status: UploadStatus;
  /** 0–1 */
  progress: number;
  message?: string;
}

const MAX_VIDEO_BYTES = 1024 ** 3;
const MAX_CHUNK_TRIES = 3;
const MAX_THUMB_BYTES = 290 * 1024;

const ui = new Map<string, UploadUi>();
const listeners = new Set<() => void>();
let running = false;
let again = false;
/** Lỗi chặn toàn bộ hàng đợi (hết dung lượng) — chờ người dùng thử lại / mở lại app */
let blocked: string | null = null;
const paused = new Set<string>();
/** Clip đang chờ upload-trong-lúc-quay kết thúc: hàng đợi chưa được đụng vào */
const held = new Set<string>();

const emit = () => listeners.forEach((fn) => fn());
function setUi(id: string, next: UploadUi) {
  ui.set(id, next);
  emit();
}

export function subscribeUploads(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function uploadUi(clip: LocalClip): UploadUi {
  if (clip.uploaded) return { status: 'done', progress: 1 };
  if (clip.upload_error) return { status: 'error', progress: 0, message: clip.upload_error };
  return ui.get(clip.id) ?? { status: 'queued', progress: 0 };
}

export const blockedReason = () => blocked;
export const holdUpload = (id: string) => void held.add(id);
export const releaseUpload = (id: string) => void held.delete(id);

/** Tóm tắt để gửi lên Controller qua sync_device */
export async function uploadSummary(): Promise<{ pending: number; progress: number | null }> {
  const clips = await listClips();
  const pending = clips.filter((c) => !c.uploaded && !c.upload_error);
  const active = pending.map((c) => ui.get(c.id)).find((u) => u?.status === 'uploading' || u?.status === 'hashing');
  return { pending: pending.length, progress: active ? Math.round(active.progress * 100) : null };
}

/** Mở app / quay lại app / bấm "Thử lại": bỏ trạng thái tạm dừng và chạy hàng đợi. */
export function resumeUploads() {
  blocked = null;
  for (const id of paused) ui.delete(id);
  paused.clear();
  emit();
  kickUploads();
}

/** Chạy hàng đợi. Chỉ một vòng chạy tại một thời điểm. */
export function kickUploads() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  (async () => {
    try {
      do {
        again = false;
        for (;;) {
          if (blocked) break;
          const next = (await listClips())
            .filter((c) => !c.uploaded && !c.upload_error && !paused.has(c.id) && !held.has(c.id))
            .sort((a, b) => a.created_at - b.created_at)[0];
          if (!next) break;
          await uploadOne(next.id);
        }
      } while (again);
    } finally {
      running = false;
    }
  })().catch(() => undefined);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isCode = (e: unknown, ...codes: string[]): e is ApiError => e instanceof ApiError && codes.includes(e.code);

async function thumbnailBase64(clip: LocalClip): Promise<string | undefined> {
  if (!clip.has_thumbnail) return undefined;
  try {
    const f = thumbFile(clip);
    if (!f.exists || (f.size ?? 0) > MAX_THUMB_BYTES) return undefined;
    return await f.base64();
  } catch {
    return undefined;
  }
}

/** Phiên upload của clip: phiên đã mở lúc quay nếu còn, nếu không thì mở phiên mới / resume phiên cũ. */
async function openSession(clip: LocalClip, checksum: string): Promise<ServerUpload> {
  if (clip.upload_id && clip.streaming) {
    try {
      return await api.getUploadStatus(clip.upload_id);
    } catch (e) {
      if (!isCode(e, '3001')) throw e;
      await updateClip(clip.id, { upload_id: null, streaming: false });
    }
  }
  const st = await api.initUpload({
    local_video_uid: clip.id,
    file_name: clip.file_name,
    total_size: clip.size_bytes,
    checksum_sha256: checksum,
    duration_ms: clip.duration_ms,
    recording_session_id: clip.recording_session_id,
    recorded_at_ms: clip.started_at_server_ms,
    camera_facing: clip.camera_facing,
    mime_type: clip.container === 'mov' ? 'video/quicktime' : 'video/mp4',
  });
  await updateClip(clip.id, { upload_id: st.upload_id, streaming: false });
  return st;
}

async function sendChunk(uploadId: string, index: number, bytes: Uint8Array, hex: string) {
  for (let tries = 1; ; tries++) {
    try {
      return await api.uploadChunk(uploadId, index, bytes, hex);
    } catch (e) {
      if (!isCode(e, 'NETWORK', '1007', '3003', '9999', '1001') || tries >= MAX_CHUNK_TRIES) throw e;
      await sleep(1000 * 2 ** (tries - 1));
    }
  }
}

async function uploadOne(id: string, attempt = 0): Promise<void> {
  let clip = await getClip(id);
  if (!clip || clip.uploaded) return;
  const file = clipFile(clip);
  try {
    if (!file.exists) {
      await updateClip(id, { upload_error: 'File không còn trên máy' });
      return;
    }
    const size = file.size ?? 0;
    if (size === 0) {
      await updateClip(id, { upload_error: 'File video rỗng' });
      return;
    }
    // 1006: chặn ngay từ client trước khi gọi init_upload
    if (size > MAX_VIDEO_BYTES) {
      await updateClip(id, { upload_error: 'Video vượt quá 1 GB' });
      return;
    }
    // 1. SHA-256 toàn file (một lần)
    if (!clip.checksum_sha256) {
      setUi(id, { status: 'hashing', progress: 0, message: 'Đang chuẩn bị' });
      const checksum = await fileSha256(file, size, {
        busy: () => cameraState.isRecording,
        onProgress: (p) => setUi(id, { status: 'hashing', progress: p, message: 'Đang chuẩn bị' }),
      });
      await updateClip(id, { checksum_sha256: checksum, size_bytes: size });
    }
    clip = (await getClip(id))!;
    const checksum = clip.checksum_sha256!;

    // 2. Phiên upload (đã mở lúc quay / resume / mới)
    const st = await openSession(clip, checksum);
    if (st.status === 'completed') return await markDone(id, st.video_id);

    // 3. Chỉ gửi mảnh server chưa có hoặc có nội dung khác file cuối cùng
    const total = Math.ceil(size / st.chunk_size);
    setUi(id, { status: 'uploading', progress: 0 });
    for (let i = 0; i < total; i++) {
      const offset = i * st.chunk_size;
      const bytes = await readRange(file, offset, Math.min(st.chunk_size, size - offset));
      const hex = await chunkSha256(bytes);
      if (st.chunk_hashes[String(i)] !== hex) await sendChunk(st.upload_id, i, bytes, hex);
      setUi(id, { status: 'uploading', progress: (i + 1) / total });
    }

    // 4. Hoàn tất
    const video = await api.completeUpload(st.upload_id, {
      thumbnail_base64: await thumbnailBase64(clip),
      total_size: size,
      checksum_sha256: checksum,
      duration_ms: clip.duration_ms,
    });
    await markDone(id, video.video_id);
  } catch (e) {
    await handleError(id, e, attempt);
  }
}

async function markDone(id: string, videoId: string | null) {
  await updateClip(id, { uploaded: true, upload_id: null, streaming: false, video_id: videoId });
  setUi(id, { status: 'done', progress: 1 });
}

/** Xử lý lỗi theo cột "Ứng dụng xử lý" của bảng mã response. */
async function handleError(id: string, e: unknown, attempt: number): Promise<void> {
  if (isCode(e, '3005')) return markDone(id, (e.data as { video_id?: string } | null)?.video_id ?? null);
  if (isCode(e, '3001', '3002', '3003') && attempt < 2) {
    // 3002: hỏi lại server mảnh nào thiếu (cùng phiên); 3001 / 3003 toàn file: mở phiên mới
    if (!isCode(e, '3002')) await updateClip(id, { upload_id: null, streaming: false });
    if (isCode(e, '3003') && (e.data as { scope?: string } | null)?.scope === 'file')
      await updateClip(id, { checksum_sha256: undefined });
    return uploadOne(id, attempt + 1);
  }
  if (isCode(e, '1006')) {
    await updateClip(id, { upload_error: 'Video vượt quá 1 GB' });
    ui.delete(id);
    return emit();
  }
  if (isCode(e, '3004', '9998')) {
    blocked =
      e.code === '3004'
        ? 'Đã hết dung lượng lưu trữ. Hãy nhờ Controller xóa bớt clip cũ.'
        : 'Cần đăng nhập lại để tiếp tục tải lên';
    return setUi(id, { status: 'paused', progress: 0, message: blocked });
  }
  paused.add(id);
  setUi(id, {
    status: 'paused',
    progress: ui.get(id)?.progress ?? 0,
    message: e instanceof ApiError ? e.uiMessage : 'Tải lên bị gián đoạn',
  });
}
