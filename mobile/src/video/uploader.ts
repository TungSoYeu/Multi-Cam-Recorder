import { File } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { ApiError } from '@multicam/shared';
import { api } from '../api';
import { getClip, listClips, updateClip, type LocalClip } from './library';

/**
 * Hàng đợi tự động upload.
 * - Clip vừa quay xong được đưa vào hàng đợi, upload lần lượt từng clip, từng mảnh (mặc định 5 MB).
 * - Mỗi mảnh gửi lại tối đa 3 lần; vẫn lỗi thì tạm dừng và thử lại khi mở lại ứng dụng (theo bảng mã 1007).
 * - Trạng thái (upload_id, checksum) lưu cùng clip để resume sau khi tắt app.
 */

export type UploadStatus = 'queued' | 'hashing' | 'uploading' | 'done' | 'paused' | 'error';
export interface UploadUi {
  status: UploadStatus;
  /** 0–1 */
  progress: number;
  message?: string;
}

const HASH_BLOCK = 4 * 1024 * 1024;
const MAX_CHUNK_TRIES = 3;
const MAX_THUMB_BYTES = 300 * 1024;

const ui = new Map<string, UploadUi>();
const listeners = new Set<() => void>();
let running = false;
/** Lỗi chặn toàn bộ hàng đợi (hết dung lượng) — chờ người dùng thử lại / mở lại app */
let blocked: string | null = null;
const paused = new Set<string>();

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
  return ui.get(clip.id) ?? (paused.has(clip.id) ? { status: 'paused', progress: 0 } : { status: 'queued', progress: 0 });
}

export function blockedReason() {
  return blocked;
}

/** Tóm tắt để gửi lên Controller qua sync_device */
export async function uploadSummary(): Promise<{ pending: number; progress: number | null }> {
  const clips = await listClips();
  const pending = clips.filter((c) => !c.uploaded && !c.upload_error).length;
  const active = [...ui.values()].find((u) => u.status === 'uploading' || u.status === 'hashing');
  return { pending, progress: active ? Math.round(active.progress * 100) : null };
}

/** Mở app / quay lại app / bấm "Thử lại": bỏ trạng thái tạm dừng và chạy hàng đợi. */
export function resumeUploads() {
  blocked = null;
  for (const id of paused) ui.delete(id);
  paused.clear();
  emit();
  kickUploads();
}

/** Chạy hàng đợi (gọi sau khi lưu clip mới). Chỉ một vòng chạy tại một thời điểm. */
export function kickUploads() {
  if (running) return;
  running = true;
  (async () => {
    try {
      for (;;) {
        if (blocked) break;
        const next = (await listClips())
          .filter((c) => !c.uploaded && !c.upload_error && !paused.has(c.id))
          .sort((a, b) => a.created_at - b.created_at)[0];
        if (!next) break;
        await uploadOne(next.id);
      }
    } finally {
      running = false;
    }
  })();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isCode = (e: unknown, code: string) => e instanceof ApiError && e.code === code;

async function readRange(file: File, offset: number, length: number): Promise<Uint8Array> {
  const h = file.open();
  try {
    h.offset = offset;
    return await h.readBytes(length);
  } finally {
    h.close();
  }
}

/** SHA-256 toàn file, đọc từng khối 4 MB (không nạp cả file vào bộ nhớ). */
async function hashFile(clip: LocalClip): Promise<string> {
  const file = new File(clip.uri);
  const total = file.size ?? clip.size_bytes;
  const h = sha256.create();
  const handle = file.open();
  try {
    for (let off = 0; off < total; off += HASH_BLOCK) {
      handle.offset = off;
      h.update(await handle.readBytes(Math.min(HASH_BLOCK, total - off)));
      setUi(clip.id, { status: 'hashing', progress: Math.min(1, (off + HASH_BLOCK) / total), message: 'Đang chuẩn bị' });
    }
  } finally {
    handle.close();
  }
  return bytesToHex(h.digest());
}

async function thumbnailBase64(clip: LocalClip): Promise<string | undefined> {
  if (!clip.thumbnail_uri) return undefined;
  try {
    const f = new File(clip.thumbnail_uri);
    if (!f.exists || (f.size ?? 0) > MAX_THUMB_BYTES) return undefined;
    return await f.base64();
  } catch {
    return undefined;
  }
}

async function uploadOne(id: string, attempt = 0): Promise<void> {
  let clip = await getClip(id);
  if (!clip || clip.uploaded) return;
  const file = new File(clip.uri);
  if (!file.exists) {
    await updateClip(id, { upload_error: 'File không còn trên máy' });
    return;
  }

  try {
    // 1. SHA-256 toàn file (một lần)
    if (!clip.checksum_sha256) {
      const checksum = await hashFile(clip);
      await updateClip(id, { checksum_sha256: checksum, size_bytes: file.size ?? clip.size_bytes });
      clip = (await getClip(id))!;
    }

    // 2. Mở phiên (server trả lại phiên cũ nếu đang dở → resume)
    let status;
    try {
      status = await api.initUpload({
        local_video_uid: clip.id,
        file_name: clip.file_name,
        total_size: clip.size_bytes,
        checksum_sha256: clip.checksum_sha256!,
        duration_ms: clip.duration_ms,
        recording_session_id: clip.recording_session_id,
        recorded_at_ms: clip.started_at_server_ms,
        camera_facing: clip.camera_facing,
        mime_type: clip.container === 'mov' ? 'video/quicktime' : 'video/mp4',
      });
    } catch (e) {
      if (isCode(e, '3005')) {
        // Đã có trên server: KHÔNG phải lỗi thật — đánh dấu đã gửi
        const videoId = ((e as ApiError).data as { video_id?: string } | null)?.video_id ?? null;
        await updateClip(id, { uploaded: true, upload_id: null, video_id: videoId });
        setUi(id, { status: 'done', progress: 1 });
        return;
      }
      throw e;
    }
    await updateClip(id, { upload_id: status.upload_id });

    // 3. Gửi các mảnh còn thiếu
    const total = status.total_chunks;
    let sent = total - status.missing_chunks.length;
    setUi(id, { status: 'uploading', progress: sent / total });
    for (const index of status.missing_chunks) {
      const offset = index * status.chunk_size;
      const bytes = await readRange(file, offset, Math.min(status.chunk_size, clip.size_bytes - offset));
      const hex = bytesToHex(sha256(bytes));
      for (let tries = 1; ; tries++) {
        try {
          await api.uploadChunk(status.upload_id, index, bytes, hex);
          break;
        } catch (e) {
          const retryable = isCode(e, 'NETWORK') || isCode(e, '1007') || isCode(e, '3003') || isCode(e, '9999') || isCode(e, '1001');
          if (!retryable || tries >= MAX_CHUNK_TRIES) throw e;
          await sleep(1000 * 2 ** (tries - 1));
        }
      }
      sent++;
      setUi(id, { status: 'uploading', progress: sent / total });
    }

    // 4. Hoàn tất
    const video = await api.completeUpload(status.upload_id, await thumbnailBase64(clip));
    await updateClip(id, { uploaded: true, upload_id: null, video_id: video.video_id });
    setUi(id, { status: 'done', progress: 1 });
  } catch (e) {
    // Lỗi có cách xử lý riêng theo bảng mã
    if ((isCode(e, '3001') || isCode(e, '3002') || isCode(e, '3003')) && attempt < 2) {
      // 3001 phiên hết hạn / 3003 sai toàn file → mở phiên mới; 3002 thiếu mảnh → init lại sẽ trả mảnh còn thiếu
      if (!isCode(e, '3002')) await updateClip(id, { upload_id: null });
      if (isCode(e, '3003') && (e as ApiError).data && ((e as ApiError).data as { scope?: string }).scope === 'file')
        await updateClip(id, { checksum_sha256: undefined });
      return uploadOne(id, attempt + 1);
    }
    if (isCode(e, '1006')) {
      await updateClip(id, { upload_error: 'Video vượt quá 1 GB' });
      ui.delete(id);
      emit();
      return;
    }
    if (isCode(e, '3004')) {
      blocked = 'Đã hết dung lượng lưu trữ. Hãy nhờ Controller xóa bớt clip cũ.';
      setUi(id, { status: 'paused', progress: 0, message: blocked });
      return;
    }
    if (isCode(e, '9998')) {
      // Phiên đăng nhập hết hạn: dừng, chờ đăng nhập lại
      blocked = 'Cần đăng nhập lại để tiếp tục tải lên';
      setUi(id, { status: 'paused', progress: 0, message: blocked });
      return;
    }
    // Lỗi mạng / server sau 3 lần thử: tạm dừng clip này, thử lại khi mở lại ứng dụng
    paused.add(id);
    setUi(id, {
      status: 'paused',
      progress: ui.get(id)?.progress ?? 0,
      message: e instanceof ApiError ? e.uiMessage : 'Tải lên bị gián đoạn',
    });
  }
}
