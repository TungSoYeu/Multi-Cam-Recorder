import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupExpiredUploads } from '../src/modules/uploads.ts';
import { setup } from './helpers.ts';

const CHUNK = 256 * 1024;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
/** Video giả 2,5 mảnh (đầu file là hộp ftyp MP4) */
function fakeVideo(size = CHUNK * 2 + 1000) {
  const b = crypto.randomBytes(size);
  Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]).copy(b, 0);
  return b;
}

async function uploader() {
  const t = await setup();
  const r = await t.remote();
  const put = async (uploadId: string, index: number, body: Buffer, hash = sha(body), token = r.token) => {
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/videos/uploads/${uploadId}/chunks/${index}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', ...(hash ? { 'x-chunk-sha256': hash } : {}) },
      payload: body,
    });
    return res.json();
  };
  const init = (file: Buffer, extra: Record<string, unknown> = {}, token = r.token) =>
    t.call('POST', '/videos/uploads', { local_video_uid: 'clip-1', file_name: 'VID_20261117_101500_001.mp4', total_size: file.length, checksum_sha256: sha(file), duration_ms: 8000, ...extra }, token);
  const sendAll = async (uploadId: string, file: Buffer, skip: number[] = []) => {
    for (let i = 0; i * CHUNK < file.length; i++) if (!skip.includes(i)) assert.equal((await put(uploadId, i, file.subarray(i * CHUNK, (i + 1) * CHUNK))).code, '1000');
  };
  return { ...t, r, put, init, sendAll };
}

test('upload đầy đủ: init → các mảnh → status → complete → video giống hệt file gốc', async () => {
  const { init, put, sendAll, call, r, ctx } = await uploader();
  const file = fakeVideo();
  const up = await init(file);
  assert.equal(up.code, '1000');
  assert.match(up.data.upload_id, /^up_/);
  assert.equal(up.data.chunk_size, CHUNK);
  assert.equal(up.data.total_chunks, 3);
  assert.deepEqual(up.data.missing_chunks, [0, 1, 2]);

  await sendAll(up.data.upload_id, file, [1]);
  const st = await call('GET', `/videos/uploads/${up.data.upload_id}`, undefined, r.token);
  assert.deepEqual(st.data.missing_chunks, [1]);
  assert.equal(st.data.received_count, 2);
  // Gửi lại một mảnh đã có: không lỗi (ghi đè)
  assert.equal((await put(up.data.upload_id, 0, file.subarray(0, CHUNK))).code, '1000');

  const early = await call('POST', `/videos/uploads/${up.data.upload_id}/complete`, {}, r.token);
  assert.equal(early.code, '3002');
  assert.deepEqual(early.data.missing_chunks, [1]);

  await put(up.data.upload_id, 1, file.subarray(CHUNK, CHUNK * 2));
  const done = await call('POST', `/videos/uploads/${up.data.upload_id}/complete`, {}, r.token);
  assert.equal(done.code, '1000');
  assert.match(done.data.video_id, /^vd_/);
  assert.equal(done.data.size_bytes, file.length);
  assert.equal(done.data.checksum_sha256, sha(file));
  assert.equal(done.data.duration_ms, 8000);
  const row = ctx.db.prepare('SELECT storage_path FROM videos WHERE id = ?').get(done.data.video_id) as { storage_path: string };
  assert.ok(fs.readFileSync(row.storage_path).equals(file));
  // Mảnh tạm đã được dọn
  assert.equal(fs.existsSync(path.join(ctx.config.uploadDir, up.data.upload_id)), false);

  // complete lại → trả cùng video; init lại cùng clip → 3005
  assert.equal((await call('POST', `/videos/uploads/${up.data.upload_id}/complete`, {}, r.token)).data.video_id, done.data.video_id);
  const again = await init(file);
  assert.equal(again.code, '3005');
  assert.equal(again.data.video_id, done.data.video_id);
  assert.equal(again.data.already_uploaded, '1');
});

test('resume: init lại cùng clip trả đúng phiên cũ và mảnh còn thiếu', async () => {
  const { init, sendAll } = await uploader();
  const file = fakeVideo();
  const up = await init(file);
  await sendAll(up.data.upload_id, file, [2]);
  const resumed = await init(file);
  assert.equal(resumed.data.upload_id, up.data.upload_id);
  assert.deepEqual(resumed.data.missing_chunks, [2]);
});

test('kiểm tra mảnh: sai SHA-256 → 3003, sai kích thước / vượt chỉ số → 1004, thiếu header → 1002', async () => {
  const { init, put } = await uploader();
  const file = fakeVideo();
  const id = (await init(file)).data.upload_id;
  const c0 = file.subarray(0, CHUNK);
  assert.equal((await put(id, 0, c0, sha(Buffer.from('khác')))).code, '3003');
  assert.equal((await put(id, 0, c0.subarray(0, 100))).code, '1004');
  assert.equal((await put(id, 9, c0)).code, '1004');
  assert.equal((await put(id, 0, c0, '')).code, '1002');
  assert.equal((await put('up_khongcoooo', 0, c0)).code, '3001');
});

test('tham số init: >1 GB → 1006, checksum sai dạng → 1004, thiếu → 1002', async () => {
  const { init, call, r } = await uploader();
  const file = fakeVideo();
  assert.equal((await init(file, { total_size: 1024 ** 3 + 1 })).code, '1006');
  assert.equal((await init(file, { checksum_sha256: 'abc' })).code, '1004');
  assert.equal((await call('POST', '/videos/uploads', { file_name: 'a.mp4' }, r.token)).code, '1002');
  assert.equal((await init(file, { mime_type: 'image/png' })).code, '1004');
});

test('SHA-256 toàn file sai → 3003, phiên bị hủy, phải mở phiên mới', async () => {
  const { init, sendAll, call, r } = await uploader();
  const file = fakeVideo();
  const id = (await init(file, { checksum_sha256: sha(Buffer.from('không phải file này')) })).data.upload_id;
  await sendAll(id, file);
  const res = await call('POST', `/videos/uploads/${id}/complete`, {}, r.token);
  assert.equal(res.code, '3003');
  assert.equal(res.data.scope, 'file');
  assert.equal((await call('GET', `/videos/uploads/${id}`, undefined, r.token)).code, '3001');
  assert.notEqual((await init(file)).data.upload_id, id);
});

test('không truy cập được phiên upload của người khác (3001)', async () => {
  const { init, put, remote, call } = await uploader();
  const other = await remote();
  const file = fakeVideo();
  const id = (await init(file)).data.upload_id;
  assert.equal((await put(id, 0, file.subarray(0, CHUNK), undefined, other.token)).code, '3001');
  assert.equal((await call('GET', `/videos/uploads/${id}`, undefined, other.token)).code, '3001');
});

test('vượt hạn mức lưu trữ → 3004 (tính cả phiên đang upload)', async () => {
  const { init, ctx, r } = await uploader();
  const file = fakeVideo();
  const uid = (ctx.db.prepare('SELECT user_id FROM devices WHERE id = ?').get(r.device.device_id) as { user_id: string }).user_id;
  ctx.db.prepare('UPDATE users SET storage_quota_bytes = ? WHERE id = ?').run(file.length * 1.5, uid);
  assert.equal((await init(file)).code, '1000');
  assert.equal((await init(fakeVideo(), { local_video_uid: 'clip-2' })).code, '3004');
});

test('phiên quá hạn → 3001 và được dọn khỏi đĩa', async () => {
  const { init, put, advance, ctx } = await uploader();
  ctx.config.uploadTtlSec = 60;
  const file = fakeVideo();
  const id = (await init(file)).data.upload_id;
  await put(id, 0, file.subarray(0, CHUNK));
  advance(61);
  assert.equal((await put(id, 1, file.subarray(CHUNK, CHUNK * 2))).code, '3001');
  assert.equal(cleanupExpiredUploads(ctx), 1);
  assert.equal(fs.existsSync(path.join(ctx.config.uploadDir, id)), false);
});

test('clip của phiên quay đồng bộ gắn với phòng; Controller thấy tiến độ upload và số clip đã nhận', async () => {
  const t = await uploader();
  const c = await t.controller();
  const room = (await t.call('POST', '/rooms', {}, c)).data;
  await t.call('POST', '/rooms/join', { invite_code: room.invite_code, device_id: t.r.device.device_id, camera_name: 'Cam 1', grant_control: true }, t.r.token);
  const rs = (await t.call('POST', `/rooms/${room.room_id}/recording/start`, { client_command_id: 'a' }, c)).data.recording_session_id;

  assert.equal((await t.init(fakeVideo(), { recording_session_id: 'rs_khongtontai' })).code, '1004');
  const file = fakeVideo();
  const up = await t.init(file, { recording_session_id: rs, recorded_at_ms: 123 });
  await t.call('POST', `/devices/${t.r.device.device_id}/sync`, { camera_facing: 'back', is_recording: false, uploads_pending: 1, upload_progress: 40 }, t.r.token);
  let view = await t.call('GET', `/rooms/${room.room_id}/sync`, undefined, c);
  assert.equal(view.data.members[0].state.uploads_pending, 1);
  assert.equal(view.data.members[0].state.upload_progress, 40);
  assert.equal(view.data.videos_received, 0);

  await t.sendAll(up.data.upload_id, file);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(200)]).toString('base64');
  const done = await t.call('POST', `/videos/uploads/${up.data.upload_id}/complete`, { thumbnail_base64: jpg }, t.r.token);
  assert.equal(done.data.room_id, room.room_id);
  assert.equal(done.data.recording_session_id, rs);
  assert.equal(done.data.has_thumbnail, '1');
  view = await t.call('GET', `/rooms/${room.room_id}/sync`, undefined, c);
  assert.equal(view.data.videos_received, 1);
});

test('xóa tài khoản xóa luôn file video trên đĩa', async () => {
  const { init, sendAll, call, r, ctx } = await uploader();
  const file = fakeVideo();
  const id = (await init(file)).data.upload_id;
  await sendAll(id, file);
  const vd = (await call('POST', `/videos/uploads/${id}/complete`, {}, r.token)).data.video_id;
  const p = (ctx.db.prepare('SELECT storage_path FROM videos WHERE id = ?').get(vd) as { storage_path: string }).storage_path;
  assert.ok(fs.existsSync(p));
  assert.equal((await call('DELETE', '/users/me', { password: 'abc123' }, r.token)).code, '1000');
  assert.equal(fs.existsSync(p), false);
});
