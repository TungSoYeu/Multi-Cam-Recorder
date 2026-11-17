import { Codes, fail } from './errors.ts';
import { EMAIL_RE, PHONE_RE, PASSWORD_RE } from '../../../packages/shared/src/validation.ts';

export type Body = Record<string, unknown>;

export function asBody(v: unknown): Body {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) fail(Codes.PARAM_TYPE_INVALID, 'Body must be a JSON object');
  return v as Body;
}

const missing = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

interface StrOpts {
  min?: number;
  max?: number;
  pattern?: RegExp;
  trim?: boolean;
}

/** Chuỗi bắt buộc: thiếu → 1002, sai kiểu → 1003, sai giá trị → 1004. */
export function str(b: Body, name: string, o: StrOpts = {}): string {
  const v = b[name];
  if (missing(v)) fail(Codes.PARAM_NOT_ENOUGH, `Missing ${name}`, { field: name });
  if (typeof v !== 'string') return fail(Codes.PARAM_TYPE_INVALID, `${name} must be a string`, { field: name });
  const s = o.trim === false ? v : v.trim();
  const { min = 1, max = 200, pattern } = o;
  if (s.length < min || s.length > max || (pattern && !pattern.test(s)))
    fail(Codes.PARAM_VALUE_INVALID, `Invalid ${name}`, { field: name });
  return s;
}

export function optStr(b: Body, name: string, o: StrOpts = {}): string | undefined {
  return missing(b[name]) ? undefined : str(b, name, o);
}

/** Số nguyên (chấp nhận cả dạng chuỗi "8" như slide). */
export function optInt(b: Body, name: string, min: number, max: number): number | undefined {
  const v = b[name];
  if (missing(v)) return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (Number.isNaN(n)) fail(Codes.PARAM_TYPE_INVALID, `${name} must be an integer`, { field: name });
  if (!Number.isInteger(n) || n < min || n > max) fail(Codes.PARAM_VALUE_INVALID, `Invalid ${name}`, { field: name });
  return n;
}

export function int(b: Body, name: string, min: number, max: number): number {
  const n = optInt(b, name, min, max);
  if (n === undefined) fail(Codes.PARAM_NOT_ENOUGH, `Missing ${name}`, { field: name });
  return n as number;
}

/** Boolean: chấp nhận true / "true" / 1 / "1". */
export function bool(b: Body, name: string): boolean {
  const v = b[name];
  if (missing(v)) fail(Codes.PARAM_NOT_ENOUGH, `Missing ${name}`, { field: name });
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return fail(Codes.PARAM_TYPE_INVALID, `${name} must be a boolean`, { field: name });
}

export const email = (b: Body, name = 'email') => str(b, name, { max: 120, pattern: EMAIL_RE }).toLowerCase();
export const phone = (b: Body, name = 'phone') => str(b, name, { pattern: PHONE_RE });
export const password = (b: Body, name = 'password') => str(b, name, { trim: false, pattern: PASSWORD_RE, min: 6, max: 20 });

export type Ident = { kind: 'email'; value: string } | { kind: 'phone'; value: string };

/** Định danh: email HOẶC phone (slide ghi "email/phone"). */
export function identifier(b: Body): Ident {
  if (!missing(b.email)) return { kind: 'email', value: email(b) };
  if (!missing(b.phone)) return { kind: 'phone', value: phone(b) };
  return fail(Codes.PARAM_NOT_ENOUGH, 'Missing email or phone', { field: 'email' });
}
