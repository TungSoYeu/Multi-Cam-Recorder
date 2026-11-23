import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { authenticate, iso, type Auth, type Ctx } from '../context.ts';
import { tx } from '../db/database.ts';
import { ApiError, Codes, fail, ok } from '../lib/errors.ts';
import { ffmpegAvailable, makeThumbnail, remuxToMp4 } from '../lib/media.ts';
import { newId } from '../lib/security.ts';
import * as v from '../lib/validate.ts';

const SHA256_RE = /^[a-f0-9]{64}$/;
const UPLOAD_ID_RE = /^up_[a-z0-9]{10}$/;

interface UploadRow {
  id: string;
  user_id: string;
  device_id: string;
  local_video_uid: string;
  file_name: string;
  total_size: number;
  chunk_size: number;
  total_chunks: number;
  checksum_sha256: string;
  status: 'uploading' | 'completed' | 'aborted';
  video_id: string | null;
  expires_at: number;
  created_at: number;
  meta: string | null;
}

interface UploadMeta {
  duration_ms: number | null;
  recording_session_id: string | null;
  room_id: string | null;
  camera_facing: 'front' | 'back' | null;
  recorded_at_ms: number | null;
  mime_type: string;
  /** Upload ngay trong lúc quay: chưa biết kích thước/checksum cho tới khi complete_upload */
  streaming?: boolean;
}

const metaOf = (u: UploadRow) => (u.meta ? JSON.parse(u.meta) : {}) as Partial<UploadMeta>;
/** Phiên streaming chưa "chốt" (chưa biết tổng kích thước) */
const isOpenStream = (u: UploadRow) => u.total_chunks === 0 && !!metaOf(u).streaming;

interface VideoRow {
  id: string;
  owner_user_id: string;
  device_id: string | null;
  room_id: string | null;
  recording_session_id: string | null;
  local_video_uid: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  checksum_sha256: string;
  storage_path: string;
  thumbnail_path: string | null;
  recorded_at: number | null;
  created_at: number;
}

export const videoPayload = (vd: VideoRow) => ({
  video_id: vd.id,
  file_name: vd.file_name,
  mime_type: vd.mime_type,
  size_bytes: vd.size_bytes,
  duration_ms: vd.duration_ms,
  checksum_sha256: vd.checksum_sha256,
  room_id: vd.room_id,
  recording_session_id: vd.recording_session_id,
  device_id: vd.device_id,
  owner_user_id: vd.owner_user_id,
  has_thumbnail: vd.thumbnail_path ? '1' : '0',
  recorded_at: vd.recorded_at ? iso(vd.recorded_at) : null,
  created_at: iso(vd.created_at),
});

const partsDir = (ctx: Ctx, uploadId: string) => path.join(ctx.config.uploadDir, uploadId);
const partFile = (ctx: Ctx, uploadId: string, index: number) => path.join(partsDir(ctx, uploadId), `${index}.part`);

function receivedIndexes(ctx: Ctx, uploadId: string): number[] {
  return (ctx.db.prepare('SELECT chunk_index FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index').all(uploadId) as {
    chunk_index: number;
  }[]).map((r) => r.chunk_index);
}

function statusPayload(ctx: Ctx, u: UploadRow) {
  const rows = ctx.db.prepare('SELECT chunk_index, checksum_sha256 FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index').all(u.id) as {
    chunk_index: number;
    checksum_sha256: string;
  }[];
  const got = new Set(rows.map((r) => r.chunk_index));
  const missing: number[] = [];
  for (let i = 0; i < u.total_chunks; i++) if (!got.has(i)) missing.push(i);
  return {
    upload_id: u.id,
    streaming: metaOf(u).streaming ? '1' : '0',
    // SHA-256 các mảnh server đang giữ: client so với file cuối cùng để chỉ gửi lại mảnh khác
    chunk_hashes: Object.fromEntries(rows.map((r) => [String(r.chunk_index), r.checksum_sha256])),
    status: u.status,
    total_size: u.total_size,
    chunk_size: u.chunk_size,
    total_chunks: u.total_chunks,
    received_count: got.size,
    missing_chunks: missing,
    expires_at: iso(u.expires_at),
    video_id: u.video_id,
  };
}

/** Phiên upload của đúng người dùng, còn hạn. Không lộ phiên của người khác (→ 3001). */
function ownedUpload(ctx: Ctx, auth: Auth, uploadId: string, allowFinished = false): UploadRow {
  const u = UPLOAD_ID_RE.test(uploadId)
    ? (ctx.db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(uploadId) as UploadRow | undefined)
    : undefined;
  if (!u || u.user_id !== auth.user.id) return fail(Codes.UPLOAD_SESSION_NOT_FOUND);
  if (u.status === 'aborted') return fail(Codes.UPLOAD_SESSION_NOT_FOUND);
  if (u.status === 'completed') return allowFinished ? u : fail(Codes.UPLOAD_SESSION_NOT_FOUND, 'Upload already completed', { video_id: u.video_id });
  if (u.expires_at <= ctx.now()) return fail(Codes.UPLOAD_SESSION_NOT_FOUND, 'Upload session expired');
  return u;
}

const safeFileName = (s: string) =>
  s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video.mp4';

function usedBytes(ctx: Ctx, userId: string, excludeUpload?: string) {
  const videos = (ctx.db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM videos WHERE owner_user_id = ?').get(userId) as { n: number }).n;
  const pending = (
    ctx.db
      .prepare(
        // Phiên streaming chưa biết tổng kích thước → tính theo số byte đã nhận
        `SELECT COALESCE(SUM(CASE WHEN total_size > 0 THEN total_size ELSE
           (SELECT COALESCE(SUM(c.size_bytes), 0) FROM upload_chunks c WHERE c.upload_id = upload_sessions.id) END), 0) AS n
         FROM upload_sessions WHERE user_id = ? AND status = 'uploading' AND expires_at > ? AND id <> ?`,
      )
      .get(userId, ctx.now(), excludeUpload ?? '') as { n: number }
  ).n;
  return videos + pending;
}


/** Hủy phiên upload quá hạn và xóa mảnh tạm. Gọi định kỳ. */
export function cleanupExpiredUploads(ctx: Ctx) {
  const rows = ctx.db
    .prepare(`SELECT id FROM upload_sessions WHERE status = 'uploading' AND expires_at <= ?`)
    .all(ctx.now()) as { id: string }[];
  for (const r of rows) {
    ctx.db.prepare(`UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE id = ?`).run(ctx.now(), r.id);
    fs.rmSync(partsDir(ctx, r.id), { recursive: true, force: true });
  }
  return rows.length;
}

const completing = new Map<string, Promise<unknown>>();

export function uploadRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;

  // Body nhị phân cho upload_chunk
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: config.maxChunkBytes + 1024 }, (_req, body, done) =>
    done(null, body),
  );

  // 20. init_upload — mở phiên upload (hoặc tiếp tục phiên cũ cùng clip)
  app.post('/videos/uploads', async (req) => {
    const auth = authenticate(ctx, req);
    if (!auth.device) fail(Codes.NOT_ACCESS, 'Session has no device');
    const b = v.asBody(req.body);
    const localUid = v.str(b, 'local_video_uid', { max: 64 });
    const fileName = safeFileName(v.str(b, 'file_name', { max: 200 }));
    // streaming = upload ngay trong lúc quay: chưa có total_size / checksum, sẽ gửi ở complete_upload
    const streaming = b.streaming === undefined ? false : v.bool(b, 'streaming');
    const totalSize = streaming ? 0 : v.int(b, 'total_size', 1, Number.MAX_SAFE_INTEGER);
    const checksum = streaming ? '' : sha256Param(b);
    const chunkSize = v.optInt(b, 'chunk_size', config.minChunkBytes, config.maxChunkBytes) ?? config.defaultChunkBytes;
    const durationMs = v.optInt(b, 'duration_ms', 0, 24 * 3600 * 1000) ?? null;
    const recordedAt = v.optInt(b, 'recorded_at_ms', 0, Number.MAX_SAFE_INTEGER) ?? null;
    const facing = v.optStr(b, 'camera_facing', { max: 5 }) ?? null;
    if (facing && facing !== 'front' && facing !== 'back') fail(Codes.PARAM_VALUE_INVALID, 'Invalid camera_facing', { field: 'camera_facing' });
    const mime = v.optStr(b, 'mime_type', { max: 40 }) ?? 'video/mp4';
    if (!/^video\/(mp4|quicktime)$/.test(mime)) fail(Codes.PARAM_VALUE_INVALID, 'Invalid mime_type', { field: 'mime_type' });
    if (totalSize > config.maxVideoBytes) fail(Codes.FILE_TOO_BIG, undefined, { max_bytes: config.maxVideoBytes });

    // Phiên quay đồng bộ: phải là phòng mà thiết bị này từng tham gia
    const sessionId = v.optStr(b, 'recording_session_id', { max: 40 }) ?? null;
    let roomId: string | null = null;
    if (sessionId) {
      const rs = db
        .prepare(
          `SELECT rs.room_id FROM recording_sessions rs
           WHERE rs.id = ? AND EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = rs.room_id AND m.device_id = ?)`,
        )
        .get(sessionId, auth.device!.id) as { room_id: string } | undefined;
      if (!rs) fail(Codes.PARAM_VALUE_INVALID, 'Invalid recording_session_id', { field: 'recording_session_id' });
      roomId = rs!.room_id;
    }

    const result = tx(db, () => {
      const now = ctx.now();
      const existing = db
        .prepare('SELECT id FROM videos WHERE local_video_uid = ? AND checksum_sha256 = ? AND owner_user_id = ?')
        .get(localUid, checksum, auth.user.id) as { id: string } | undefined;
      if (existing) throw new ApiError(Codes.VIDEO_ALREADY_UPLOADED, undefined, { video_id: existing.id, already_uploaded: '1' });

      const resume = db
        .prepare(
          `SELECT * FROM upload_sessions WHERE user_id = ? AND local_video_uid = ? AND checksum_sha256 = ?
           AND status = 'uploading' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(auth.user.id, localUid, checksum, now) as UploadRow | undefined;
      if (resume) return resume;

      const quota = (db.prepare('SELECT storage_quota_bytes AS q FROM users WHERE id = ?').get(auth.user.id) as { q: number }).q;
      if (usedBytes(ctx, auth.user.id) + totalSize > quota) fail(Codes.STORAGE_QUOTA_EXCEEDED, undefined, { quota_bytes: quota });

      const meta: UploadMeta = { streaming, duration_ms: durationMs, recording_session_id: sessionId, room_id: roomId, camera_facing: facing as UploadMeta['camera_facing'], recorded_at_ms: recordedAt, mime_type: mime };
      const row: UploadRow = {
        id: newId('up', 10),
        user_id: auth.user.id,
        device_id: auth.device!.id,
        local_video_uid: localUid,
        file_name: fileName,
        total_size: totalSize,
        chunk_size: chunkSize,
        total_chunks: streaming ? 0 : Math.ceil(totalSize / chunkSize),
        checksum_sha256: checksum,
        status: 'uploading',
        video_id: null,
        expires_at: now + config.uploadTtlSec * 1000,
        created_at: now,
        meta: JSON.stringify(meta),
      };
      db.prepare(
        `INSERT INTO upload_sessions (id, user_id, device_id, local_video_uid, file_name, total_size, chunk_size, total_chunks,
           checksum_sha256, status, expires_at, created_at, updated_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?)`,
      ).run(row.id, row.user_id, row.device_id, row.local_video_uid, row.file_name, row.total_size, row.chunk_size, row.total_chunks, row.checksum_sha256, row.expires_at, now, now, row.meta);
      return row;
    });
    return ok(statusPayload(ctx, result));
  });

  // 21. upload_chunk — gửi một mảnh nhị phân, header X-Chunk-Sha256 là SHA-256 của mảnh
  app.put<{ Params: { upload_id: string; index: string } }>(
    '/videos/uploads/:upload_id/chunks/:index',
    { bodyLimit: config.maxChunkBytes + 1024 },
    async (req) => {
      const auth = authenticate(ctx, req);
      const u = ownedUpload(ctx, auth, req.params.upload_id);
      if (!/^\d+$/.test(req.params.index)) fail(Codes.PARAM_TYPE_INVALID, 'Invalid chunk index', { field: 'index' });
      const index = Number(req.params.index);
      const body = req.body;
      const open = isOpenStream(u);
      if (!open && index >= u.total_chunks) fail(Codes.PARAM_VALUE_INVALID, 'Chunk index out of range', { field: 'index' });
      if (!Buffer.isBuffer(body)) return fail(Codes.PARAM_TYPE_INVALID, 'Body must be application/octet-stream');
      if (open) {
        if (body.length === 0 || body.length > u.chunk_size) fail(Codes.PARAM_VALUE_INVALID, 'Invalid chunk size', { field: 'body' });
        if (index * u.chunk_size + body.length > config.maxVideoBytes) fail(Codes.FILE_TOO_BIG, undefined, { max_bytes: config.maxVideoBytes });
        const quota = (db.prepare('SELECT storage_quota_bytes AS q FROM users WHERE id = ?').get(auth.user.id) as { q: number }).q;
        if (usedBytes(ctx, auth.user.id) + body.length > quota) fail(Codes.STORAGE_QUOTA_EXCEEDED, undefined, { quota_bytes: quota });
      } else {
        const expected = chunkSizeAt(u, index);
        if (body.length !== expected) fail(Codes.PARAM_VALUE_INVALID, 'Invalid chunk size', { field: 'body', expected_size: expected });
      }
      const header = String(req.headers['x-chunk-sha256'] ?? '').toLowerCase();
      if (!header) fail(Codes.PARAM_NOT_ENOUGH, 'Missing X-Chunk-Sha256 header', { field: 'x-chunk-sha256' });
      const actual = crypto.createHash('sha256').update(body).digest('hex');
      if (actual !== header) fail(Codes.CHECKSUM_MISMATCH, 'Chunk checksum mismatch', { index });

      try {
        await fsp.mkdir(partsDir(ctx, u.id), { recursive: true });
        const tmp = `${partFile(ctx, u.id, index)}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, body);
        await fsp.rename(tmp, partFile(ctx, u.id, index));
      } catch (e) {
        req.log.error(e);
        return fail(Codes.UPLOAD_FAILED);
      }
      const now = ctx.now();
      db.prepare(
        `INSERT INTO upload_chunks (upload_id, chunk_index, size_bytes, checksum_sha256, received_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (upload_id, chunk_index) DO UPDATE SET size_bytes = excluded.size_bytes,
           checksum_sha256 = excluded.checksum_sha256, received_at = excluded.received_at`,
      ).run(u.id, index, body.length, actual, now);
      // Còn hoạt động thì gia hạn phiên
      db.prepare('UPDATE upload_sessions SET expires_at = ?, updated_at = ? WHERE id = ?').run(now + config.uploadTtlSec * 1000, now, u.id);
      const received = (db.prepare('SELECT COUNT(*) AS n FROM upload_chunks WHERE upload_id = ?').get(u.id) as { n: number }).n;
      return ok({ upload_id: u.id, index, received_count: received, total_chunks: u.total_chunks });
    },
  );

  // 22. get_upload_status — mảnh nào còn thiếu (để resume)
  app.get<{ Params: { upload_id: string } }>('/videos/uploads/:upload_id', async (req) => {
    const auth = authenticate(ctx, req);
    return ok(statusPayload(ctx, ownedUpload(ctx, auth, req.params.upload_id, true)));
  });

  // 23. complete_upload — ghép mảnh, kiểm tra SHA-256 toàn file, remux MP4, tạo bản ghi video
  app.post<{ Params: { upload_id: string } }>('/videos/uploads/:upload_id/complete', async (req) => {
    const auth = authenticate(ctx, req);
    const u = ownedUpload(ctx, auth, req.params.upload_id, true);
    if (u.status === 'completed' && u.video_id) {
      const vd = db.prepare('SELECT * FROM videos WHERE id = ?').get(u.video_id) as VideoRow | undefined;
      if (vd) return ok(videoPayload(vd));
    }
    const b = v.asBody(req.body);
    const thumbB64 = v.optStr(b, 'thumbnail_base64', { max: 400_000 });
    const sealed = completing.has(u.id) ? u : sealStream(ctx, u, b);

    // Hai lệnh complete cùng lúc dùng chung một kết quả
    let job = completing.get(u.id);
    if (!job) {
      job = finish(ctx, sealed, thumbB64).finally(() => completing.delete(u.id));
      completing.set(u.id, job);
    }
    return ok(await job);
  });
}

/** Kích thước đúng của một mảnh khi đã biết tổng kích thước */
const chunkSizeAt = (u: UploadRow, index: number) =>
  index === u.total_chunks - 1 ? u.total_size - u.chunk_size * (u.total_chunks - 1) : u.chunk_size;

function sha256Param(b: v.Body): string {
  const checksum = v.str(b, 'checksum_sha256', { min: 64, max: 64 }).toLowerCase();
  if (!SHA256_RE.test(checksum)) fail(Codes.PARAM_VALUE_INVALID, 'Invalid checksum_sha256', { field: 'checksum_sha256' });
  return checksum;
}

/**
 * "Chốt" phiên streaming: client dừng quay, gửi tổng kích thước và SHA-256 toàn file.
 * Mảnh nằm ngoài file hoặc sai kích thước bị bỏ để client gửi lại (3002).
 */
function sealStream(ctx: Ctx, u: UploadRow, b: v.Body): UploadRow {
  if (!isOpenStream(u)) return u;
  const { db, config } = ctx;
  const totalSize = v.int(b, 'total_size', 1, Number.MAX_SAFE_INTEGER);
  const checksum = sha256Param(b);
  if (totalSize > config.maxVideoBytes) fail(Codes.FILE_TOO_BIG, undefined, { max_bytes: config.maxVideoBytes });
  const durationMs = v.optInt(b, 'duration_ms', 0, 24 * 3600 * 1000) ?? null;

  const dup = db
    .prepare('SELECT id FROM videos WHERE local_video_uid = ? AND checksum_sha256 = ? AND owner_user_id = ?')
    .get(u.local_video_uid, checksum, u.user_id) as { id: string } | undefined;
  if (dup) {
    db.prepare(`UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE id = ?`).run(ctx.now(), u.id);
    fs.rmSync(partsDir(ctx, u.id), { recursive: true, force: true });
    throw new ApiError(Codes.VIDEO_ALREADY_UPLOADED, undefined, { video_id: dup.id, already_uploaded: '1' });
  }
  const quota = (db.prepare('SELECT storage_quota_bytes AS q FROM users WHERE id = ?').get(u.user_id) as { q: number }).q;
  if (usedBytes(ctx, u.user_id, u.id) + totalSize > quota) fail(Codes.STORAGE_QUOTA_EXCEEDED, undefined, { quota_bytes: quota });

  const row: UploadRow = {
    ...u,
    total_size: totalSize,
    total_chunks: Math.ceil(totalSize / u.chunk_size),
    checksum_sha256: checksum,
    meta: JSON.stringify({ ...metaOf(u), duration_ms: durationMs }),
  };
  tx(db, () => {
    db.prepare('UPDATE upload_sessions SET total_size = ?, total_chunks = ?, checksum_sha256 = ?, meta = ?, updated_at = ? WHERE id = ?').run(
      row.total_size,
      row.total_chunks,
      row.checksum_sha256,
      row.meta,
      ctx.now(),
      u.id,
    );
    const chunks = db.prepare('SELECT chunk_index, size_bytes FROM upload_chunks WHERE upload_id = ?').all(u.id) as { chunk_index: number; size_bytes: number }[];
    for (const c of chunks)
      if (c.chunk_index >= row.total_chunks || c.size_bytes !== chunkSizeAt(row, c.chunk_index))
        db.prepare('DELETE FROM upload_chunks WHERE upload_id = ? AND chunk_index = ?').run(u.id, c.chunk_index);
  });
  return row;
}

async function finish(ctx: Ctx, u: UploadRow, thumbB64: string | undefined) {
  const { db, config } = ctx;
  const got = new Set(receivedIndexes(ctx, u.id));
  const missing: number[] = [];
  for (let i = 0; i < u.total_chunks; i++) if (!got.has(i) || !fs.existsSync(partFile(ctx, u.id, i))) missing.push(i);
  if (missing.length) {
    // Mảnh có trong DB nhưng mất file → xóa bản ghi để client gửi lại
    for (const i of missing) db.prepare('DELETE FROM upload_chunks WHERE upload_id = ? AND chunk_index = ?').run(u.id, i);
    fail(Codes.MISSING_CHUNKS, undefined, { missing_chunks: missing });
  }

  const meta = metaOf(u);
  const videoId = newId('vd', 10);
  await fsp.mkdir(config.videoDir, { recursive: true });
  const assembled = path.join(partsDir(ctx, u.id), 'assembled.bin');
  const hash = crypto.createHash('sha256');
  try {
    const out = fs.createWriteStream(assembled);
    for (let i = 0; i < u.total_chunks; i++) {
      for await (const chunk of fs.createReadStream(partFile(ctx, u.id, i))) {
        hash.update(chunk as Buffer);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch {
    fail(Codes.UPLOAD_FAILED);
  }

  if (hash.digest('hex') !== u.checksum_sha256) {
    // Sai ở toàn file → hủy phiên, client mở phiên mới (theo bảng mã 3003)
    db.prepare(`UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE id = ?`).run(ctx.now(), u.id);
    fs.rmSync(partsDir(ctx, u.id), { recursive: true, force: true });
    fail(Codes.CHECKSUM_MISMATCH, 'File checksum mismatch', { scope: 'file' });
  }

  const finalPath = path.join(config.videoDir, `${videoId}.mp4`);
  const thumbPath = path.join(config.videoDir, `${videoId}.jpg`);
  let thumbnail: string | null = null;
  const ff = config.ffmpegPath;
  if (ffmpegAvailable(ff) && (await remuxToMp4(ff, assembled, finalPath))) {
    fs.rmSync(assembled, { force: true });
  } else {
    fs.rmSync(finalPath, { force: true });
    await fsp.rename(assembled, finalPath);
  }
  if (thumbB64) {
    try {
      const buf = Buffer.from(thumbB64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      if (buf.length > 100 && buf[0] === 0xff && buf[1] === 0xd8) {
        await fsp.writeFile(thumbPath, buf);
        thumbnail = thumbPath;
      }
    } catch {
      /* ảnh thu nhỏ không bắt buộc */
    }
  }
  if (!thumbnail && ffmpegAvailable(ff) && (await makeThumbnail(ff, finalPath, thumbPath))) thumbnail = thumbPath;

  const size = fs.statSync(finalPath).size;
  const now = ctx.now();
  const name = u.file_name.replace(/\.(mov|qt)$/i, '.mp4');
  const row: VideoRow = {
    id: videoId,
    owner_user_id: u.user_id,
    device_id: u.device_id,
    room_id: meta.room_id ?? null,
    recording_session_id: meta.recording_session_id ?? null,
    local_video_uid: u.local_video_uid,
    file_name: name,
    mime_type: 'video/mp4',
    size_bytes: size,
    duration_ms: meta.duration_ms ?? null,
    checksum_sha256: u.checksum_sha256,
    storage_path: finalPath,
    thumbnail_path: thumbnail,
    recorded_at: meta.recorded_at_ms ?? null,
    created_at: now,
  };
  const dup = tx(db, () => {
    // Hai phiên khác nhau của cùng một clip hoàn tất gần như cùng lúc → giữ video đã có
    const existing = db
      .prepare('SELECT * FROM videos WHERE local_video_uid = ? AND checksum_sha256 = ?')
      .get(u.local_video_uid, u.checksum_sha256) as VideoRow | undefined;
    if (existing) {
      db.prepare(`UPDATE upload_sessions SET status = 'completed', video_id = ?, updated_at = ? WHERE id = ?`).run(existing.id, now, u.id);
      return existing;
    }
    db.prepare(
      `INSERT INTO videos (id, owner_user_id, device_id, room_id, recording_session_id, local_video_uid, file_name, mime_type,
         size_bytes, duration_ms, checksum_sha256, storage_path, thumbnail_path, recorded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.owner_user_id, row.device_id, row.room_id, row.recording_session_id, row.local_video_uid, row.file_name, row.mime_type, row.size_bytes, row.duration_ms, row.checksum_sha256, row.storage_path, row.thumbnail_path, row.recorded_at, row.created_at);
    db.prepare(`UPDATE upload_sessions SET status = 'completed', video_id = ?, updated_at = ? WHERE id = ?`).run(videoId, now, u.id);
    return null;
  });
  fs.rmSync(partsDir(ctx, u.id), { recursive: true, force: true });
  if (dup) {
    for (const p of [finalPath, thumbnail]) if (p) fs.rmSync(p, { force: true });
    return videoPayload(dup);
  }
  return videoPayload(row);
}
