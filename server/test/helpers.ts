import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Ctx } from '../src/context.ts';
import { openDatabase } from '../src/db/database.ts';
import { ensureController } from '../src/modules/auth.ts';

export const CONTROLLER = { email: 'boss@multicam.local', phone: '0900000000', password: 'Boss123456' };

export async function setup() {
  let clock = Date.parse('2026-08-03T14:25:30Z');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-test-'));
  const config = loadConfig({
    dbPath: ':memory:',
    dataDir: tmp,
    uploadDir: path.join(tmp, 'uploads'),
    videoDir: path.join(tmp, 'videos'),
    ffmpegPath: null,
    mediaSecret: 'test-secret-0123456789abcdef0123456789',
    defaultChunkBytes: 256 * 1024,
    webDist: null,
    returnVerifyCode: true,
    controller: { ...CONTROLLER, firstName: 'Boss', lastName: 'Controller' },
  });
  const ctx: Ctx = { db: openDatabase(':memory:'), config, now: () => clock };
  await ensureController(ctx);
  const app = await buildApp(ctx);
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  async function call(method: string, url: string, body?: unknown, token?: string) {
    const res = await app.inject({
      method: method as 'GET',
      url: `/api${url}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return res.json() as { code: string; message: string; data: any };
  }

  const advance = (sec: number) => {
    clock += sec * 1000;
  };

  let n = 0;
  /** Đăng ký + xác thực + đăng nhập một tài khoản Remote. */
  async function remote(name = `r${++n}`) {
    const i = ++n;
    const email = `${name}@test.vn`;
    const phone = `09${String(10000000 + i).slice(-8)}`;
    await call('POST', '/auth/signup', { first_name: 'An', last_name: 'Nguyen', email, phone, password: 'abc123' });
    const vc = await call('POST', '/auth/verify-code', { email, purpose: 'signup' });
    const r = await call('POST', '/auth/verify-code/check', {
      email,
      code_verify: vc.data.code_verify,
      device_id: `uuid-${name}`,
      device_type: 2,
      device_name: `iPhone ${name}`,
    });
    return { email, phone, token: r.data.access_token as string, refresh: r.data.refresh_token as string, device: r.data.device };
  }

  async function controller() {
    const r = await call('POST', '/auth/login', {
      email: CONTROLLER.email,
      password: CONTROLLER.password,
      device_id: 'web-1',
      device_type: 4,
      device_name: 'Chrome',
    });
    return r.data.access_token as string;
  }

  return { app, ctx, call, advance, remote, controller };
}
