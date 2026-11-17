import { spawn, spawnSync } from 'node:child_process';

const cache = new Map<string, boolean>();

/** ffmpeg có chạy được không (kiểm tra một lần, lưu kết quả). */
export function ffmpegAvailable(bin: string | null): bin is string {
  if (!bin) return false;
  if (!cache.has(bin)) {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    cache.set(bin, r.status === 0);
  }
  return cache.get(bin)!;
}

function run(bin: string, args: string[], timeoutMs = 120_000): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}

/**
 * Remux sang MP4 chuẩn, KHÔNG nén lại (-c copy): giữ nguyên chất lượng, chỉ đổi container.
 * +faststart đưa moov lên đầu để trình duyệt phát được ngay khi đang tải.
 * Chỉ lấy luồng hình và tiếng (bỏ luồng metadata riêng của iPhone mà MP4 không chứa được).
 */
export const remuxToMp4 = (bin: string, input: string, output: string) =>
  run(bin, ['-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output]);

/** Ảnh thu nhỏ rộng 480px lấy ở giây 0,5. */
export const makeThumbnail = (bin: string, input: string, output: string) =>
  run(bin, ['-y', '-v', 'error', '-ss', '0.5', '-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', output], 30_000);
