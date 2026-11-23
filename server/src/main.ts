import os from 'node:os';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/database.ts';
import { ensureController } from './modules/auth.ts';
import { cleanupExpiredUploads } from './modules/uploads.ts';
import { ffmpegAvailable } from './lib/media.ts';
import { createMailer } from './lib/mailer.ts';
import type { Ctx } from './context.ts';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const sender = createMailer(process.env);
const ctx: Ctx = {
  db,
  config,
  now: Date.now,
  sender,
  showControllerCode: (code) => console.log(`\n  >>> Mã đặt lại mật khẩu Controller: ${code} (hiệu lực 5 phút)\n`),
};

const seeded = await ensureController(ctx);
const app = await buildApp(ctx, { logger: { level: process.env.LOG_LEVEL || 'info' } });
await app.listen({ port: config.port, host: config.host });

const lan = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `http://${i!.address}:${config.port}`);

console.log(`
  Multi-Cam Recorder server
  - CSDL:        ${config.dbPath}
  - Controller:  ${seeded.email} (${seeded.status === 'created' ? 'vừa tạo' : 'đã có'})
  - Email OTP:   ${sender ? 'gửi qua SMTP' : 'chưa cấu hình SMTP_URL, mã trả trong response'}
  - Local:       http://localhost:${config.port}        (giao diện Controller)
  - API:         http://localhost:${config.port}/api
  - ffmpeg:      ${ffmpegAvailable(config.ffmpegPath) ? 'có (remux MP4 + ảnh thu nhỏ)' : 'không có — video giữ nguyên file từ máy quay'}
  - LAN:         ${lan.join(', ') || '(không có)'}
  - 3G/4G:       chạy "cloudflared tunnel --url http://localhost:${config.port}" và dùng URL https://...trycloudflare.com
`);

if (seeded.generated) console.log(`  >>> Mật khẩu Controller (chỉ hiện lần này): ${seeded.generated}\n`);
if (seeded.weak) console.warn('  !!! Mật khẩu Controller quá yếu. Đổi bằng: npm run controller:password\n');

// Dọn phiên upload quá hạn mỗi 30 phút
cleanupExpiredUploads(ctx);
const cleanup = setInterval(() => cleanupExpiredUploads(ctx), 30 * 60 * 1000);
cleanup.unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
