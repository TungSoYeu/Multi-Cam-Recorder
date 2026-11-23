import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

const join = (code: string, device: { device_id: string }, extra: Record<string, unknown> = {}) => ({
  invite_code: code,
  device_id: device.device_id,
  camera_name: 'Cam Trai',
  grant_control: true,
  ...extra,
});

test('create_room: chỉ Controller; mở lại trả đúng phòng cũ', async () => {
  const { call, remote, controller } = await setup();
  const r = await remote();
  assert.equal((await call('POST', '/rooms', {}, r.token)).code, '1009');

  const c = await controller();
  const room = await call('POST', '/rooms', { room_name: 'Buoi quay 03/08', max_members: '8' }, c);
  assert.equal(room.code, '1000');
  assert.match(room.data.room_id, /^rm_/);
  assert.match(room.data.invite_code, /^[A-Z0-9]{6}$/);
  assert.equal(room.data.expires_at, '2026-08-03T14:35:30.000Z');
  assert.equal(room.data.created_at, '2026-08-03T14:25:30.000Z');
  assert.deepEqual(room.data.members, []);

  const again = await call('POST', '/rooms', {}, c);
  assert.equal(again.data.room_id, room.data.room_id);
  assert.equal(again.data.invite_code, room.data.invite_code);
  assert.equal((await call('POST', '/rooms', { max_members: 'abc' }, c)).code, '1003');
});

test('mã hết hạn: join → 2001; mở lại phòng thì cấp mã mới, giữ phòng', async () => {
  const { call, remote, controller, advance } = await setup();
  const c = await controller();
  const r = await remote();
  const room = await call('POST', '/rooms', {}, c);
  advance(601);
  assert.equal((await call('POST', '/rooms/join', join(room.data.invite_code, r.device), r.token)).code, '2001');
  const renewed = await call('POST', '/rooms', {}, c);
  assert.equal(renewed.data.room_id, room.data.room_id);
  assert.equal((await call('POST', '/rooms/join', join(renewed.data.invite_code, r.device), r.token)).code, '1000');
});

test('join_room: bắt buộc grant_control, đúng device, chữ thường vẫn hợp lệ, idempotent', async () => {
  const { call, remote, controller } = await setup();
  const c = await controller();
  const r = await remote();
  const room = await call('POST', '/rooms', {}, c);
  const code = room.data.invite_code;

  assert.equal(
    (await call('POST', '/rooms/join', join(code, r.device, { grant_control: false }), r.token)).code,
    '1004',
  );
  assert.equal(
    (await call('POST', '/rooms/join', join(code, r.device, { grant_control: undefined }), r.token)).code,
    '1002',
  );
  assert.equal((await call('POST', '/rooms/join', join(code, { device_id: 'dv_other' }), r.token)).code, '1004');
  assert.equal((await call('POST', '/rooms/join', join('ABC', r.device), r.token)).code, '1004');
  assert.equal((await call('POST', '/rooms/join', join('ZZZZZZ', r.device), r.token)).code, '2001');
  assert.equal((await call('POST', '/rooms/join', join(code, r.device), c)).code, '1009');

  const ok = await call('POST', '/rooms/join', join(code.toLowerCase(), r.device), r.token);
  assert.equal(ok.code, '1000');
  assert.equal(ok.data.room_id, room.data.room_id);
  assert.match(ok.data.member_id, /^mb_/);
  assert.equal(ok.data.members.length, 1);
  assert.equal(ok.data.members[0].camera_name, 'Cam Trai');
  assert.equal(ok.data.members[0].is_online, '1');

  const again = await call('POST', '/rooms/join', join(code, r.device, { camera_name: 'Cam Phai' }), r.token);
  assert.equal(again.data.member_id, ok.data.member_id);
  assert.equal(again.data.members[0].camera_name, 'Cam Phai');
});

test('phòng đầy → 2002; thiết bị đang ở phòng khác → 2003', async () => {
  const { call, remote, controller } = await setup();
  const c = await controller();
  const room = await call('POST', '/rooms', { max_members: 1 }, c);
  const a = await remote();
  const b = await remote();
  assert.equal((await call('POST', '/rooms/join', join(room.data.invite_code, a.device), a.token)).code, '1000');
  assert.equal((await call('POST', '/rooms/join', join(room.data.invite_code, b.device), b.token)).code, '2002');

  // Đóng phòng rồi tạo phòng mới; a đã bị đưa ra nên vào được phòng mới
  await call('DELETE', `/rooms/${room.data.room_id}`, undefined, c);
  const room2 = await call('POST', '/rooms', {}, c);
  assert.notEqual(room2.data.room_id, room.data.room_id);
  assert.equal((await call('POST', '/rooms/join', join(room2.data.invite_code, a.device), a.token)).code, '1000');
});

test('get_room_members, kick_member, leave_room, close_room', async () => {
  const { call, remote, controller, advance } = await setup();
  const c = await controller();
  const room = await call('POST', '/rooms', {}, c);
  const id = room.data.room_id;
  const a = await remote();
  const b = await remote();
  const ja = await call('POST', '/rooms/join', join(room.data.invite_code, a.device), a.token);
  await call('POST', '/rooms/join', join(room.data.invite_code, b.device, { camera_name: 'Cam Phai' }), b.token);

  const list = await call('GET', `/rooms/${id}/members`, undefined, c);
  assert.equal(list.code, '1000');
  assert.equal(list.data.total, 2);
  assert.equal((await call('GET', `/rooms/${id}/members`, undefined, a.token)).code, '1000');

  // Thiết bị không hoạt động quá 15 giây → offline
  advance(20);
  await call('GET', `/rooms/${id}/members`, undefined, a.token);
  const after = await call('GET', `/rooms/${id}/members`, undefined, c);
  const byName = Object.fromEntries(after.data.members.map((m: any) => [m.camera_name, m.is_online]));
  assert.deepEqual(byName, { 'Cam Trai': '1', 'Cam Phai': '0' });

  // Remote không được kick
  assert.equal((await call('DELETE', `/rooms/${id}/members/${ja.data.member_id}`, undefined, b.token)).code, '1009');
  assert.equal((await call('DELETE', `/rooms/${id}/members/${ja.data.member_id}`, undefined, c)).code, '1000');
  assert.equal((await call('DELETE', `/rooms/${id}/members/${ja.data.member_id}`, undefined, c)).code, '1004');
  const kicked = await call('GET', `/rooms/${id}/members`, undefined, a.token);
  assert.equal(kicked.code, '1009');
  assert.equal(kicked.data.reason, 'kicked');

  assert.equal((await call('POST', `/rooms/${id}/leave`, {}, b.token)).code, '1000');
  assert.equal((await call('POST', `/rooms/${id}/leave`, {}, b.token)).code, '1000');
  assert.equal((await call('GET', `/rooms/${id}/members`, undefined, c)).code, '9994');

  assert.equal((await call('DELETE', `/rooms/${id}`, undefined, a.token)).code, '1009');
  assert.equal((await call('DELETE', `/rooms/${id}`, undefined, c)).code, '1000');
  assert.equal((await call('GET', `/rooms/${id}/members`, undefined, c)).code, '2005');
  assert.equal((await call('DELETE', `/rooms/${id}/members/${ja.data.member_id}`, undefined, c)).code, '2005');
});

test('Controller đăng xuất → phòng đóng (2005); Remote đăng xuất → rời phòng', async () => {
  const { call, remote, controller } = await setup();
  const c = await controller();
  const room = await call('POST', '/rooms', {}, c);
  const a = await remote();
  await call('POST', '/rooms/join', join(room.data.invite_code, a.device), a.token);
  assert.equal((await call('GET', '/users/me', undefined, a.token)).data.room_id, room.data.room_id);
  assert.equal((await call('GET', '/users/me', undefined, c)).data.room_id, room.data.room_id);

  await call('POST', '/auth/logout', {}, c);
  assert.equal((await call('GET', `/rooms/${room.data.room_id}/members`, undefined, a.token)).code, '2005');
  assert.equal((await call('GET', '/users/me', undefined, a.token)).data.room_id, null);
});
