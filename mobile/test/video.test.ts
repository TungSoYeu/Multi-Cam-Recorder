import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseFtyp } from '@multicam/shared';
import { setup } from '../../server/test/helpers.ts';
import * as lib from '../src/video/library.ts';
import { cameraFilesBefore, LIVE_CHUNK, liveUploadedBytes, startLiveUpload } from '../src/video/liveUpload.ts';
import * as up from '../src/video/uploader.ts';
import { api, net } from './fakes/api.ts';
import { root } from './fakes/fs.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, what: string, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await f()) return;
    await sleep(50);
  }
  throw new Error('hết giờ chờ: ' + what);
}

let t: Awaited<ReturnType<typeof setup>>;
let n = 0;
async function login() {
  const r = await t.remote(`m${++n}`);
  await api.login({ email: r.email, password: 'abc123', device_id: `d${n}`, device_type: 2, device_name: 'iPhone' });
}

const camDir = path.join(root, 'cache', 'Camera');
/** Đầu file QuickTime như iPhone ghi: ftyp `qt  ` */
function movHead() {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(20, 0);
  b.write('ftypqt  ', 4);
  b.write('qt  ', 16);
  b.write('wide', 24);
  return b;
}
function tmpClip(size: number) {
  const p = path.join(camDir, crypto.randomUUID() + '.mov');
  fs.writeFileSync(p, Buffer.concat([movHead(), crypto.randomBytes(size)]));
  return 'file://' + p;
}
const stored = (id: string) =>
  fs.readFileSync((t.ctx.db.prepare('SELECT storage_path AS p FROM videos WHERE local_video_uid = ?').get(id) as { p: string }).p);
const meta = (id: string) => ({
  id,
  startedAt: Date.now(),
  durationMs: 3000,
  facing: 'back' as const,
  roomId: null,
  recordingSessionId: null,
  startedAtServerMs: null,
  liveUploadId: null,
});

before(async () => {
  t = await setup();
  t.ctx.now = Date.now;
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  net.base = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}/api`;
  fs.mkdirSync(camDir, { recursive: true });
});
after(async () => {
  await t.app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('lưu clip iPhone: chờ move xong, đúng kích thước, thành MP4, có ảnh thu nhỏ; upload lên server giống hệt', async () => {
  await login();
  const id = lib.newClipId();
  const clip = await lib.saveRecording(tmpClip(700_000), meta(id));
  assert.equal(clip.size_bytes, 700_032); // lỗi cũ: đọc kích thước trước khi move xong → 0
  assert.equal(clip.has_thumbnail, true);
  assert.equal(clip.container, 'mp4');
  up.kickUploads();
  await until(async () => (await lib.getClip(id))!.uploaded, 'upload xong');
  const s = stored(id);
  assert.equal(s.length, 700_032);
  assert.equal(parseFtyp(s.subarray(0, 64))!.majorBrand, 'mp42');
});

test('upload NGAY TRONG LÚC QUAY; dừng quay chỉ gửi lại mảnh đã đổi', async () => {
  await login();
  const id = lib.newClipId();
  const known = cameraFilesBefore();
  up.holdUpload(id);
  const live = startLiveUpload(known, { id, startedAt: Date.now(), facing: 'back', recordingSessionId: null, startedAtServerMs: null });
  const p = path.join(camDir, 'dang-quay.mov');
  fs.writeFileSync(p, movHead());
  net.puts = [];
  for (let i = 0; i < 4; i++) {
    fs.appendFileSync(p, crypto.randomBytes(LIVE_CHUNK));
    await sleep(400);
  }
  await until(() => (liveUploadedBytes() ?? 0) >= 4 * LIVE_CHUNK, 'mảnh lên server khi đang quay');
  assert.deepEqual(net.puts, ['0', '1', '2', '3']);
  // Dừng quay: camera ghi lại phần đầu (như kích thước mdat) và nối thêm moov ở cuối
  const fd = fs.openSync(p, 'r+');
  fs.writeSync(fd, Buffer.from('DAU-FILE-MOI'), 0, 12, 100);
  fs.closeSync(fd);
  fs.appendFileSync(p, crypto.randomBytes(123_456));
  const clip = await lib.saveRecording('file://' + p, meta(id));
  const { uploadId } = await live.stop();
  assert.ok(uploadId);
  assert.equal(liveUploadedBytes(), null);
  await lib.updateClip(id, { upload_id: uploadId, streaming: true });
  net.puts = [];
  up.releaseUpload(id);
  up.kickUploads();
  await until(async () => (await lib.getClip(id))!.uploaded, 'hoàn tất');
  assert.ok(stored(id).equals(fs.readFileSync(lib.clipFile(clip).uri.replace('file://', ''))));
  assert.deepEqual(net.puts, ['0', '4']); // mảnh 1–3 đã có sẵn, không gửi lại
});

test('mất mạng: thử lại 3 lần rồi tạm dừng; mở lại app thì gửi tiếp', async () => {
  await login();
  const id = lib.newClipId();
  await lib.saveRecording(tmpClip(600_000), meta(id));
  net.online = false;
  up.kickUploads();
  await until(async () => up.uploadUi((await lib.getClip(id))!).status === 'paused', 'tạm dừng');
  net.online = true;
  up.resumeUploads();
  await until(async () => (await lib.getClip(id))!.uploaded, 'gửi tiếp');
});

test('mạng chập chờn: gửi lại đúng mảnh đó, người dùng không phải làm gì', async () => {
  await login();
  const id = lib.newClipId();
  await lib.saveRecording(tmpClip(600_000), meta(id));
  net.failPuts = 2;
  up.kickUploads();
  await until(async () => (await lib.getClip(id))!.uploaded, 'tự phục hồi');
});

test('tài khoản khác trên cùng máy không thấy và không upload hộ clip của người trước', async () => {
  await login();
  const id = lib.newClipId();
  up.holdUpload(id);
  await lib.saveRecording(tmpClip(5000), meta(id));
  assert.ok((await lib.listClips()).some((c) => c.id === id));
  await login();
  up.releaseUpload(id);
  assert.equal((await lib.listClips()).length, 0);
  up.resumeUploads();
  await sleep(500);
  assert.equal((await lib.getClip(id))!.uploaded, false);
});

test('nhiều cập nhật song song không làm hỏng index.json', async () => {
  await login();
  const ids = await Promise.all(
    [1, 2, 3].map(async () => {
      const id = lib.newClipId();
      up.holdUpload(id);
      await lib.saveRecording(tmpClip(1000), meta(id));
      return id;
    }),
  );
  await Promise.all(ids.map((id, i) => lib.updateClip(id, { video_id: `v${i}` })));
  const disk = JSON.parse(fs.readFileSync(path.join(root, 'doc', 'videos', 'index.json'), 'utf8')) as lib.LocalClip[];
  for (const [i, id] of ids.entries()) assert.equal(disk.find((c) => c.id === id)?.video_id, `v${i}`);
});
