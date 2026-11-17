import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  corsOrigin: string;
  webDist: string | null;
  returnVerifyCode: boolean;
  accessTtlSec: number;
  refreshTtlSec: number;
  verifyTtlSec: number;
  verifyResendSec: number;
  verifyMaxAttempts: number;
  inviteTtlSec: number;
  defaultMaxMembers: number;
  onlineWindowSec: number;
  /** Thư mục chứa mảnh upload tạm và video hoàn chỉnh */
  uploadDir: string;
  videoDir: string;
  maxVideoBytes: number;
  defaultChunkBytes: number;
  minChunkBytes: number;
  maxChunkBytes: number;
  uploadTtlSec: number;
  /** Đường dẫn ffmpeg để remux sang MP4 chuẩn; null = không dùng */
  ffmpegPath: string | null;
  controller: {
    email: string;
    phone: string;
    password: string;
    firstName: string;
    lastName: string;
  };
}

const env = process.env;
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  const base: Config = {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    dbPath: env.DB_PATH ?? path.join(dataDir, 'multicam.db'),
    corsOrigin: env.CORS_ORIGIN ?? '',
    webDist: path.resolve(import.meta.dirname, '../../web/dist'),
    returnVerifyCode: bool(env.RETURN_VERIFY_CODE, true),
    accessTtlSec: 3600,
    refreshTtlSec: 30 * 24 * 3600,
    verifyTtlSec: 300,
    verifyResendSec: 120,
    verifyMaxAttempts: 5,
    inviteTtlSec: 600,
    defaultMaxMembers: 8,
    onlineWindowSec: 15,
    uploadDir: path.join(dataDir, 'uploads'),
    videoDir: path.join(dataDir, 'videos'),
    maxVideoBytes: 1024 * 1024 * 1024, // 1 GB theo bảng mã 1006
    defaultChunkBytes: 5 * 1024 * 1024,
    minChunkBytes: 256 * 1024,
    maxChunkBytes: 8 * 1024 * 1024,
    uploadTtlSec: 24 * 3600,
    ffmpegPath: env.FFMPEG_PATH === 'none' ? null : (env.FFMPEG_PATH ?? 'ffmpeg'),
    controller: {
      email: (env.CONTROLLER_EMAIL ?? 'controller@multicam.local').toLowerCase(),
      phone: env.CONTROLLER_PHONE ?? '0900000000',
      password: env.CONTROLLER_PASSWORD ?? '',
      firstName: env.CONTROLLER_FIRST_NAME ?? 'Multicam',
      lastName: env.CONTROLLER_LAST_NAME ?? 'Controller',
    },
  };
  return { ...base, ...overrides };
}
