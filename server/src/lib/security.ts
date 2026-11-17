import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(pw, Buffer.from(saltB64, 'base64url'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Token ngẫu nhiên (opaque), chỉ hash được lưu trong CSDL. */
export const newToken = (prefix: string) => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export function newId(prefix: string, len = 10): string {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${prefix}_${s}`;
}

/** Mã mời 6 ký tự, bỏ các ký tự dễ nhầm (0/O, 1/I). */
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newInviteCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  return s;
}

export const newVerifyCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function maskEmail(e: string): string {
  const [name, domain] = e.split('@');
  return `${name[0]}***@${domain}`;
}
export const maskPhone = (p: string) => `${p.slice(0, 3)}****${p.slice(-3)}`;
