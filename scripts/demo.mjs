// Chạy toàn bộ phần demo bằng một lệnh:
//   npm run demo            → cùng mạng (Wi-Fi / hotspot 4G của điện thoại)
//   npm run demo:4g         → mỗi điện thoại dùng 4G riêng, đi qua Cloudflare Tunnel
// App tự nhận địa chỉ máy chủ, không phải gõ tay.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tunnel = process.argv.includes('--tunnel');
const PORT = Number(process.env.PORT ?? 3000);
const METRO = Number(process.env.METRO_PORT ?? 8081);
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const die = (msg) => {
  console.error(`\n  LỖI: ${msg}\n`);
  stop(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => {
  const c = spawn(cmd, args, { cwd: root, windowsHide: true, ...opts });
  children.push(c);
  c.on('error', (e) => die(`không chạy được ${cmd}: ${e.message}`));
  return c;
};

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
  });

async function healthy(base, timeoutMs) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) });
      if ((await r.json()).code === '1000') return true;
    } catch {
      /* chưa sẵn sàng */
    }
    await sleep(700);
  }
  return false;
}

/** IP LAN: ưu tiên Wi-Fi / hotspot, bỏ các card mạng ảo. */
function lanIp() {
  if (process.env.LAN_IP) return process.env.LAN_IP;
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter((i) => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map((i) => ({ name, ip: i.address })),
  );
  const real = all.filter((x) => !/vethernet|virtualbox|vmware|hyper-v|wsl|docker|tailscale|zerotier|radmin/i.test(x.name));
  const list = real.length ? real : all;
  return (list.find((x) => /wi-?fi|wlan|wireless/i.test(x.name)) ?? list[0])?.ip ?? null;
}

function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED_BIN,
    'cloudflared',
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);
  return candidates.find((c) => c.endsWith('.mjs') || spawnSync(c, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0);
}

function openTunnel(bin, port) {
  const args = ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`];
  const c = bin.endsWith('.mjs') ? run(process.execPath, [bin, ...args]) : run(bin, args);
  return new Promise((resolve) => {
    const onData = (d) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d));
      if (m) resolve(m[0]);
    };
    c.stdout.on('data', onData);
    c.stderr.on('data', onData);
    c.on('exit', () => resolve(null));
    setTimeout(() => resolve(null), 45_000);
  });
}

// ---------- 1. Kiểm tra ----------
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 24 || (maj === 24 && min < 3)) die(`cần Node 24.3 trở lên, máy đang có ${process.versions.node}`);
if (!fs.existsSync(path.join(root, 'node_modules', 'fastify'))) die('chưa cài thư viện. Chạy: npm install');
const envFile = path.join(root, 'server', '.env');
if (!fs.existsSync(envFile)) fs.copyFileSync(path.join(root, 'server', '.env.example'), envFile);
for (const p of [PORT, METRO]) if (!(await portFree(p))) die(`cổng ${p} đang bị chiếm. Tắt server/Metro cũ (Ctrl+C ở terminal cũ) rồi chạy lại.`);
const cf = tunnel ? findCloudflared() : null;
if (tunnel && !cf) die('chưa có cloudflared. Cài: winget install --id Cloudflare.cloudflared (rồi mở terminal mới)');

// ---------- 2. Build web + server ----------
console.log('  [1/4] Build giao diện Controller…');
const build = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'error'], {
  cwd: path.join(root, 'web'),
  stdio: 'inherit',
});
if (build.status !== 0) die('build web thất bại');

console.log('  [2/4] Chạy server…');
const server = run(process.execPath, ['--env-file-if-exists=.env', 'src/main.ts'], {
  cwd: path.join(root, 'server'),
  stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'warn' },
});
server.on('exit', () => die('server đã dừng'));
if (!(await healthy(`http://localhost:${PORT}`, 30_000))) die('server không phản hồi');

// ---------- 3. Địa chỉ cho điện thoại ----------
let publicBase;
const metroEnv = { ...process.env };
if (tunnel) {
  console.log('  [3/4] Mở 2 tunnel (API và Metro)…');
  const [api, metro] = await Promise.all([openTunnel(cf, PORT), openTunnel(cf, METRO)]);
  if (!api || !metro) die('không mở được tunnel (kiểm tra Internet của laptop)');
  publicBase = api;
  metroEnv.EXPO_PACKAGER_PROXY_URL = metro;
  if (!(await healthy(api, 60_000))) console.warn('  CẢNH BÁO: chưa gọi được server qua tunnel, thường do DNS chậm — đợi thêm 1 phút.');
} else {
  const ip = lanIp();
  if (!ip) die('laptop chưa nối mạng nào');
  publicBase = `http://${ip}:${PORT}`;
  metroEnv.REACT_NATIVE_PACKAGER_HOSTNAME = ip;
  console.log('  [3/4] Dùng mạng nội bộ');
}
metroEnv.EXPO_PUBLIC_API_URL = `${publicBase}/api`;

console.log(`
  ┌─────────────────────────────────────────────────────────────
  │  CONTROLLER (trình duyệt laptop):  http://localhost:${PORT}
  │  MÁY CHỦ cho điện thoại:           ${publicBase}
  │  Kiểm tra trên điện thoại:         ${publicBase}/api/health
  │
  │  Quét QR bên dưới bằng Camera iPhone / Expo Go (Android) để mở app Remote.
  │  App tự nhận địa chỉ máy chủ. Dừng tất cả: Ctrl+C
  └─────────────────────────────────────────────────────────────
`);

// ---------- 4. Metro ----------
console.log('  [4/4] Chạy Metro…');
const metro = run(process.execPath, [path.join(root, 'node_modules', 'expo', 'bin', 'cli'), 'start', '--go', '--clear', '--port', String(METRO)], {
  cwd: path.join(root, 'mobile'),
  stdio: 'inherit',
  env: metroEnv,
});
metro.on('exit', () => stop(0));
