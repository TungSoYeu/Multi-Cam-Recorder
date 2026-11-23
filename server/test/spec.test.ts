// Các điểm đề bài quy định cụ thể + các lỗ hổng đã vá
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ensureController, LEAKED_DEFAULT_PASSWORD } from '../src/modules/auth.ts';
import { signJwt } from '../src/lib/jwt.ts';
import { hashPassword } from '../src/lib/security.ts';
import { CONTROLLER, setup } from './helpers.ts';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const claimsOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

test('access_token là JWT có claim acc; sửa claim hoặc ký bằng khóa khác → 9998', async () => {
  const { call, remote, controller, ctx } = await setup();
  const r = await remote();
  assert.match(r.token, /^eyJhbGciOi/);
  assert.equal(claimsOf(r.token).acc, 'remote');
  assert.equal(claimsOf(await controller()).acc, 'controller');

  const [h, p, s] = r.token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...claimsOf(r.token), acc: 'controller' })).toString('base64url');
  assert.equal((await call('POST', '/rooms', {}, `${h}.${forged}.${s}`)).code, '9998');
  assert.equal((await call('POST', '/rooms', {}, signJwt({ ...claimsOf(r.token), acc: 'controller' }, 'khoa-khac'))).code, '9998');
  // Đúng khóa nhưng không phải token của phiên nào trong CSDL
  assert.equal((await call('POST', '/rooms', {}, signJwt({ ...claimsOf(r.token), acc: 'controller' }, ctx.config.mediaSecret))).code, '9998');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal((await call('GET', '/users/me', undefined, `${none}.${p}.`)).code, '9998');
  assert.equal((await call('POST', '/rooms', {}, r.token)).code, '1009');
});

test('refresh_token trả expires_in dạng chuỗi "3600" như đề bài; login trả số', async () => {
  const { call, remote } = await setup();
  const r = await remote();
  assert.strictEqual((await call('POST', '/auth/refresh', { refresh_token: r.refresh })).data.expires_in, '3600');
  assert.strictEqual(
    (await call('POST', '/auth/login', { email: r.email, password: 'abc123', device_id: 'x', device_type: 1, device_name: 'p' })).data.expires_in,
    3600,
  );
});

test('mã đặt lại mật khẩu của Controller KHÔNG trả qua API, chỉ hiện trên máy server', async () => {
  const { call, ctx } = await setup();
  const shown: string[] = [];
  ctx.showControllerCode = (c) => shown.push(c);
  const r = await call('POST', '/auth/verify-code', { email: CONTROLLER.email, purpose: 'forgot_password' });
  assert.equal(r.code, '1000');
  assert.equal('code_verify' in r.data, false);
  assert.match(shown[0], /^\d{6}$/);
  const reset = await call('POST', '/auth/password/forgot', { email: CONTROLLER.email, code_verify: shown[0], new_password: 'MoiHoanToan1' });
  assert.equal(reset.code, '1000');
});

test('có SMTP: mã gửi tới email; gửi lỗi và không trả mã → 1005, cho gọi lại ngay', async () => {
  const { call, ctx, remote } = await setup();
  const r = await remote();
  const sent: { target: string; code: string }[] = [];
  ctx.sender = { send: async (m) => void sent.push(m) };
  const byPhone = await call('POST', '/auth/verify-code', { phone: r.phone, purpose: 'forgot_password' });
  assert.equal(sent[0].target, r.email);
  assert.equal(byPhone.data.masked_target.includes('@'), true);
  assert.equal(byPhone.data.code_verify, sent[0].code);

  const other = await remote();
  ctx.config.returnVerifyCode = false;
  ctx.sender = { send: async () => Promise.reject(new Error('smtp down')) };
  assert.equal((await call('POST', '/auth/verify-code', { email: other.email, purpose: 'forgot_password' })).code, '1005');
  ctx.sender = { send: async (m) => void sent.push(m) };
  const again = await call('POST', '/auth/verify-code', { email: other.email, purpose: 'forgot_password' });
  assert.equal(again.code, '1000');
  assert.equal('code_verify' in again.data, false);
});

test('đề bài 1003: battery_level dạng chuỗi là sai kiểu', async () => {
  const { call, remote } = await setup();
  const r = await remote();
  const sync = (b: object) => call('POST', `/devices/${r.device.device_id}/sync`, b, r.token);
  assert.equal((await sync({ battery_level: '87' })).code, '1003');
  assert.equal((await sync({ battery_level: 87 })).code, '1000');
});

test('đề bài 9994: phòng chưa có máy nào', async () => {
  const { call, controller } = await setup();
  const c = await controller();
  const room = (await call('POST', '/rooms', {}, c)).data;
  assert.equal((await call('GET', `/rooms/${room.room_id}/members`, undefined, c)).code, '9994');
});

test('giả X-Forwarded-For từ máy ngoài không né được giới hạn tần suất', async () => {
  const { app } = await setup();
  let limited = 0;
  for (let i = 0; i < 40; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '203.0.113.9',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}` },
      payload: '{}',
    });
    if (res.json().code === '1012') limited++;
  }
  assert.equal(limited, 10);
});

test('mật khẩu Controller: để trống → sinh ngẫu nhiên; mật khẩu mẫu đã lộ → cảnh báo', async () => {
  const { ctx } = await setup();
  assert.equal((await ensureController(ctx)).leaked, false);
  ctx.db.prepare(`UPDATE users SET password_hash = ? WHERE role = 'controller'`).run(await hashPassword(LEAKED_DEFAULT_PASSWORD));
  assert.equal((await ensureController(ctx)).leaked, true);
  ctx.db.prepare(`DELETE FROM users WHERE role = 'controller'`).run();
  ctx.config.controller.password = LEAKED_DEFAULT_PASSWORD;
  const made = await ensureController(ctx);
  assert.match(made.generated!, /^[A-Za-z0-9]{12}$/);
});

// ---------- Upload ngay trong lúc quay ----------

const CHUNK = 256 * 1024;
async function liveUploader() {
  const t = await setup();
  const r = await t.remote();
  const put = async (id: string, i: number, body: Buffer) =>
    (
      await t.app.inject({
        method: 'PUT',
        url: `/api/videos/uploads/${id}/chunks/${i}`,
        headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha(body) },
        payload: body,
      })
    ).json();
  const init = (uid = 'live-1') => t.call('POST', '/videos/uploads', { streaming: true, local_video_uid: uid, file_name: 'a.mp4', chunk_size: CHUNK }, r.token);
  const complete = (id: string, file: Buffer, extra: object = {}) =>
    t.call('POST', `/videos/uploads/${id}/complete`, { total_size: file.length, checksum_sha256: sha(file), duration_ms: 4000, ...extra }, r.token);
  return { ...t, r, put, init, complete };
}

test('streaming: gửi mảnh khi chưa biết kích thước; đầu file đổi lúc dừng → chỉ gửi lại mảnh khác', async () => {
  const t = await liveUploader();
  const id = (await t.init()).data.upload_id;
  const growing = crypto.randomBytes(CHUNK * 2 + 777);
  // Đang quay: 2 mảnh đầy đã lên server
  assert.equal((await t.put(id, 0, growing.subarray(0, CHUNK))).code, '1000');
  assert.equal((await t.put(id, 1, growing.subarray(CHUNK, CHUNK * 2))).code, '1000');
  // Dừng quay: máy ghi lại phần đầu file (kích thước mdat / ftyp) và nối thêm phần cuối
  const final = Buffer.from(growing);
  final.write('ftypmp42', 4);

  assert.equal((await t.complete(id, final)).code, '3002'); // thiếu mảnh cuối
  const st = (await t.call('GET', `/videos/uploads/${id}`, undefined, t.r.token)).data;
  assert.deepEqual(st.missing_chunks, [2]);
  const differing = [0, 1, 2].filter((i) => st.chunk_hashes[i] !== sha(final.subarray(i * CHUNK, (i + 1) * CHUNK)));
  assert.deepEqual(differing, [0, 2]); // mảnh 1 không phải gửi lại
  for (const i of differing) assert.equal((await t.put(id, i, final.subarray(i * CHUNK, (i + 1) * CHUNK))).code, '1000');
  const done = await t.complete(id, final);
  assert.equal(done.code, '1000');
  assert.equal(done.data.duration_ms, 4000);
  const p = (t.ctx.db.prepare('SELECT storage_path AS p FROM videos WHERE id = ?').get(done.data.video_id) as { p: string }).p;
  assert.ok(fs.readFileSync(p).equals(final));
});

test('streaming: mảnh lẻ giữa chừng bị loại khi chốt; thiếu tham số → 1002; >1 GB → 1006; hạn mức → 3004', async () => {
  const t = await liveUploader();
  const id = (await t.init()).data.upload_id;
  const file = crypto.randomBytes(CHUNK + 100);
  await t.put(id, 0, file.subarray(0, 5000)); // mảnh lẻ
  assert.equal((await t.call('POST', `/videos/uploads/${id}/complete`, {}, t.r.token)).code, '1002');
  assert.equal((await t.complete(id, file, { total_size: 1024 ** 3 + 1 })).code, '1006');
  const r = await t.complete(id, file);
  assert.equal(r.code, '3002');
  assert.deepEqual(r.data.missing_chunks, [0, 1]);

  t.ctx.config.maxVideoBytes = CHUNK;
  const id2 = (await t.init('live-2')).data.upload_id;
  assert.equal((await t.put(id2, 1, crypto.randomBytes(10))).code, '1006');

  t.ctx.db.prepare('UPDATE users SET storage_quota_bytes = 1000').run();
  const id3 = (await t.init('live-3')).data?.upload_id;
  if (id3) assert.equal((await t.put(id3, 0, crypto.randomBytes(2000))).code, '3004');
});

test('streaming: mở lại app trong lúc quay dở → init trả đúng phiên cũ', async () => {
  const t = await liveUploader();
  const a = (await t.init()).data;
  await t.put(a.upload_id, 0, crypto.randomBytes(CHUNK));
  const b = (await t.init()).data;
  assert.equal(b.upload_id, a.upload_id);
  assert.equal(Object.keys(b.chunk_hashes).length, 1);
});
