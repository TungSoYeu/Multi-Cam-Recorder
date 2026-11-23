/** Quy tắc nhập liệu dùng chung cho client và server. */
export const PHONE_RE = /^0\d{9}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** 6–20 ký tự, chỉ chữ và số (không ký tự đặc biệt). */
export const PASSWORD_RE = /^[A-Za-z0-9]{6,20}$/;
export const INVITE_CODE_RE = /^[A-Z0-9]{6}$/;
export const VERIFY_CODE_RE = /^\d{6}$/;

export function passwordProblem(password: string, phone?: string): string | null {
  if (!PASSWORD_RE.test(password)) return 'Mật khẩu 6–20 ký tự, chỉ gồm chữ và số';
  if (phone && password === phone) return 'Mật khẩu không được trùng số điện thoại';
  return null;
}

export const isEmail = (v: string) => v.includes('@');
