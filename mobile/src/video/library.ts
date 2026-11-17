import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { detectContainer, patchFtypToMp4, type CameraFacing } from '@multicam/shared';

/** Clip đã quay, lưu trong thư mục riêng của ứng dụng (không vào thư viện ảnh của máy). */
export interface LocalClip {
  /** local_video_uid — dùng để chống upload trùng */
  id: string;
  file_name: string;
  uri: string;
  thumbnail_uri: string | null;
  size_bytes: number;
  duration_ms: number;
  created_at: number;
  camera_facing: CameraFacing;
  room_id: string | null;
  container: 'mp4' | 'mov';
  uploaded: boolean;
}

const dir = () => new Directory(Paths.document, 'videos');
const indexFile = () => new File(dir(), 'index.json');

function ensureDir() {
  const d = dir();
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
}

let cache: LocalClip[] | null = null;
const listeners = new Set<(clips: LocalClip[]) => void>();

async function readIndex(): Promise<LocalClip[]> {
  if (cache) return cache;
  ensureDir();
  const f = indexFile();
  try {
    cache = f.exists ? (JSON.parse(await f.text()) as LocalClip[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function writeIndex(clips: LocalClip[]) {
  cache = clips;
  ensureDir();
  const f = indexFile();
  if (!f.exists) f.create();
  f.write(JSON.stringify(clips));
  listeners.forEach((fn) => fn(clips));
}

export function subscribeClips(fn: (clips: LocalClip[]) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function listClips(): Promise<LocalClip[]> {
  const clips = await readIndex();
  // Bỏ các mục mà file đã mất
  const alive = clips.filter((c) => new File(c.uri).exists);
  if (alive.length !== clips.length) writeIndex(alive);
  return [...alive].sort((a, b) => b.created_at - a.created_at);
}

const pad = (n: number) => String(n).padStart(2, '0');
function fileStem(ms: number, seq: number) {
  const d = new Date(ms);
  return `VID_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${String(seq).padStart(3, '0')}`;
}

/**
 * Chuẩn hóa sang MP4: Android đã ghi sẵn MP4; iPhone ghi QuickTime (H.264 + AAC) nên đổi brand
 * trong hộp ftyp tại chỗ. Không nén lại hình nên không mất chất lượng.
 */
function normalizeToMp4(file: File): 'mp4' | 'mov' {
  const handle = file.open();
  try {
    const head = handle.readBytesSync(64);
    const kind = detectContainer(head);
    if (kind === 'mp4') return 'mp4';
    const patched = patchFtypToMp4(head);
    if (!patched) return 'mov';
    handle.offset = 0;
    handle.writeBytesSync(patched);
    return 'mp4';
  } finally {
    handle.close();
  }
}

/** Lưu file vừa quay (trong cache của camera) vào thư viện của ứng dụng. */
export async function saveRecording(
  tmpUri: string,
  meta: { startedAt: number; durationMs: number; facing: CameraFacing; roomId: string | null },
): Promise<LocalClip> {
  ensureDir();
  const clips = await readIndex();
  const src = new File(tmpUri);
  const container = normalizeToMp4(src);
  const name = `${fileStem(meta.startedAt, clips.length + 1)}.${container}`;
  const dest = new File(dir(), name);
  src.move(dest);

  let thumbnail_uri: string | null = null;
  try {
    const t = await VideoThumbnails.getThumbnailAsync(dest.uri, { time: 500, quality: 0.6 });
    const thumb = new File(t.uri);
    const thumbDest = new File(dir(), name.replace(/\.\w+$/, '.jpg'));
    thumb.move(thumbDest);
    thumbnail_uri = thumbDest.uri;
  } catch {
    /* không có ảnh thu nhỏ cũng không sao */
  }

  const clip: LocalClip = {
    id: Crypto.randomUUID(),
    file_name: name,
    uri: dest.uri,
    thumbnail_uri,
    size_bytes: dest.size ?? 0,
    duration_ms: meta.durationMs,
    created_at: meta.startedAt,
    camera_facing: meta.facing,
    room_id: meta.roomId,
    container,
    uploaded: false,
  };
  writeIndex([...clips, clip]);
  return clip;
}

export async function deleteClips(ids: string[]) {
  const clips = await readIndex();
  for (const c of clips.filter((x) => ids.includes(x.id))) {
    for (const uri of [c.uri, c.thumbnail_uri]) {
      if (!uri) continue;
      const f = new File(uri);
      if (f.exists) f.delete();
    }
  }
  writeIndex(clips.filter((x) => !ids.includes(x.id)));
}

export const formatBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

export function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${pad(h)}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
