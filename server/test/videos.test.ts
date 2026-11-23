import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { setup } from './helpers.ts';

const CHUNK = 256 * 1024;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Phòng có 2 máy cùng quay một buổi, mỗi máy upload 1 clip; thêm 1 clip quay độc lập. */
async function library() {
  const t = await setup();
  const c = await t.controller();
  const room = (await t.call('POST', '/rooms', {}, c)).data;
  const cams = [await t.remote(), await t.remote()];
  for (const [i, r] of cams.entries())
    await t.call(
      'POST',
      '/rooms/join',
      {
        invite_code: room.invite_code,
        device_id: r.device.device_id,
        camera_name: i ? 'Cam Phai' : 'Cam Trai',
        grant_control: true,
      },
      r.token,
    );
  const rs = (await t.call('POST', `/rooms/${room.room_id}/recording/start`, { client_command_id: 's' }, c)).data;

  async function upload(
    r: (typeof cams)[number],
    uid: string,
    extra: Record<string, unknown> = {},
    size = CHUNK + 500,
  ) {
    const file = crypto.randomBytes(size);
    const up = (
      await t.call(
        'POST',
        '/videos/uploads',
        {
          local_video_uid: uid,
          file_name: `${uid}.mp4`,
          total_size: size,
          checksum_sha256: sha(file),
          duration_ms: 5000,
          ...extra,
        },
        r.token,
      )
    ).data;
    for (let i = 0; i < up.total_chunks; i++) {
      const part = file.subarray(i * CHUNK, (i + 1) * CHUNK);
      await t.app.inject({
        method: 'PUT',
        url: `/api/videos/uploads/${up.upload_id}/chunks/${i}`,
        headers: {
          authorization: `Bearer ${r.token}`,
          'content-type': 'application/octet-stream',
          'x-chunk-sha256': sha(part),
        },
        payload: part,
      });
    }
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(300)]).toString('base64');
    const vd = (await t.call('POST', `/videos/uploads/${up.upload_id}/complete`, { thumbnail_base64: jpg }, r.token))
      .data;
    return { ...vd, file };
  }
  const a = await upload(cams[0], 'a', {
    recording_session_id: rs.recording_session_id,
    recorded_at_ms: rs.execute_at_ms + 20,
  });
  t.advance(1);
  // Clip b lớn (4 MB) để kiểm tra trạng thái "đang tải dở"
  const b = await upload(
    cams[1],
    'b',
    { recording_session_id: rs.recording_session_id, recorded_at_ms: rs.execute_at_ms + 45 },
    4 * 1024 * 1024 + 7,
  );
  t.advance(1);
  const solo = await upload(cams[0], 'solo');
  return { ...t, c, room, cams, rs, a, b, solo };
}

/** Lấy file qua link ký sẵn (bỏ phần host) */
const fetchMedia = (t: Awaited<ReturnType<typeof library>>, url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url: new URL(url).pathname + new URL(url).search, headers });

test('get_list_videos: Controller thấy mọi clip, có camera_name, phiên quay, ảnh thu nhỏ; phân trang + 9994', async () => {
  const t = await library();
  const all = await t.call('GET', '/videos?count=2', undefined, t.c);
  assert.equal(all.code, '1000');
  assert.equal(all.data.total, 3);
  assert.equal(all.data.count, 2);
  assert.equal(all.data.has_more, '1');
  const page2 = await t.call('GET', '/videos?index=2&count=2', undefined, t.c);
  assert.equal(page2.data.count, 1);
  assert.equal(page2.data.has_more, '0');
  assert.equal((await t.call('GET', '/videos?index=3', undefined, t.c)).code, '9994');

  const session = await t.call('GET', `/videos?recording_session_id=${t.rs.recording_session_id}`, undefined, t.c);
  assert.equal(session.data.total, 2);
  const byCam = Object.fromEntries(
    session.data.videos.map((x: any) => [x.camera_name, x.recorded_at_ms - t.rs.execute_at_ms]),
  );
  assert.deepEqual(byCam, { 'Cam Trai': 20, 'Cam Phai': 45 });
  const item = session.data.videos[0];
  assert.equal(item.room_id, t.room.room_id);
  assert.equal(item.owner.name, 'Nguyen An');
  assert.match(item.thumbnail_url, /\/api\/media\/thumbs\/vd_\w+\.jpg\?k=thumb/);
  assert.equal(item.session_started_at, new Date(t.rs.execute_at_ms).toISOString());
  assert.equal((await t.call('GET', '/videos?count=500', undefined, t.c)).code, '1004');
});

test('Remote chỉ thấy clip của mình, không lấy được link tải / không xóa được (1009)', async () => {
  const t = await library();
  const [r0, r1] = t.cams;
  assert.equal((await t.call('GET', '/videos', undefined, r0.token)).data.total, 2);
  assert.equal((await t.call('GET', '/videos', undefined, r1.token)).data.total, 1);
  assert.equal((await t.call('GET', `/videos/${t.b.video_id}`, undefined, r0.token)).code, '4001');
  const own = await t.call('GET', `/videos/${t.a.video_id}`, undefined, r0.token);
  assert.equal(own.code, '1000');
  assert.equal(own.data.stream_url, null);
  assert.equal((await t.call('GET', `/videos/${t.a.video_id}/download`, undefined, r0.token)).code, '1009');
  assert.equal((await t.call('DELETE', `/videos/${t.a.video_id}`, undefined, r0.token)).code, '1009');
  assert.equal((await t.call('POST', '/videos/bulk-delete', { video_ids: [t.a.video_id] }, r0.token)).code, '1009');
});

test('get_video + stream: link ký sẵn, hỗ trợ Range (tua video), link sai/hết hạn → 403', async () => {
  const t = await library();
  const d = await t.call('GET', `/videos/${t.a.video_id}`, undefined, t.c);
  assert.equal(d.code, '1000');
  const full = await fetchMedia(t, d.data.stream_url);
  assert.equal(full.statusCode, 200);
  assert.ok(full.rawPayload.equals(t.a.file));
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-disposition'], undefined);

  const part = await fetchMedia(t, d.data.stream_url, { range: 'bytes=100-199' });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], `bytes 100-199/${t.a.file.length}`);
  assert.ok(part.rawPayload.equals(t.a.file.subarray(100, 200)));
  const tail = await fetchMedia(t, d.data.stream_url, { range: 'bytes=-10' });
  assert.ok(tail.rawPayload.equals(t.a.file.subarray(-10)));
  assert.equal((await fetchMedia(t, d.data.stream_url, { range: `bytes=${t.a.file.length}-` })).statusCode, 416);

  const forged = d.data.stream_url.replace(t.a.video_id, t.b.video_id);
  assert.equal((await fetchMedia(t, forged)).statusCode, 403);
  const asDownload = d.data.stream_url.replace('k=stream', 'k=download');
  assert.equal((await fetchMedia(t, asDownload)).statusCode, 403);
  t.advance(2 * 3600);
  assert.equal((await fetchMedia(t, d.data.stream_url)).statusCode, 403);
});

test('ảnh thu nhỏ qua link ký sẵn', async () => {
  const t = await library();
  const list = await t.call('GET', '/videos', undefined, t.c);
  const res = await fetchMedia(t, list.data.videos[0].thumbnail_url);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(res.rawPayload[0], 0xff);
});

test('get_download_url: file tải về có tên gốc; đang có lượt tải chưa xong → 4002', async () => {
  const t = await library();
  const dl = await t.call('GET', `/videos/${t.a.video_id}/download`, undefined, t.c);
  assert.equal(dl.code, '1000');
  assert.equal(dl.data.file_name, 'a.mp4');
  const res = await fetchMedia(t, dl.data.download_url);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-disposition']), /attachment; filename="a\.mp4"/);
  assert.ok(res.rawPayload.equals(t.a.file));
  // Lượt tải đã kết thúc → xin link tiếp được
  await new Promise((r) => setImmediate(r));
  assert.equal((await t.call('GET', `/videos/${t.b.video_id}/download`, undefined, t.c)).code, '1000');

  // Mô phỏng lượt tải chưa xong: mở stream qua HTTP thật nhưng không đọc hết
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (t.app.server.address() as { port: number }).port;
  const big = await t.call('GET', `/videos/${t.b.video_id}/download`, undefined, t.c);
  const url = new URL(big.data.download_url);
  const ctrl = new AbortController();
  const resp = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { signal: ctrl.signal });
  const reader = resp.body!.getReader();
  await reader.read(); // chỉ đọc một phần của file 4 MB
  assert.equal((await t.call('GET', `/videos/${t.a.video_id}/download`, undefined, t.c)).code, '4002');
  ctrl.abort();
  await reader.cancel().catch(() => undefined);
  // Client hủy tải → lượt tải được giải phóng
  let code = '';
  for (let i = 0; i < 50 && code !== '1000'; i++) {
    await new Promise((r) => setTimeout(r, 20));
    code = (await t.call('GET', `/videos/${t.a.video_id}/download`, undefined, t.c)).code;
  }
  assert.equal(code, '1000');
  await t.app.close();
});

test('delete_video và delete_videos_bulk: xóa bản ghi + file; giới hạn 50; 4001', async () => {
  const t = await library();
  const paths = (id: string) =>
    t.ctx.db.prepare('SELECT storage_path, thumbnail_path FROM videos WHERE id = ?').get(id) as {
      storage_path: string;
      thumbnail_path: string;
    };
  const pa = paths(t.a.video_id);
  assert.equal((await t.call('DELETE', `/videos/${t.a.video_id}`, undefined, t.c)).code, '1000');
  assert.equal(fs.existsSync(pa.storage_path), false);
  assert.equal(fs.existsSync(pa.thumbnail_path), false);
  assert.equal((await t.call('DELETE', `/videos/${t.a.video_id}`, undefined, t.c)).code, '4001');
  assert.equal((await t.call('GET', `/videos/${t.a.video_id}`, undefined, t.c)).code, '4001');

  assert.equal((await t.call('POST', '/videos/bulk-delete', {}, t.c)).code, '1002');
  assert.equal((await t.call('POST', '/videos/bulk-delete', { video_ids: 'x' }, t.c)).code, '1003');
  assert.equal(
    (await t.call('POST', '/videos/bulk-delete', { video_ids: Array.from({ length: 51 }, (_, i) => `vd_${i}`) }, t.c))
      .code,
    '1004',
  );
  const bulk = await t.call(
    'POST',
    '/videos/bulk-delete',
    { video_ids: [t.b.video_id, t.solo.video_id, 'vd_khongco'] },
    t.c,
  );
  assert.equal(bulk.code, '1000');
  assert.deepEqual(bulk.data.deleted.sort(), [t.b.video_id, t.solo.video_id].sort());
  assert.deepEqual(bulk.data.not_found, ['vd_khongco']);
  assert.equal((await t.call('GET', '/videos', undefined, t.c)).code, '9994');
  assert.equal((await t.call('POST', '/videos/bulk-delete', { video_ids: ['vd_khongco'] }, t.c)).code, '4001');
});
