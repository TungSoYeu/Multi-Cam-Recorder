import { Directory, File, Paths } from 'expo-file-system';
import type { CameraFacing } from '@multicam/shared';
import { api } from '../api';
import { chunkSha256, readRange } from './hash';
import { fileStem } from './library';

/**
 * Upload NGAY TRONG LÚC QUAY (chức năng 8).
 * Camera ghi dần ra một file trong cache; ta gửi từng mảnh đã ghi xong lên phiên upload "streaming".
 * Phần đầu file có thể bị máy ghi lại lúc dừng, nên các mảnh này chỉ là gửi trước: uploader so SHA-256
 * từng mảnh với file cuối cùng và gửi lại mảnh khác, rồi server kiểm tra SHA-256 toàn file.
 * Mọi lỗi ở đây đều bỏ qua: clip vẫn được upload bình thường sau khi dừng quay.
 */

export const LIVE_CHUNK = 1024 * 1024;

let liveBytes: number | null = null;
/** Số byte đã lên server của clip đang quay (null nếu không quay) — gửi cho Controller qua sync_device */
export const liveUploadedBytes = () => liveBytes;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cameraDir = () => new Directory(Paths.cache, 'Camera');

/** Các file video camera đã có từ trước — gọi NGAY TRƯỚC khi bắt đầu quay. */
export function cameraFilesBefore(): Set<string> {
  try {
    const d = cameraDir();
    return new Set(d.exists ? d.list().map((f) => f.name) : []);
  } catch {
    return new Set();
  }
}

function findNewFile(before: Set<string>): File | null {
  const d = cameraDir();
  if (!d.exists) return null;
  return (
    (d.list().find((f) => f instanceof File && !before.has(f.name) && /\.(mp4|mov)$/i.test(f.name)) as
      File | undefined) ?? null
  );
}

export interface LiveUpload {
  /** Dừng và chờ mảnh đang gửi kết thúc (để không ghi đè lên mảnh được gửi lại). */
  stop(): Promise<{ uploadId: string | null }>;
}

export function startLiveUpload(
  before: Set<string>,
  meta: {
    id: string;
    startedAt: number;
    facing: CameraFacing;
    recordingSessionId: string | null;
    startedAtServerMs: number | null;
  },
): LiveUpload {
  let stopping = false;
  let uploadId: string | null = null;
  liveBytes = 0;

  const run = async () => {
    let file: File | null = null;
    for (let i = 0; i < 40 && !stopping && !file; i++) {
      file = findNewFile(before);
      if (!file) await sleep(250);
    }
    if (!file) return;
    let next = 0;
    while (!stopping) {
      try {
        if (!uploadId) {
          const st = await api.initUpload({
            streaming: true,
            local_video_uid: meta.id,
            file_name: `${fileStem(meta.startedAt, meta.id)}.mp4`,
            chunk_size: LIVE_CHUNK,
            camera_facing: meta.facing,
            recording_session_id: meta.recordingSessionId,
            recorded_at_ms: meta.startedAtServerMs,
          });
          uploadId = st.upload_id;
        }
        // Chỉ gửi mảnh đã được ghi trọn vẹn
        while (!stopping && file.exists && (file.size ?? 0) >= (next + 1) * LIVE_CHUNK) {
          const bytes = await readRange(file, next * LIVE_CHUNK, LIVE_CHUNK);
          if (bytes.length !== LIVE_CHUNK) break;
          await api.uploadChunk(uploadId, next, bytes, await chunkSha256(bytes));
          next++;
          liveBytes = next * LIVE_CHUNK;
        }
        await sleep(500);
      } catch {
        await sleep(2000); // mất mạng: thử lại, clip vẫn còn nguyên trên máy
      }
    }
  };
  const done = run().catch(() => undefined);

  return {
    async stop() {
      stopping = true;
      await done;
      liveBytes = null;
      return { uploadId };
    },
  };
}
