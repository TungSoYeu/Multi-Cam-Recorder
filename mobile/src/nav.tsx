import { createContext, useContext } from 'react';
import { ApiError, isEmail, type Identifier, type StoredSession, type VerifyPurpose } from '@multicam/shared';

export type Route =
  | { name: 'login'; notice?: string; identifier?: string }
  | { name: 'signup' }
  | {
      name: 'verify';
      ident: Identifier;
      purpose: VerifyPurpose;
      masked?: string;
      devCode?: string;
      retryAfter?: number;
    }
  | { name: 'forgot' }
  | { name: 'newPassword'; ident: Identifier; code: string }
  | { name: 'server' }
  | { name: 'home' }
  | { name: 'changePassword' }
  | { name: 'deleteAccount' };

export interface Nav {
  push(r: Route): void;
  pop(): void;
  reset(r: Route): void;
  session: StoredSession | null;
  /** Đọc lại phiên từ SecureStore (sau login / đổi mật khẩu). */
  reloadSession(): Promise<StoredSession | null>;
}

export const NavContext = createContext<Nav | null>(null);
export const useNav = () => useContext(NavContext)!;

export const toIdent = (s: string): Identifier => {
  const v = s.trim();
  return isEmail(v) ? { email: v.toLowerCase() } : { phone: v };
};

export const identText = (i: Identifier) => i.email ?? i.phone ?? '';

/** Câu báo lỗi tiếng Việt cho mọi loại lỗi. */
export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.uiMessage;
  if (e instanceof Error && e.message === 'Chưa cấu hình máy chủ') return 'Chưa cấu hình địa chỉ máy chủ';
  return 'Không thể kết nối Internet';
}

export const errField = (e: unknown) =>
  e instanceof ApiError ? ((e.data as { field?: string } | null)?.field ?? null) : null;
