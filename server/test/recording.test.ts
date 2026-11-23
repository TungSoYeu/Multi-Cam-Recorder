import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

async function studio(remotes = 2) {
  const t = await setup();
  const c = await t.controller();
  const room = (await t.call('POST', '/rooms', {}, c)).data;
  const cams: Awaited<ReturnType<typeof t.remote>>[] = [];
  for (let i = 0; i < remotes; i++) {
    const r = await t.remote();
    await t.call(
      'POST',
      '/rooms/join',
      {
        invite_code: room.invite_code,
        device_id: r.device.device_id,
        camera_name: `Cam ${i + 1}`,
        grant_control: true,
      },
      r.token,
    );
    cams.push(r);
  }
  const sync = (r: (typeof cams)[number], body: Record<string, unknown> = {}) =>
    t.call(
      'POST',
      `/devices/${r.device.device_id}/sync`,
      { camera_facing: 'back', is_recording: false, ...body },
      r.token,
    );
  const start = (id: string) => t.call('POST', `/rooms/${room.room_id}/recording/start`, { client_command_id: id }, c);
  const stop = (id: string) => t.call('POST', `/rooms/${room.room_id}/recording/stop`, { client_command_id: id }, c);
  return { ...t, c, room, cams, sync, start, stop };
}

test('start_recording: hẹn giờ 2,5 giây, mọi máy nhận cùng một lệnh', async () => {
  const { cams, sync, start, ctx } = await studio(2);
  const r = await start('click-1');
  assert.equal(r.code, '1000');
  assert.match(r.data.recording_session_id, /^rs_/);
  assert.equal(r.data.execute_at_ms - ctx.now(), 2500);
  assert.equal(r.data.total_devices, 2);

  for (const cam of cams) {
    const s = await sync(cam);
    assert.equal(s.data.interval_ms, 1000);
    assert.equal(s.data.recording.recording_session_id, r.data.recording_session_id);
    assert.equal(s.data.recording.started_at_ms, r.data.execute_at_ms);
    assert.equal(s.data.commands.length, 1);
    const cmd = s.data.commands[0];
    assert.equal(cmd.type, 'start_recording');
    assert.equal(cmd.command_id, r.data.command_id);
    assert.equal(cmd.execute_at_ms, r.data.execute_at_ms);
    assert.equal(cmd.recording_session_id, r.data.recording_session_id);
  }
});

test('lệnh trùng client_command_id → 1010 kèm kết quả cũ; Start khi đang quay → 2006', async () => {
  const { start, stop } = await studio(1);
  const first = await start('click-1');
  const dup = await start('click-1');
  assert.equal(dup.code, '1010');
  assert.equal(dup.data.command_id, first.data.command_id);
  assert.equal(dup.data.recording_session_id, first.data.recording_session_id);
  assert.equal((await start('click-2')).code, '2006');

  assert.equal((await stop('stop-1')).code, '1000');
  assert.equal((await stop('stop-1')).code, '1010');
  assert.equal((await stop('stop-2')).code, '2006');
  assert.equal((await start('click-3')).code, '1000');
});

test('quyền và tham số: Remote → 1009, thiếu client_command_id → 1002, phòng trống → 9994', async () => {
  const t = await studio(1);
  assert.equal(
    (await t.call('POST', `/rooms/${t.room.room_id}/recording/start`, { client_command_id: 'x' }, t.cams[0].token))
      .code,
    '1009',
  );
  assert.equal((await t.call('POST', `/rooms/${t.room.room_id}/recording/start`, {}, t.c)).code, '1002');

  const empty = await setup();
  const c = await empty.controller();
  const room = (await empty.call('POST', '/rooms', {}, c)).data;
  assert.equal(
    (await empty.call('POST', `/rooms/${room.room_id}/recording/start`, { client_command_id: 'x' }, c)).code,
    '9994',
  );
});

test('ACK: lệnh đã xác nhận không giao lại; Controller thấy trạng thái từng máy', async () => {
  const { cams, sync, start, call, c, room } = await studio(2);
  const r = await start('click-1');
  const [a, b] = cams;
  const s1 = await sync(a);
  await sync(a, { is_recording: true, acks: [{ command_id: s1.data.commands[0].command_id, status: 'done' }] });
  assert.equal((await sync(a, { is_recording: true })).data.commands.length, 0);
  assert.equal((await sync(b)).data.commands.length, 1);

  const view = await call('GET', `/rooms/${room.room_id}/sync`, undefined, c);
  assert.equal(view.data.recording.recording_session_id, r.data.recording_session_id);
  const status = Object.fromEntries(view.data.members.map((m: any) => [m.camera_name, m.last_command.status]));
  assert.deepEqual(status, { 'Cam 1': 'done', 'Cam 2': 'pending' });

  assert.equal((await sync(b, { acks: 'oops' })).code, '1003');
  assert.equal((await sync(b, { acks: [{ command_id: r.data.command_id, status: 'maybe' }] })).code, '1004');
});

test('stop_recording: mọi máy nhận lệnh dừng; trạng thái phòng về null', async () => {
  const { cams, sync, start, stop, advance } = await studio(1);
  const s = await start('a');
  advance(10);
  const st = await stop('b');
  assert.equal(st.code, '1000');
  assert.equal(st.data.recording_session_id, s.data.recording_session_id);
  assert.ok(st.data.duration_ms > 0);
  const res = await sync(cams[0]);
  // Chưa tới giờ hẹn dừng: vẫn trả phiên kèm stop_at để máy lỡ lệnh dừng đúng giờ
  assert.equal(res.data.recording.recording_session_id, s.data.recording_session_id);
  assert.equal(res.data.recording.stop_at_ms, st.data.execute_at_ms);
  assert.deepEqual(
    res.data.commands.map((x: any) => x.type),
    ['start_recording', 'stop_recording'],
  );
  advance(2);
  assert.equal((await sync(cams[0])).data.recording, null);
});

test('máy vào phòng muộn không nhận lệnh cũ, nhưng thấy phòng đang quay để tự bắt đầu', async () => {
  const t = await studio(1);
  await t.start('a');
  t.advance(1);
  const late = await t.remote();
  await t.call(
    'POST',
    '/rooms/join',
    { invite_code: t.room.invite_code, device_id: late.device.device_id, camera_name: 'Late', grant_control: true },
    late.token,
  );
  const s = await t.sync(late);
  assert.equal(s.data.commands.length, 0);
  assert.equal(s.data.recording.status, 'recording');
});

test('lệnh quá 30 giây không giao nữa; đóng phòng kết thúc phiên quay', async () => {
  const t = await studio(1);
  await t.start('a');
  t.advance(31);
  assert.equal((await t.sync(t.cams[0])).data.commands.length, 0);
  await t.call('DELETE', `/rooms/${t.room.room_id}`, undefined, t.c);
  const room2 = (await t.call('POST', '/rooms', {}, t.c)).data;
  assert.equal((await t.call('GET', `/rooms/${room2.room_id}/sync`, undefined, t.c)).data.recording, null);
});

test('đổi camera từ xa: chỉ máy đích nhận lệnh; đang quay → 2006', async () => {
  const { cams, sync, call, c, room, start } = await studio(2);
  const [a, b] = cams;
  const member = (await sync(a)).data.room.member_id;
  const r = await call(
    'POST',
    `/rooms/${room.room_id}/members/${member}/camera`,
    { camera_facing: 'front', client_command_id: 'f1' },
    c,
  );
  assert.equal(r.code, '1000');
  const got = (await sync(a)).data.commands;
  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'switch_camera');
  assert.equal(got[0].camera_facing, 'front');
  assert.equal((await sync(b)).data.commands.length, 0);
  assert.equal(
    (
      await call(
        'POST',
        `/rooms/${room.room_id}/members/${member}/camera`,
        { camera_facing: 'up', client_command_id: 'f2' },
        c,
      )
    ).code,
    '1004',
  );
  await start('s');
  assert.equal(
    (
      await call(
        'POST',
        `/rooms/${room.room_id}/members/${member}/camera`,
        { camera_facing: 'back', client_command_id: 'f3' },
        c,
      )
    ).code,
    '2006',
  );
});
