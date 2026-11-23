// Đổi mật khẩu tài khoản Controller trong CSDL. Dùng CONTROLLER_PASSWORD trong .env; để trống thì sinh ngẫu nhiên.
import { PASSWORD_RE } from '../../packages/shared/src/validation.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/database.ts';
import { hashPassword } from '../src/lib/security.ts';
import { randomPassword, WEAK_PASSWORDS } from '../src/modules/auth.ts';

const config = loadConfig();
const fromEnv = config.controller.password;
const usable = !!fromEnv && !WEAK_PASSWORDS.includes(fromEnv);
if (usable && !PASSWORD_RE.test(fromEnv)) {
  console.error('CONTROLLER_PASSWORD phải gồm 6–20 ký tự, chỉ chữ và số.');
  process.exit(1);
}
const password = usable ? fromEnv : randomPassword();
const db = openDatabase(config.dbPath);
const u = db.prepare(`SELECT id, email FROM users WHERE role = 'controller'`).get() as
  { id: string; email: string } | undefined;
if (!u) {
  console.error('Chưa có tài khoản Controller. Hãy chạy server một lần trước (npm start).');
  process.exit(1);
}
db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
  await hashPassword(password),
  Date.now(),
  u.id,
);
db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), u.id);
db.close();
console.log(`Đã đổi mật khẩu Controller (${u.email}); mọi phiên cũ đã bị đăng xuất.`);
console.log(
  usable
    ? 'Mật khẩu mới: lấy từ CONTROLLER_PASSWORD trong server/.env'
    : `Mật khẩu mới: ${password}   <-- ghi lại, chỉ hiện một lần`,
);
