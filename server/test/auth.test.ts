import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, CONTROLLER } from './helpers.ts';

const user = {
  first_name: 'An',
  last_name: 'Nguyen',
  email: 'an.nguyen@gmail.com',
  phone: '0912345678',
  password: 'abc123',
};
const dev = { device_id: 'uuid-1', device_type: 1, device_name: 'Pixel 8' };

test('signup luôn tạo tài khoản Remote, kiểm tra dữ liệu vào', async () => {
  const { call } = await setup();
  const r = await call('POST', '/auth/signup', { ...user, account_role: 'controller' });
  assert.equal(r.code, '1000');
  assert.equal(r.data.account_role, 'remote');
  assert.equal(r.data.verify_required, '1');
  assert.match(r.data.user_id, /^u_/);

  assert.equal((await call('POST', '/auth/signup', { ...user, email: undefined })).code, '1002');
  assert.equal((await call('POST', '/auth/signup', { ...user, phone: 912345678 })).code, '1003');
  assert.equal((await call('POST', '/auth/signup', { ...user, email: 'x@y.vn', phone: '123' })).code, '1004');
  assert.equal(
    (await call('POST', '/auth/signup', { ...user, email: 'x@y.vn', phone: '0911111111', password: 'abc!23' })).code,
    '1004',
  );
  assert.equal(
    (await call('POST', '/auth/signup', { ...user, email: 'x@y.vn', phone: '0911111111', password: '0911111111' }))
      .code,
    '1004',
  );
});

test('signup trùng email/phone với tài khoản đã kích hoạt → 9996; chưa kích hoạt thì cho đăng ký lại', async () => {
  const { call } = await setup();
  await call('POST', '/auth/signup', user);
  assert.equal((await call('POST', '/auth/signup', { ...user, first_name: 'Binh' })).code, '1000');
  const vc = await call('POST', '/auth/verify-code', { email: user.email, purpose: 'signup' });
  await call('POST', '/auth/verify-code/check', { email: user.email, code_verify: vc.data.code_verify });
  assert.equal((await call('POST', '/auth/signup', user)).code, '9996');
  assert.equal((await call('POST', '/auth/signup', { ...user, email: 'other@gmail.com' })).code, '9996');
  assert.equal(
    (await call('POST', '/auth/signup', { ...CONTROLLER, first_name: 'a', last_name: 'b', password: 'abc123' })).code,
    '9996',
  );
});

test('get_verify_code: trả mã, che email, giới hạn 120 giây', async () => {
  const { call, advance } = await setup();
  await call('POST', '/auth/signup', user);
  const r = await call('POST', '/auth/verify-code', { email: user.email, purpose: 'signup' });
  assert.equal(r.code, '1000');
  assert.equal(r.data.expires_in, 300);
  assert.equal(r.data.masked_target, 'a***@gmail.com');
  assert.match(r.data.code_verify, /^\d{6}$/);

  const again = await call('POST', '/auth/verify-code', { phone: user.phone, purpose: 'signup' });
  assert.equal(again.code, '1012');
  assert.ok(again.data.retry_after > 0);
  advance(121);
  const r2 = await call('POST', '/auth/verify-code', { phone: user.phone, purpose: 'signup' });
  assert.equal(r2.code, '1000');
  assert.equal(r2.data.masked_target, '091****678');

  assert.equal((await call('POST', '/auth/verify-code', { email: 'none@x.vn', purpose: 'signup' })).code, '9995');
  assert.equal((await call('POST', '/auth/verify-code', { email: user.email, purpose: 'hack' })).code, '1004');
  // Mã cũ bị vô hiệu sau khi gửi mã mới
  assert.equal(
    (await call('POST', '/auth/verify-code/check', { email: user.email, code_verify: r.data.code_verify })).code,
    r.data.code_verify === r2.data.code_verify ? '1000' : '9993',
  );
});

test('check_verify_code: sai mã → 9993, đúng → kích hoạt + trả token + đăng ký thiết bị', async () => {
  const { call } = await setup();
  await call('POST', '/auth/signup', user);
  const vc = await call('POST', '/auth/verify-code', { email: user.email, purpose: 'signup' });
  const wrong = vc.data.code_verify === '000000' ? '111111' : '000000';
  assert.equal((await call('POST', '/auth/verify-code/check', { email: user.email, code_verify: wrong })).code, '9993');

  // Chưa kích hoạt thì không đăng nhập được
  const before = await call('POST', '/auth/login', { email: user.email, password: user.password, ...dev });
  assert.equal(before.code, '9995');
  assert.equal(before.data.verify_required, '1');

  const ok = await call('POST', '/auth/verify-code/check', {
    email: user.email,
    code_verify: vc.data.code_verify,
    ...dev,
  });
  assert.equal(ok.code, '1000');
  assert.equal(ok.data.active, '1');
  assert.equal(ok.data.account_role, 'remote');
  assert.ok(ok.data.access_token && ok.data.refresh_token);
  assert.match(ok.data.device.device_id, /^dv_/);
  // Mã chỉ dùng được một lần
  assert.equal(
    (await call('POST', '/auth/verify-code/check', { email: user.email, code_verify: vc.data.code_verify })).code,
    '1004',
  );
});

test('check_verify_code khóa sau 5 lần sai', async () => {
  const { call } = await setup();
  await call('POST', '/auth/signup', user);
  const vc = await call('POST', '/auth/verify-code', { email: user.email, purpose: 'signup' });
  const wrong = vc.data.code_verify === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await call('POST', '/auth/verify-code/check', { email: user.email, code_verify: wrong });
  assert.equal(
    (await call('POST', '/auth/verify-code/check', { email: user.email, code_verify: vc.data.code_verify })).code,
    '9993',
  );
});

test('login: email hoặc phone, trả account_role + device; nhiều máy cùng lúc', async () => {
  const { call, remote } = await setup();
  const r = await remote('an');
  const byPhone = await call('POST', '/auth/login', { phone: r.phone, password: 'abc123', ...dev });
  assert.equal(byPhone.code, '1000');
  assert.equal(byPhone.data.account_role, 'remote');
  assert.equal(byPhone.data.expires_in, 3600);
  assert.equal(byPhone.data.device.camera_name, 'Pixel 8');
  assert.equal(byPhone.data.user.email, r.email);
  // Phiên ở máy đầu tiên vẫn còn hiệu lực
  assert.equal((await call('GET', '/users/me', undefined, r.token)).code, '1000');

  const ctl = await call('POST', '/auth/login', {
    email: CONTROLLER.email,
    password: CONTROLLER.password,
    ...dev,
    device_type: 4,
  });
  assert.equal(ctl.data.account_role, 'controller');

  assert.equal((await call('POST', '/auth/login', { email: 'no@x.vn', password: 'abc123', ...dev })).code, '9995');
  const bad = await call('POST', '/auth/login', { email: r.email, password: 'wrong1', ...dev });
  assert.equal(bad.code, '1004');
  assert.equal(bad.data.field, 'password');
  assert.equal(
    (await call('POST', '/auth/login', { email: r.email, password: 'abc123', ...dev, device_type: 3 })).code,
    '1004',
  );
  assert.equal((await call('POST', '/auth/login', { email: r.email, password: 'abc123' })).code, '1002');
});

test('token: thiếu/sai/hết hạn → 9998; refresh xoay vòng, dùng lại token cũ → thu hồi phiên', async () => {
  const { call, remote, advance } = await setup();
  const r = await remote();
  assert.equal((await call('GET', '/users/me')).code, '9998');
  assert.equal((await call('GET', '/users/me', undefined, 'at_fake')).code, '9998');

  advance(3601);
  assert.equal((await call('GET', '/users/me', undefined, r.token)).code, '9998');
  const ref = await call('POST', '/auth/refresh', { refresh_token: r.refresh });
  assert.equal(ref.code, '1000');
  assert.notEqual(ref.data.refresh_token, r.refresh);
  assert.equal((await call('GET', '/users/me', undefined, ref.data.access_token)).code, '1000');

  // Dùng lại refresh token cũ → 9998 và cả phiên bị thu hồi
  assert.equal((await call('POST', '/auth/refresh', { refresh_token: r.refresh })).code, '9998');
  assert.equal((await call('GET', '/users/me', undefined, ref.data.access_token)).code, '9998');
  assert.equal((await call('POST', '/auth/refresh', { refresh_token: ref.data.refresh_token })).code, '9998');
});

test('forgot_password: đặt lại bằng mã, thu hồi mọi phiên', async () => {
  const { call, remote, advance } = await setup();
  const r = await remote();
  const vc = await call('POST', '/auth/verify-code', { email: r.email, purpose: 'forgot_password' });
  assert.equal(vc.code, '1000');
  const res = await call('POST', '/auth/password/forgot', {
    email: r.email,
    code_verify: vc.data.code_verify,
    new_password: 'newpass1',
  });
  assert.equal(res.code, '1000');
  assert.equal((await call('GET', '/users/me', undefined, r.token)).code, '9998');
  assert.equal((await call('POST', '/auth/login', { email: r.email, password: 'abc123', ...dev })).code, '1004');
  assert.equal((await call('POST', '/auth/login', { email: r.email, password: 'newpass1', ...dev })).code, '1000');
  advance(121);
  // Mã signup không dùng được cho forgot_password
  assert.equal(
    (
      await call('POST', '/auth/password/forgot', {
        email: r.email,
        code_verify: vc.data.code_verify,
        new_password: 'newpass2',
      })
    ).code,
    '9993',
  );
});

test('change_password: giữ phiên hiện tại, đá phiên ở máy khác', async () => {
  const { call, remote } = await setup();
  const r = await remote();
  const other = await call('POST', '/auth/login', { email: r.email, password: 'abc123', ...dev });
  assert.equal(
    (await call('PUT', '/auth/password', { password: 'wrong1', new_password: 'xyz789' }, r.token)).code,
    '1004',
  );
  const res = await call('PUT', '/auth/password', { password: 'abc123', new_password: 'xyz789' }, r.token);
  assert.equal(res.code, '1000');
  assert.equal((await call('GET', '/users/me', undefined, res.data.access_token)).code, '1000');
  assert.equal((await call('GET', '/users/me', undefined, other.data.access_token)).code, '9998');
});

test('logout chỉ hủy phiên hiện tại; delete_account xóa vĩnh viễn', async () => {
  const { call, remote, controller } = await setup();
  const r = await remote();
  const second = await call('POST', '/auth/login', { email: r.email, password: 'abc123', ...dev });
  assert.equal((await call('POST', '/auth/logout', {}, r.token)).code, '1000');
  assert.equal((await call('GET', '/users/me', undefined, r.token)).code, '9998');
  const t2 = second.data.access_token;
  assert.equal((await call('GET', '/users/me', undefined, t2)).code, '1000');

  assert.equal((await call('DELETE', '/users/me', { password: 'wrong1' }, t2)).code, '1004');
  assert.equal((await call('DELETE', '/users/me', { password: 'abc123' }, t2)).code, '1000');
  assert.equal((await call('GET', '/users/me', undefined, t2)).code, '9998');
  assert.equal((await call('POST', '/auth/login', { email: r.email, password: 'abc123', ...dev })).code, '9995');

  const c = await controller();
  assert.equal((await call('DELETE', '/users/me', { password: CONTROLLER.password }, c)).code, '1009');
});

test('route không tồn tại hoặc sai method → 9997; JSON hỏng → 1003', async () => {
  const { app, call } = await setup();
  assert.equal((await call('GET', '/auth/login')).code, '9997');
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: '{bad',
  });
  assert.equal(res.json().code, '1003');
  assert.equal((await call('GET', '/health')).code, '1000');
});
