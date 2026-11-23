import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, iso, requireRole, type Auth, type Ctx } from '../context.ts';
import { Codes, envelope, fail, ok } from '../lib/errors.ts';
import { safeEqual } from '../lib/security.ts';
import * as v from '../lib/validate.ts';

const MAX_BULK = 50;
const THUMB_TTL_SEC = 24 * 3600;

interface VideoListRow {
  id: string;
  owner_user_id: string;
  device_id: string | null;
  room_id: string | null;
  recording_session_id: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  checksum_sha256: string;
  storage_path: string;
  thumbnail_path: string | null;
  recorded_at: number | null;
  created_at: number;
  camera_name: string | null;
  device_name: string | null;
  device_type: number | null;
  owner_first_name: string;
  owner_last_name: string;
  session_started_at: number | null;
}

const SELECT = `
  SELECT v.*, d.device_name, d.device_type,
    COALESCE(
      (SELECT m.camera_name FROM room_members m WHERE m.room_id = v.room_id AND m.device_id = v.device_id
       ORDER BY m.joined_at DESC LIMIT 1),
      d.camera_name) AS camera_name,
    u.first_name AS owner_first_name, u.last_name AS owner_last_name,
    rs.started_at AS session_started_at
  FROM videos v
  JOIN users u ON u.id = v.owner_user_id
  LEFT JOIN devices d ON d.id = v.device_id
  LEFT JOIN recording_sessions rs ON rs.id = v.recording_session_id`;

// ---------- Link ký sẵn (HMAC) cho <video>, <img> và tải về — trình duyệt không gửi được header Authorization ----------

type MediaKind = 'stream' | 'download' | 'thumb';

function sign(ctx: Ctx, kind: MediaKind, id: string, uid: string, exp: number) {
  return crypto.createHmac('sha256', ctx.config.mediaSecret).update(`${kind}:${id}:${uid}:${exp}`).digest('base64url');
}

function mediaUrl(ctx: Ctx, req: FastifyRequest, kind: MediaKind, id: string, uid: string, ttlSec: number) {
  // Làm tròn hạn dùng để link ảnh thu nhỏ ổn định giữa các lần tải danh sách (trình duyệt cache được)
  const exp = Math.ceil((ctx.now() / 1000 + ttlSec) / 600) * 600;
  const sig = sign(ctx, kind, id, uid, exp);
  const path = kind === 'thumb' ? `thumbs/${id}.jpg` : `videos/${id}`;
  const host = req.host;
  return {
    url: `${req.protocol}://${host}/api/media/${path}?k=${kind}&u=${encodeURIComponent(uid)}&e=${exp}&s=${sig}`,
    expires_at: iso(exp * 1000),
  };
}

function verifyMedia(ctx: Ctx, req: FastifyRequest<{ Params: { id: string }; Querystring: Record<string, string> }>, kinds: MediaKind[]) {
  const q = req.query;
  const kind = q.k as MediaKind;
  const exp = Number(q.e);
  if (!kinds.includes(kind) || !q.u || !q.s || !Number.isFinite(exp)) return null;
  if (exp * 1000 < ctx.now()) return null;
  if (!safeEqual(sign(ctx, kind, req.params.id, q.u, exp), q.s)) return null;
  return { kind, uid: q.u };
}

// ---------- Theo dõi lượt tải đang chạy (mã 4002) ----------

const activeDownloads = new Map<string, number>();
const downloading = (uid: string) => (activeDownloads.get(uid) ?? 0) > 0;
function trackDownload(uid: string, stream: fs.ReadStream) {
  activeDownloads.set(uid, (activeDownloads.get(uid) ?? 0) + 1);
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    const n = (activeDownloads.get(uid) ?? 1) - 1;
    if (n <= 0) activeDownloads.delete(uid);
    else activeDownloads.set(uid, n);
  };
  stream.on('end', release);
  stream.on('close', release);
  stream.on('error', release);
}

/** Xóa file; Windows có thể khóa file đang được phát → thử lại sau. */
function removeFile(p: string | null, tries = 5) {
  if (!p) return;
  try {
    fs.rmSync(p, { force: true });
  } catch {
    if (tries > 0) setTimeout(() => removeFile(p, tries - 1), 3000).unref();
  }
}

/** Gửi file có hỗ trợ Range (để <video> tua được). */
function sendFile(req: FastifyRequest, reply: FastifyReply, file: string, type: string, onStream?: (s: fs.ReadStream) => void) {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return reply.code(404).send(envelope(Codes.VIDEO_NOT_FOUND));
  }
  reply.header('Accept-Ranges', 'bytes').type(type);
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  reply.header('Content-Length', end - start + 1);
  const stream = fs.createReadStream(file, { start, end });
  onStream?.(stream);
  return reply.send(stream);
}

// ---------- API ----------

export function videoRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;

  /** Controller thấy mọi video; Remote chỉ thấy video của mình. */
  const scope = (auth: Auth) => (auth.user.role === 'controller' ? { sql: '1 = 1', args: [] as string[] } : { sql: 'v.owner_user_id = ?', args: [auth.user.id] });

  const payload = (req: FastifyRequest, auth: Auth, r: VideoListRow) => ({
    video_id: r.id,
    file_name: r.file_name,
    mime_type: r.mime_type,
    size_bytes: r.size_bytes,
    duration_ms: r.duration_ms,
    checksum_sha256: r.checksum_sha256,
    room_id: r.room_id,
    recording_session_id: r.recording_session_id,
    session_started_at: r.session_started_at ? iso(r.session_started_at) : null,
    device_id: r.device_id,
    device_name: r.device_name,
    device_type: r.device_type,
    camera_name: r.camera_name,
    owner: { user_id: r.owner_user_id, name: `${r.owner_last_name} ${r.owner_first_name}`.trim() },
    recorded_at: r.recorded_at ? iso(r.recorded_at) : null,
    recorded_at_ms: r.recorded_at,
    created_at: iso(r.created_at),
    thumbnail_url: r.thumbnail_path ? mediaUrl(ctx, req, 'thumb', r.id, auth.user.id, THUMB_TTL_SEC).url : null,
  });

  function findOwned(auth: Auth, id: string) {
    const s = scope(auth);
    const r = db.prepare(`${SELECT} WHERE v.id = ? AND ${s.sql}`).get(id, ...s.args) as VideoListRow | undefined;
    return r ?? fail(Codes.VIDEO_NOT_FOUND);
  }

  // 24. get_list_videos — phân trang theo index/count, lọc theo phòng / phiên quay / thiết bị
  app.get<{ Querystring: Record<string, string> }>('/videos', async (req) => {
    const auth = authenticate(ctx, req);
    const q = req.query as v.Body;
    const index = v.optInt(q, 'index', 0, 1_000_000) ?? 0;
    const count = v.optInt(q, 'count', 1, 100) ?? 20;
    const filters: string[] = [];
    const args: (string | number)[] = [];
    const s = scope(auth);
    filters.push(s.sql);
    args.push(...s.args);
    for (const [param, col] of [
      ['room_id', 'v.room_id'],
      ['recording_session_id', 'v.recording_session_id'],
      ['device_id', 'v.device_id'],
    ] as const) {
      const val = v.optStr(q, param, { max: 40 });
      if (val) {
        filters.push(`${col} = ?`);
        args.push(val);
      }
    }
    const where = filters.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM videos v WHERE ${where}`).get(...args) as { n: number }).n;
    if (index >= total) fail(Codes.NO_DATA, undefined, { total });
    const rows = db
      .prepare(`${SELECT} WHERE ${where} ORDER BY COALESCE(v.recorded_at, v.created_at) DESC, v.created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, count, index) as unknown as VideoListRow[];
    return ok({
      videos: rows.map((r) => payload(req, auth, r)),
      total,
      index,
      count: rows.length,
      has_more: index + rows.length < total ? '1' : '0',
    });
  });

  // 25. get_video — chi tiết một video kèm link xem (stream) có hạn dùng
  app.get<{ Params: { video_id: string } }>('/videos/:video_id', async (req) => {
    const auth = authenticate(ctx, req);
    const r = findOwned(auth, req.params.video_id);
    const stream = auth.user.role === 'controller' ? mediaUrl(ctx, req, 'stream', r.id, auth.user.id, config.downloadUrlTtlSec) : null;
    return ok({ ...payload(req, auth, r), stream_url: stream?.url ?? null, stream_expires_at: stream?.expires_at ?? null });
  });

  // 26. get_download_url — chỉ Controller; đang có lượt tải chưa xong → 4002 (client xếp hàng đợi)
  app.get<{ Params: { video_id: string } }>('/videos/:video_id/download', async (req) => {
    const auth = authenticate(ctx, req);
    requireRole(auth, 'controller');
    const r = findOwned(auth, req.params.video_id);
    if (downloading(auth.user.id)) fail(Codes.DOWNLOAD_IN_PROGRESS);
    const link = mediaUrl(ctx, req, 'download', r.id, auth.user.id, config.downloadUrlTtlSec);
    return ok({ video_id: r.id, file_name: r.file_name, size_bytes: r.size_bytes, download_url: link.url, expires_at: link.expires_at });
  });

  // 27. delete_video — chỉ Controller
  app.delete<{ Params: { video_id: string } }>('/videos/:video_id', async (req) => {
    const auth = authenticate(ctx, req);
    requireRole(auth, 'controller');
    const r = findOwned(auth, req.params.video_id);
    db.prepare('DELETE FROM videos WHERE id = ?').run(r.id);
    removeFile(r.storage_path);
    removeFile(r.thumbnail_path);
    return ok({ video_id: r.id });
  });

  // 28. delete_videos_bulk — xóa nhiều clip (tối đa 50)
  app.post('/videos/bulk-delete', async (req) => {
    const auth = authenticate(ctx, req);
    requireRole(auth, 'controller');
    const b = v.asBody(req.body);
    const ids = b.video_ids;
    if (ids === undefined || ids === null) fail(Codes.PARAM_NOT_ENOUGH, 'Missing video_ids', { field: 'video_ids' });
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) fail(Codes.PARAM_TYPE_INVALID, 'video_ids must be a string array', { field: 'video_ids' });
    const list = [...new Set(ids as string[])];
    if (list.length === 0 || list.length > MAX_BULK) fail(Codes.PARAM_VALUE_INVALID, `Select 1–${MAX_BULK} videos`, { field: 'video_ids', max: MAX_BULK });
    const deleted: string[] = [];
    const notFound: string[] = [];
    for (const id of list) {
      const r = db.prepare('SELECT id, storage_path, thumbnail_path FROM videos WHERE id = ?').get(id) as
        | { id: string; storage_path: string; thumbnail_path: string | null }
        | undefined;
      if (!r) {
        notFound.push(id);
        continue;
      }
      db.prepare('DELETE FROM videos WHERE id = ?').run(id);
      removeFile(r.storage_path);
      removeFile(r.thumbnail_path);
      deleted.push(id);
    }
    if (!deleted.length) fail(Codes.VIDEO_NOT_FOUND, undefined, { not_found: notFound });
    return ok({ deleted, not_found: notFound });
  });

  // ---------- File media (link ký sẵn) ----------

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/media/videos/:id', async (req, reply) => {
    const m = verifyMedia(ctx, req, ['stream', 'download']);
    if (!m) return reply.code(403).send(envelope(Codes.NOT_ACCESS, 'Link expired or invalid'));
    const r = db.prepare('SELECT storage_path, file_name FROM videos WHERE id = ?').get(req.params.id) as
      | { storage_path: string; file_name: string }
      | undefined;
    if (!r) return reply.code(404).send(envelope(Codes.VIDEO_NOT_FOUND));
    if (m.kind === 'download') {
      const ascii = r.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
      reply.header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.file_name)}`);
    }
    reply.header('Cache-Control', 'private, max-age=600');
    return sendFile(req, reply, r.storage_path, 'video/mp4', m.kind === 'download' ? (s) => trackDownload(m.uid, s) : undefined);
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/media/thumbs/:id.jpg', async (req, reply) => {
    const m = verifyMedia(ctx, req, ['thumb']);
    if (!m) return reply.code(403).send(envelope(Codes.NOT_ACCESS, 'Link expired or invalid'));
    const r = db.prepare('SELECT thumbnail_path FROM videos WHERE id = ?').get(req.params.id) as { thumbnail_path: string | null } | undefined;
    if (!r?.thumbnail_path) return reply.code(404).send(envelope(Codes.VIDEO_NOT_FOUND));
    reply.header('Cache-Control', 'private, max-age=3600');
    return sendFile(req, reply, r.thumbnail_path, 'image/jpeg');
  });
}
