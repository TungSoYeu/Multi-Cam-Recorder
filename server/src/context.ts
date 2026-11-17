import type { FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import type { DB } from './db/database.ts';
import { Codes, fail } from './lib/errors.ts';
import { sha256 } from './lib/security.ts';

export interface VerifyCodeSender {
  /** Gửi mã qua email/SMS. Ném lỗi nếu gửi thất bại. */
  send(input: { target: string; channel: 'email' | 'sms'; purpose: string; code: string }): Promise<void>;
}

export interface Ctx {
  db: DB;
  config: Config;
  now: () => number;
  sender?: VerifyCodeSender;
}

export interface UserRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  password_hash: string;
  role: 'controller' | 'remote';
  active: number;
  locked: number;
  created_at: number;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  client_device_id: string;
  device_type: 1 | 2 | 4;
  device_name: string;
  camera_name: string;
  last_seen_at: number | null;
}

export interface Auth {
  user: UserRow;
  sessionId: string;
  device: DeviceRow | null;
}

const TOUCH_INTERVAL_MS = 3000;

/** Xác thực Bearer access_token. Mọi lỗi token → 9998. */
export function authenticate(ctx: Ctx, req: FastifyRequest): Auth {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!m) return fail(Codes.TOKEN_INVALID);
  const s = ctx.db
    .prepare('SELECT id, user_id, device_id, access_expires_at, revoked_at FROM sessions WHERE access_hash = ?')
    .get(sha256(m[1])) as
    | { id: string; user_id: string; device_id: string | null; access_expires_at: number; revoked_at: number | null }
    | undefined;
  const now = ctx.now();
  if (!s || s.revoked_at || s.access_expires_at <= now) return fail(Codes.TOKEN_INVALID);
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) as UserRow | undefined;
  if (!user || user.locked) return fail(Codes.TOKEN_INVALID);
  let device: DeviceRow | null = null;
  if (s.device_id) {
    device = (ctx.db.prepare('SELECT * FROM devices WHERE id = ?').get(s.device_id) as DeviceRow | undefined) ?? null;
    if (device && (!device.last_seen_at || now - device.last_seen_at > TOUCH_INTERVAL_MS)) {
      ctx.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, device.id);
      device.last_seen_at = now;
    }
  }
  return { user, sessionId: s.id, device };
}

export const requireRole = (auth: Auth, role: UserRow['role']) => {
  if (auth.user.role !== role) fail(Codes.NOT_ACCESS);
};

export const iso = (ms: number) => new Date(ms).toISOString();
