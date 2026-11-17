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
