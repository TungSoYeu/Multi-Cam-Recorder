import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

const state = { camera_facing: 'front', is_recording: false, battery_level: 87, free_storage_bytes: 12_400_000_000, resolution: '1080p', fps: 30 };

async function roomWithRemote() {
  const t = await setup();
  const c = await t.controller();
  const room = await t.call('POST', '/rooms', {}, c);
  const r = await t.remote();
  await t.call('POST', '/rooms/join', { invite_code: room.data.invite_code, device_id: r.device.device_id, camera_name: 'Cam Trai', grant_control: true }, r.token);
  return { ...t, c, room: room.data, r };
}

test('sync_device: lưu trạng thái, trả phòng hiện tại', async () => {
  const { call, r, room } = await roomWithRemote();
  const res = await call('POST', `/devices/${r.device.device_id}/sync`, state, r.token);
  assert.equal(res.code, '1000');
  assert.equal(res.data.room.room_id, room.room_id);
  assert.match(res.data.room.member_id, /^mb_/);
  assert.equal(res.data.last_left_reason, null);
  assert.equal(res.data.interval_ms, 1000);
  assert.deepEqual(res.data.commands, []);
  assert.equal(typeof res.data.server_time_ms, 'number');
});

test('sync_device: sai thiết bị → 1009; sai giá trị → 1004/1003', async () => {
  const { call, r, remote } = await roomWithRemote();
  const other = await remote();
  assert.equal((await call('POST', `/devices/${other.device.device_id}/sync`, state, r.token)).code, '1009');
  assert.equal((await call('POST', `/devices/${r.device.device_id}/sync`, { camera_facing: 'side' }, r.token)).code, '1004');
  assert.equal((await call('POST', `/devices/${r.device.device_id}/sync`, { battery_level: 150 }, r.token)).code, '1004');
  assert.equal((await call('POST', `/devices/${r.device.device_id}/sync`, { battery_level: 'full' }, r.token)).code, '1003');
  assert.equal((await call('POST', `/devices/${r.device.device_id}/sync`, {}, r.token)).code, '1000');
});

test('sync_device báo lý do khi bị kick hoặc phòng đóng', async () => {
  const { call, r, c, room } = await roomWithRemote();
  const s1 = await call('POST', `/devices/${r.device.device_id}/sync`, state, r.token);
  await call('DELETE', `/rooms/${room.room_id}/members/${s1.data.room.member_id}`, undefined, c);
  const s2 = await call('POST', `/devices/${r.device.device_id}/sync`, state, r.token);
  assert.equal(s2.data.room, null);
  assert.equal(s2.data.last_left_reason, 'kicked');

  const renewed = await call('POST', '/rooms', {}, c);
  await call('POST', '/rooms/join', { invite_code: renewed.data.invite_code, device_id: r.device.device_id, camera_name: 'Cam Trai', grant_control: true }, r.token);
  await call('DELETE', `/rooms/${room.room_id}`, undefined, c);
  const s3 = await call('POST', `/devices/${r.device.device_id}/sync`, state, r.token);
  assert.equal(s3.data.last_left_reason, 'closed');
});

test('sync_room: Controller thấy danh sách máy kèm trạng thái', async () => {
  const { call, r, c, room, advance } = await roomWithRemote();
  // Chưa sync lần nào → state null
  const before = await call('GET', `/rooms/${room.room_id}/sync`, undefined, c);
  assert.equal(before.code, '1000');
  assert.equal(before.data.members[0].state, null);

  await call('POST', `/devices/${r.device.device_id}/sync`, { ...state, is_recording: true }, r.token);
  const res = await call('GET', `/rooms/${room.room_id}/sync`, undefined, c);
  assert.equal(res.data.total, 1);
  assert.equal(res.data.online, 1);
  assert.equal(res.data.invite_code, room.invite_code);
  const m = res.data.members[0];
  assert.equal(m.camera_name, 'Cam Trai');
  assert.equal(m.is_online, '1');
  assert.deepEqual(
    { ...m.state, updated_at: undefined },
    { camera_facing: 'front', is_recording: '1', battery_level: 87, free_storage_bytes: 12_400_000_000, resolution: '1080p', fps: 30, uploads_pending: 0, upload_progress: null, updated_at: undefined },
  );

  advance(16);
  assert.equal((await call('GET', `/rooms/${room.room_id}/sync`, undefined, c)).data.members[0].is_online, '0');
  assert.equal((await call('GET', `/rooms/${room.room_id}/sync`, undefined, r.token)).code, '1009');
  await call('DELETE', `/rooms/${room.room_id}`, undefined, c);
  assert.equal((await call('GET', `/rooms/${room.room_id}/sync`, undefined, c)).code, '2005');
});
