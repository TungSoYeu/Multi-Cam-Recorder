import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { detectContainer, patchFtypToMp4, type CameraFacing } from '@multicam/shared';
import { api } from '../api';

/** Clip đã quay, lưu trong thư mục riêng của ứng dụng (không vào thư viện ảnh của máy). */
export interface LocalClip {
  /** local_video_uid — cùng checksum dùng để chống upload trùng */
  id: string;
  /** Tài khoản đã quay clip này: tài khoản khác trên cùng máy không thấy và không upload hộ */
  owner_user_id: string;
  file_name: string;
  has_thumbnail: boolean;
  size_bytes: number;
  duration_ms: number;
  created_at: number;
  camera_facing: CameraFacing;
  room_id: string | null;
  /** Phiên quay đồng bộ của phòng (null nếu quay độc lập) — để ghép các góc quay cùng buổi */
  recording_session_id: string | null;
  /** Thời điểm bắt đầu thực tế theo giờ server — để căn khớp các clip */
  started_at_server_ms: number | null;
  container: 'mp4' | 'mov';
  uploaded: boolean;
  /** SHA-256 toàn file (tính một lần trước khi hoàn tất upload) */
  checksum_sha256?: string;
  /** Phiên upload đang dở — để resume */
  upload_id?: string | null;
  /** upload_id được mở ngay từ lúc quay */
  streaming?: boolean;
  /** ID video trên server sau khi upload xong */
  video_id?: string | null;
  /** Lỗi không tự thử lại được (vd: vượt 1 GB) */
  upload_error?: string | null;
}

const dir = () => new Directory(Paths.document, 'videos');
const indexFile = () => new File(dir(), 'index.json');
// Đường dẫn tuyệt đối có thể đổi khi iOS cập nhật ứng dụng → luôn suy ra từ tên file
export const clipFile = (c: LocalClip) => new File(dir(), c.file_name);
export const thumbFile = (c: LocalClip) => new File(dir(), c.file_name.replace(/\.\w+$/, '.jpg'));

function ensureDir() {
  const d = dir();
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
}

let cache: LocalClip[] | null = null;
let loading: Promise<LocalClip[]> | null = null;
/** Các lần ghi index xếp hàng để không ghi chồng lên nhau */
let writing: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

async function readIndex(): Promise<LocalClip[]> {
  if (cache) return cache;
  loading ??= (async () => {
    ensureDir();
    const f = indexFile();
    try {
      cache = f.exists ? (JSON.parse(await f.text()) as LocalClip[]) : [];
    } catch {
      cache = [];
    }
    return cache;
  })();
  return loading;
}

async function writeIndex(clips: LocalClip[]) {
  cache = clips;
  listeners.forEach((fn) => fn());
  const json = JSON.stringify(clips);
  writing = writing
    .catch(() => undefined)
    .then(async () => {
      ensureDir();
      const f = indexFile();
      if (!f.exists) f.create();
      await f.write(json);
    });
  await writing;
}

export function subscribeClips(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const currentUser = async () => (await api.getSession())?.user.id ?? null;

/** Clip của tài khoản đang đăng nhập, mới nhất trước. */
export async function listClips(): Promise<LocalClip[]> {
  const me = await currentUser();
  const clips = await readIndex();
  return clips.filter((c) => c.owner_user_id === me && clipFile(c).exists).sort((a, b) => b.created_at - a.created_at);
}

const pad = (n: number) => String(n).padStart(2, '0');
export function fileStem(ms: number, uid: string) {
  const d = new Date(ms);
  return `VID_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${uid.slice(0, 4)}`;
}

/**
 * Chuẩn hóa sang MP4: Android đã ghi sẵn MP4; iPhone ghi QuickTime (H.264 + AAC) nên đổi brand
 * trong hộp ftyp tại chỗ. Không nén lại hình nên không mất chất lượng.
 */
function normalizeToMp4(file: File): 'mp4' | 'mov' {
  const handle = file.open(FileMode.ReadWrite);
  try {
    const head = handle.readBytesSync(64);
    if (detectContainer(head) === 'mp4') return 'mp4';
    const patched = patchFtypToMp4(head);
    if (!patched) return 'mov';
    handle.offset = 0;
    handle.writeBytesSync(patched);
    return 'mp4';
  } finally {
    handle.close();
  }
}

export interface RecordingMeta {
  id: string;
  startedAt: number;
  durationMs: number;
  facing: CameraFacing;
  roomId: string | null;
  recordingSessionId: string | null;
  startedAtServerMs: number | null;
  /** Phiên upload đã mở trong lúc quay (nếu có) */
  liveUploadId: string | null;
}

/** Lưu file vừa quay (trong cache của camera) vào thư viện của ứng dụng. */
export async function saveRecording(tmpUri: string, meta: RecordingMeta): Promise<LocalClip> {
  const owner = await currentUser();
  if (!owner) throw new Error('Chưa đăng nhập');
  ensureDir();
  const src = new File(tmpUri);
  const container = normalizeToMp4(src);
  const file_name = `${fileStem(meta.startedAt, meta.id)}.${container}`;
  // SDK 58: move() bất đồng bộ — phải chờ xong mới đọc kích thước / tạo ảnh thu nhỏ
  await src.move(new File(dir(), file_name));

  const clip: LocalClip = {
    id: meta.id,
    owner_user_id: owner,
    file_name,
    has_thumbnail: false,
    size_bytes: new File(dir(), file_name).size ?? 0,
    duration_ms: meta.durationMs,
    created_at: meta.startedAt,
    camera_facing: meta.facing,
    room_id: meta.roomId,
    recording_session_id: meta.recordingSessionId,
    started_at_server_ms: meta.startedAtServerMs,
    container,
    uploaded: false,
    upload_id: meta.liveUploadId,
    streaming: !!meta.liveUploadId,
  };
  // Ghi index TRƯỚC khi làm ảnh thu nhỏ: app bị tắt giữa chừng cũng không mất clip
  await writeIndex([...(await readIndex()), clip]);
  try {
    const t = await VideoThumbnails.getThumbnailAsync(clipFile(clip).uri, { time: 500, quality: 0.6 });
    await new File(t.uri).move(thumbFile(clip));
    await updateClip(clip.id, { has_thumbnail: true });
  } catch {
    /* không có ảnh thu nhỏ cũng không sao */
  }
  return (await getClip(clip.id)) ?? clip;
}

export async function getClip(id: string): Promise<LocalClip | undefined> {
  return (await readIndex()).find((c) => c.id === id);
}

/** Cập nhật metadata của một clip (trạng thái upload) và lưu xuống đĩa. */
export async function updateClip(id: string, patch: Partial<LocalClip>) {
  await readIndex();
  await writeIndex(cache!.map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

export async function deleteClips(ids: string[]) {
  const clips = await readIndex();
  for (const c of clips.filter((x) => ids.includes(x.id)))
    for (const f of [clipFile(c), thumbFile(c)]) if (f.exists) f.delete();
  await writeIndex(cache!.filter((x) => !ids.includes(x.id)));
}

export const newClipId = () => Crypto.randomUUID();

export const formatBytes = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`
      : `${Math.max(1, Math.round(n / 1e3))} KB`;

export function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${pad(h)}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
