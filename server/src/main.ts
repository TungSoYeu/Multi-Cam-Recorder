import os from 'node:os';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/database.ts';
import { ensureController } from './modules/auth.ts';
import { cleanupExpiredUploads } from './modules/uploads.ts';
import { ffmpegAvailable } from './lib/media.ts';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const ctx = { db, config, now: Date.now };

const seeded = await ensureController(ctx);
const app = await buildApp(ctx, { logger: true });
await app.listen({ port: config.port, host: config.host });

const lan = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `http://${i!.address}:${config.port}`);

console.log(`
  Multi-Cam Recorder server
  - CSDL:        ${config.dbPath}
  - Controller:  ${config.controller.email} (${seeded === 'created' ? 'vừa tạo' : 'đã có'})
  - Local:       http://localhost:${config.port}        (giao diện Controller)
  - API:         http://localhost:${config.port}/api
  - ffmpeg:      ${ffmpegAvailable(config.ffmpegPath) ? 'có (remux MP4 + ảnh thu nhỏ)' : 'không có — video giữ nguyên file từ máy quay'}
  - LAN:         ${lan.join(', ') || '(không có)'}
  - 3G/4G:       chạy "cloudflared tunnel --url http://localhost:${config.port}" và dùng URL https://...trycloudflare.com
`);

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
