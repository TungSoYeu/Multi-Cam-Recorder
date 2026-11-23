import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { authenticate, type Ctx, type DeviceRow, type UserRow } from '../context.ts';
import { tx } from '../db/database.ts';
import { signJwt } from '../lib/jwt.ts';
import { Codes, fail, ok } from '../lib/errors.ts';
import {
  hashPassword,
  maskEmail,
  maskPhone,
  newId,
  newToken,
  newVerifyCode,
  safeEqual,
  sha256,
  verifyPassword,
} from '../lib/security.ts';
import * as v from '../lib/validate.ts';
import { VERIFY_CODE_RE } from '../../../packages/shared/src/validation.ts';

type Purpose = 'signup' | 'forgot_password';

// ---------- Truy vấn dùng chung ----------

function findUser(ctx: Ctx, id: v.Ident): UserRow | undefined {
  const col = id.kind === 'email' ? 'email' : 'phone';
  return ctx.db.prepare(`SELECT * FROM users WHERE ${col} = ?`).get(id.value) as UserRow | undefined;
}

const profile = (u: UserRow) => ({
  id: u.id,
  first_name: u.first_name,
  last_name: u.last_name,
  email: u.email,
  phone: u.phone,
});

const devicePayload = (d: DeviceRow | null) =>
  d && { device_id: d.id, device_type: d.device_type, device_name: d.device_name, camera_name: d.camera_name };

interface DeviceInput {
  client_device_id: string;
  device_type: 1 | 2 | 4;
  device_name: string;
}

function deviceInput(b: v.Body, required: boolean): DeviceInput | null {
  if (!required && b.device_id === undefined && b.device_type === undefined && b.device_name === undefined) return null;
  const client_device_id = v.str(b, 'device_id', { max: 100 });
  const device_type = v.int(b, 'device_type', 1, 4);
  if (![1, 2, 4].includes(device_type)) fail(Codes.PARAM_VALUE_INVALID, 'Invalid device_type', { field: 'device_type' });
  const device_name = v.str(b, 'device_name', { max: 60 });
  return { client_device_id, device_type: device_type as 1 | 2 | 4, device_name };
}

/** Đăng ký (hoặc cập nhật) thiết bị của tài khoản — gộp register_device vào login. */
function upsertDevice(ctx: Ctx, userId: string, d: DeviceInput): DeviceRow {
  const now = ctx.now();
  const existing = ctx.db
    .prepare('SELECT * FROM devices WHERE user_id = ? AND client_device_id = ?')
    .get(userId, d.client_device_id) as DeviceRow | undefined;
  if (existing) {
    ctx.db
      .prepare('UPDATE devices SET device_type = ?, device_name = ?, last_seen_at = ? WHERE id = ?')
      .run(d.device_type, d.device_name, now, existing.id);
    return { ...existing, device_type: d.device_type, device_name: d.device_name, last_seen_at: now };
  }
  const id = newId('dv', 8);
  const camera = d.device_name.slice(0, 30);
  ctx.db
    .prepare(
      `INSERT INTO devices (id, user_id, client_device_id, device_type, device_name, camera_name, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, d.client_device_id, d.device_type, d.device_name, camera, now, now);
  return ctx.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as unknown as DeviceRow;
}

/** access_token là JWT (claim `acc` = vai trò); refresh_token là chuỗi ngẫu nhiên dùng một lần. CSDL chỉ giữ hash. */
function issueTokens(ctx: Ctx, user: Pick<UserRow, 'id' | 'role'>, sessionId: string) {
  const iat = Math.floor(ctx.now() / 1000);
  const exp = iat + ctx.config.accessTtlSec;
  return {
    access: signJwt({ sub: user.id, acc: user.role, sid: sessionId, jti: newId('j', 12), iat, exp }, ctx.config.mediaSecret),
    refresh: newToken('rt'),
    accessExp: exp * 1000,
  };
}

function createSession(ctx: Ctx, user: Pick<UserRow, 'id' | 'role'>, deviceId: string | null) {
  const now = ctx.now();
  const sessionId = newId('ss', 12);
  const t = issueTokens(ctx, user, sessionId);
  ctx.db
    .prepare(
      `INSERT INTO sessions (id, user_id, device_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      user.id,
      deviceId,
      sha256(t.access),
      t.accessExp,
      sha256(t.refresh),
      now + ctx.config.refreshTtlSec * 1000,
      now,
    );
  return { access_token: t.access, refresh_token: t.refresh, expires_in: ctx.config.accessTtlSec };
}

/** Cấp cặp token mới cho phiên hiện có (refresh token cũ bị vô hiệu). */
function rotateSession(ctx: Ctx, sessionId: string, oldRefreshHash: string | null) {
  const user = ctx.db
    .prepare('SELECT u.id, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
    .get(sessionId) as unknown as Pick<UserRow, 'id' | 'role'>;
  const t = issueTokens(ctx, user, sessionId);
  ctx.db
    .prepare(
      `UPDATE sessions SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, prev_refresh_hash = COALESCE(?, prev_refresh_hash)
       WHERE id = ?`,
    )
    .run(sha256(t.access), t.accessExp, sha256(t.refresh), oldRefreshHash, sessionId);
  return { access_token: t.access, refresh_token: t.refresh, expires_in: ctx.config.accessTtlSec };
}

function loginPayload(user: UserRow, device: DeviceRow | null, tokens: ReturnType<typeof createSession>) {
  return {
    user: profile(user),
    account_role: user.role,
    ...tokens,
    device: devicePayload(device),
  };
}

/** Rời mọi phòng của thiết bị (khi đăng xuất / đổi mật khẩu). */
function leaveAllRooms(ctx: Ctx, where: { deviceId?: string; userId?: string }) {
  const now = ctx.now();
  if (where.deviceId)
    ctx.db
      .prepare(`UPDATE room_members SET left_at = ?, left_reason = 'logout' WHERE device_id = ? AND left_at IS NULL`)
      .run(now, where.deviceId);
  if (where.userId)
    ctx.db
      .prepare(`UPDATE room_members SET left_at = ?, left_reason = 'logout' WHERE user_id = ? AND left_at IS NULL`)
      .run(now, where.userId);
}

export function closeOwnerRooms(ctx: Ctx, ownerId: string) {
  const now = ctx.now();
  const rooms = ctx.db.prepare(`SELECT id FROM rooms WHERE owner_id = ? AND status = 'open'`).all(ownerId) as {
    id: string;
  }[];
  for (const r of rooms) {
    ctx.db.prepare(`UPDATE rooms SET status = 'closed', closed_at = ? WHERE id = ?`).run(now, r.id);
    ctx.db
      .prepare(`UPDATE recording_sessions SET status = 'stopped', stopped_at = ? WHERE room_id = ? AND status = 'recording'`)
      .run(now, r.id);
    ctx.db
      .prepare(`UPDATE room_members SET left_at = ?, left_reason = 'closed' WHERE room_id = ? AND left_at IS NULL`)
      .run(now, r.id);
  }
}

// ---------- Mã xác thực ----------

const codeHash = (userId: string, code: string) => sha256(`${userId}:${code}`);

function consumeVerifyCode(ctx: Ctx, user: UserRow, purpose: Purpose, code: string) {
  const row = ctx.db
    .prepare(
      `SELECT id, code_hash, expires_at, attempts FROM verify_codes
       WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    )
    .get(user.id, purpose) as { id: string; code_hash: string; expires_at: number; attempts: number } | undefined;
  if (!row || row.expires_at <= ctx.now()) return fail(Codes.VERIFY_CODE_INCORRECT, 'Code verify is expired');
  if (row.attempts >= ctx.config.verifyMaxAttempts)
    return fail(Codes.VERIFY_CODE_INCORRECT, 'Too many attempts, request a new code');
  if (!safeEqual(codeHash(user.id, code), row.code_hash)) {
    ctx.db.prepare('UPDATE verify_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return fail(Codes.VERIFY_CODE_INCORRECT);
  }
  ctx.db.prepare('UPDATE verify_codes SET consumed_at = ? WHERE id = ?').run(ctx.now(), row.id);
}

function purposeOf(b: v.Body): Purpose {
  const p = v.str(b, 'purpose', { max: 20 });
  if (p !== 'signup' && p !== 'forgot_password') return fail(Codes.PARAM_VALUE_INVALID, 'Invalid purpose', { field: 'purpose' });
  return p;
}

// ---------- Routes ----------

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;

  // 1. signup — luôn tạo tài khoản Remote
  app.post('/auth/signup', async (req) => {
    const b = v.asBody(req.body);
    const first_name = v.str(b, 'first_name', { max: 50 });
    const last_name = v.str(b, 'last_name', { max: 50 });
    const email = v.email(b);
    const phone = v.phone(b);
    const password = v.password(b);
    if (password === phone) fail(Codes.PARAM_VALUE_INVALID, 'Password must not equal phone', { field: 'password' });
    const hash = await hashPassword(password);
    const now = ctx.now();

    const userId = tx(db, () => {
      const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
      const byPhone = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) as UserRow | undefined;
      // Cho phép đăng ký lại nếu tài khoản cũ cùng email/phone chưa từng xác thực.
      const reusable = byEmail && !byEmail.active && (!byPhone || byPhone.id === byEmail.id) ? byEmail : undefined;
      if (!reusable && (byEmail || byPhone))
        fail(Codes.USER_EXISTED, undefined, { field: byEmail ? 'email' : 'phone' });
      if (reusable) {
        db.prepare(
          'UPDATE users SET first_name = ?, last_name = ?, phone = ?, password_hash = ?, updated_at = ? WHERE id = ?',
        ).run(first_name, last_name, phone, hash, now, reusable.id);
        return reusable.id;
      }
      const id = newId('u', 8);
      db.prepare(
        `INSERT INTO users (id, first_name, last_name, email, phone, password_hash, role, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'remote', 0, ?, ?)`,
      ).run(id, first_name, last_name, email, phone, hash, now, now);
      return id;
    });
    return ok({ user_id: userId, email, phone, account_role: 'remote', verify_required: '1' });
  });

  // 2. get_verify_code — dùng chung cho signup và forgot_password
  app.post('/auth/verify-code', async (req) => {
    const b = v.asBody(req.body);
    const ident = v.identifier(b);
    const purpose = purposeOf(b);
    const user = findUser(ctx, ident) ?? fail(Codes.USER_NOT_VALIDATED, 'User not found');
    if (purpose === 'signup' && user.active) fail(Codes.PARAM_VALUE_INVALID, 'Account is already active');
    if (purpose === 'forgot_password' && !user.active)
      fail(Codes.USER_NOT_VALIDATED, 'Account is not activated', { verify_required: '1' });

    const now = ctx.now();
    const last = db
      .prepare('SELECT created_at FROM verify_codes WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1')
      .get(user.id, purpose) as { created_at: number } | undefined;
    const wait = last ? Math.ceil((last.created_at + config.verifyResendSec * 1000 - now) / 1000) : 0;
    if (wait > 0) fail(Codes.LIMITED_ACCESS, undefined, { retry_after: wait });

    const code = newVerifyCode();
    tx(db, () => {
      db.prepare(
        'UPDATE verify_codes SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL',
      ).run(now, user.id, purpose);
      db.prepare(
        `INSERT INTO verify_codes (id, user_id, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(newId('vc', 10), user.id, purpose, codeHash(user.id, code), now + config.verifyTtlSec * 1000, now);
    });
    // Controller: KHÔNG trả mã qua API (nếu trả, ai gọi được API cũng chiếm được tài khoản).
    // Mã gửi email nếu có SMTP, đồng thời hiện trên màn hình server (máy Controller chính là server).
    const isController = user.role === 'controller';
    if (isController) ctx.showControllerCode?.(code);
    const returnCode = config.returnVerifyCode && !isController;
    let emailed = false;
    if (ctx.sender) {
      try {
        await ctx.sender.send({ target: user.email, purpose, code, expiresInSec: config.verifyTtlSec });
        emailed = true;
      } catch (e) {
        req.log.error(e);
      }
    }
    if (!emailed && !returnCode && !isController) {
      // Không có cách nào để người dùng nhận mã → cho gọi lại ngay thay vì bắt chờ 120 giây
      db.prepare('DELETE FROM verify_codes WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL').run(user.id, purpose);
      return fail(Codes.UNKNOWN_ERROR, 'Cannot deliver verification code');
    }
    return ok({
      expires_in: config.verifyTtlSec,
      resend_after: config.verifyResendSec,
      // Chưa có cổng SMS: có SMTP thì mã luôn đi qua email, kể cả khi nhập số điện thoại
      masked_target: emailed || ident.kind === 'email' ? maskEmail(user.email) : maskPhone(user.phone),
      ...(returnCode ? { code_verify: code } : {}),
    });
  });

  // 3. check_verify_code — kích hoạt tài khoản và trả token luôn
  app.post('/auth/verify-code/check', async (req) => {
    const b = v.asBody(req.body);
    const ident = v.identifier(b);
    const code = v.str(b, 'code_verify', { pattern: VERIFY_CODE_RE });
    const dev = deviceInput(b, false);
    const user = findUser(ctx, ident) ?? fail(Codes.USER_NOT_VALIDATED, 'User not found');
    if (user.active) fail(Codes.PARAM_VALUE_INVALID, 'Account is already active');
    consumeVerifyCode(ctx, user, 'signup', code);
    const payload = tx(db, () => {
      db.prepare('UPDATE users SET active = 1, updated_at = ? WHERE id = ?').run(ctx.now(), user.id);
      const device = dev ? upsertDevice(ctx, user.id, dev) : null;
      return loginPayload({ ...user, active: 1 }, device, createSession(ctx, user, device?.id ?? null));
    });
    return ok({ user_id: user.id, active: '1', ...payload });
  });

  // 4. login — đăng nhập + đăng ký thiết bị; không hủy phiên ở máy khác
  app.post('/auth/login', async (req) => {
    const b = v.asBody(req.body);
    const ident = v.identifier(b);
    const password = v.str(b, 'password', { trim: false, max: 128 });
    const dev = deviceInput(b, true)!;
    const user = findUser(ctx, ident);
    if (!user) return fail(Codes.USER_NOT_VALIDATED, 'User not found', { reason: 'not_found' });
    if (!(await verifyPassword(password, user.password_hash)))
      return fail(Codes.PARAM_VALUE_INVALID, 'Password is incorrect', { field: 'password' });
    if (!user.active)
      return fail(Codes.USER_NOT_VALIDATED, 'Account is not activated', { reason: 'not_verified', verify_required: '1' });
    if (user.locked) return fail(Codes.USER_NOT_VALIDATED, 'Account is locked', { reason: 'locked' });
    const payload = tx(db, () => {
      const device = upsertDevice(ctx, user.id, dev);
      return loginPayload(user, device, createSession(ctx, user, device.id));
    });
    return ok(payload);
  });

  // 5. refresh_token — rotation, phát hiện dùng lại
  app.post('/auth/refresh', async (req) => {
    const b = v.asBody(req.body);
    const hash = sha256(v.str(b, 'refresh_token', { max: 200 }));
    const now = ctx.now();
    const s = db
      .prepare('SELECT id, refresh_expires_at, revoked_at FROM sessions WHERE refresh_hash = ?')
      .get(hash) as { id: string; refresh_expires_at: number; revoked_at: number | null } | undefined;
    if (!s) {
      // Token cũ bị dùng lại → có thể bị lộ: thu hồi cả phiên.
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE prev_refresh_hash = ? AND revoked_at IS NULL').run(now, hash);
      return fail(Codes.TOKEN_INVALID);
    }
    if (s.revoked_at || s.refresh_expires_at <= now) return fail(Codes.TOKEN_INVALID);
    // Đề bài refresh_token: expires_in là chuỗi "3600"
    const t = rotateSession(ctx, s.id, hash);
    return ok({ ...t, expires_in: String(t.expires_in) });
  });

  // 6. forgot_password — đặt lại mật khẩu bằng mã xác thực
  app.post('/auth/password/forgot', async (req) => {
    const b = v.asBody(req.body);
    const ident = v.identifier(b);
    const code = v.str(b, 'code_verify', { pattern: VERIFY_CODE_RE });
    const newPassword = v.password(b, 'new_password');
    const user = findUser(ctx, ident) ?? fail(Codes.USER_NOT_VALIDATED, 'User not found');
    if (!user.active) fail(Codes.USER_NOT_VALIDATED, 'Account is not activated', { verify_required: '1' });
    if (newPassword === user.phone)
      fail(Codes.PARAM_VALUE_INVALID, 'Password must not equal phone', { field: 'new_password' });
    consumeVerifyCode(ctx, user, 'forgot_password', code);
    const hash = await hashPassword(newPassword);
    tx(db, () => {
      const now = ctx.now();
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now, user.id);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, user.id);
      leaveAllRooms(ctx, { userId: user.id });
    });
    return ok(null);
  });

  // 7. change_password — thu hồi phiên ở các máy khác, giữ phiên hiện tại
  app.put('/auth/password', async (req) => {
    const auth = authenticate(ctx, req);
    const b = v.asBody(req.body);
    const current = v.str(b, 'password', { trim: false, max: 128 });
    const next = v.password(b, 'new_password');
    if (!(await verifyPassword(current, auth.user.password_hash)))
      fail(Codes.PARAM_VALUE_INVALID, 'Password is incorrect', { field: 'password' });
    if (next === current) fail(Codes.PARAM_VALUE_INVALID, 'New password must differ', { field: 'new_password' });
    if (next === auth.user.phone) fail(Codes.PARAM_VALUE_INVALID, 'Password must not equal phone', { field: 'new_password' });
    const hash = await hashPassword(next);
    const tokens = tx(db, () => {
      const now = ctx.now();
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now, auth.user.id);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL').run(
        now,
        auth.user.id,
        auth.sessionId,
      );
      return rotateSession(ctx, auth.sessionId, null);
    });
    return ok(tokens);
  });

  // 8. logout — chỉ hủy phiên hiện tại
  app.post('/auth/logout', async (req) => {
    const auth = authenticate(ctx, req);
    tx(db, () => {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(ctx.now(), auth.sessionId);
      if (auth.user.role === 'controller') closeOwnerRooms(ctx, auth.user.id);
      else if (auth.device) leaveAllRooms(ctx, { deviceId: auth.device.id });
    });
    return ok(null);
  });

  // 9. delete_account — xóa vĩnh viễn tài khoản cùng toàn bộ video
  app.delete('/users/me', async (req) => {
    const auth = authenticate(ctx, req);
    const b = v.asBody(req.body);
    const password = v.str(b, 'password', { trim: false, max: 128 });
    if (auth.user.role === 'controller') fail(Codes.NOT_ACCESS, 'Controller account cannot be deleted');
    if (!(await verifyPassword(password, auth.user.password_hash)))
      fail(Codes.PARAM_VALUE_INVALID, 'Password is incorrect', { field: 'password' });
    const files = db
      .prepare('SELECT storage_path, thumbnail_path FROM videos WHERE owner_user_id = ?')
      .all(auth.user.id) as { storage_path: string; thumbnail_path: string | null }[];
    const uploads = db.prepare('SELECT id FROM upload_sessions WHERE user_id = ?').all(auth.user.id) as { id: string }[];
    db.prepare('DELETE FROM users WHERE id = ?').run(auth.user.id); // các bảng con xóa theo ON DELETE CASCADE
    for (const up of uploads) fs.rmSync(path.join(ctx.config.uploadDir, up.id), { recursive: true, force: true });
    for (const f of files)
      for (const p of [f.storage_path, f.thumbnail_path]) if (p) fs.rmSync(p, { force: true });
    return ok(null);
  });

  // Tiện ích: thông tin phiên hiện tại (dùng để khôi phục giao diện khi mở lại app)
  app.get('/users/me', async (req) => {
    const auth = authenticate(ctx, req);
    let roomId: string | null = null;
    if (auth.user.role === 'controller') {
      roomId =
        (db.prepare(`SELECT id FROM rooms WHERE owner_id = ? AND status = 'open'`).get(auth.user.id) as { id: string } | undefined)
          ?.id ?? null;
    } else if (auth.device) {
      roomId =
        (
          db.prepare('SELECT room_id FROM room_members WHERE device_id = ? AND left_at IS NULL').get(auth.device.id) as
            | { room_id: string }
            | undefined
        )?.room_id ?? null;
    }
    return ok({ user: profile(auth.user), account_role: auth.user.role, device: devicePayload(auth.device), room_id: roomId });
  });
}

/** Mật khẩu quá yếu, không được dùng. */
export const LEAKED_DEFAULT_PASSWORD = '12345678';

export function randomPassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 12 }, () => chars[crypto.randomInt(chars.length)]).join('');
}

export interface ControllerStatus {
  status: 'created' | 'exists';
  email: string;
  /** Mật khẩu vừa sinh ngẫu nhiên (khi .env để trống hoặc còn mật khẩu mẫu) */
  generated?: string;
  /** Đang dùng mật khẩu quá yếu */
  leaked: boolean;
}

/** Tạo tài khoản Controller duy nhất nếu chưa có (do nhà phát hành cấp sẵn). */
export async function ensureController(ctx: Ctx): Promise<ControllerStatus> {
  const existing = ctx.db.prepare(`SELECT email, password_hash FROM users WHERE role = 'controller'`).get() as
    | { email: string; password_hash: string }
    | undefined;
  if (existing)
    return { status: 'exists', email: existing.email, leaked: await verifyPassword(LEAKED_DEFAULT_PASSWORD, existing.password_hash) };
  const c = { ...ctx.config.controller };
  const generated = c.password && c.password !== LEAKED_DEFAULT_PASSWORD ? undefined : randomPassword();
  if (generated) c.password = generated;
  const now = ctx.now();
  ctx.db
    .prepare(
      `INSERT INTO users (id, first_name, last_name, email, phone, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'controller', 1, ?, ?)`,
    )
    .run(newId('u', 8), c.firstName, c.lastName, c.email, c.phone, await hashPassword(c.password), now, now);
  return { status: 'created', email: c.email, generated, leaked: false };
}

