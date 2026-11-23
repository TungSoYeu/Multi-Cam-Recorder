import crypto from 'node:crypto';

/** Nội dung access_token. `acc` = vai trò tài khoản, server chặn quyền dựa vào claim này (đề bài create_room). */
export interface AccessClaims {
  sub: string;
  acc: 'controller' | 'remote';
  sid: string;
  jti: string;
  iat: number;
  exp: number;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const HEADER = b64({ alg: 'HS256', typ: 'JWT' });
const mac = (data: string, secret: string) => crypto.createHmac('sha256', `jwt:${secret}`).update(data).digest('base64url');

export function signJwt(claims: AccessClaims, secret: string): string {
  const data = `${HEADER}.${b64(claims)}`;
  return `${data}.${mac(data, secret)}`;
}

/** Trả claims nếu chữ ký đúng (chỉ chấp nhận đúng header HS256 của server), ngược lại null. */
export function verifyJwt(token: string, secret: string): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  const expected = Buffer.from(mac(`${parts[0]}.${parts[1]}`, secret));
  const got = Buffer.from(parts[2]);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as AccessClaims;
    return typeof c.sub === 'string' && typeof c.exp === 'number' && (c.acc === 'controller' || c.acc === 'remote') ? c : null;
  } catch {
    return null;
  }
}
