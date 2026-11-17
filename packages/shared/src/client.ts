import { Codes, UiMessages } from './codes.ts';
import type * as T from './types.ts';

export class ApiError extends Error {
  readonly code: string;
  readonly data: unknown;
  constructor(code: string, message: string, data: unknown = null) {
    super(message);
    this.code = code;
    this.data = data;
  }
  /** Câu thông báo tiếng Việt cho người dùng. */
  get uiMessage(): string {
    return UiMessages[this.code] ?? this.message;
  }
}

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  account_role: T.AccountRole;
  user: T.UserProfile;
  device: T.SessionDevice | null;
}

export interface SessionStore {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession | null): Promise<void>;
}

export interface ClientOptions {
  /** Base URL của API, ví dụ https://xxx.trycloudflare.com/api */
  baseUrl: () => string | Promise<string>;
  store: SessionStore;
  /** Gọi khi refresh thất bại và phiên bị xóa (đưa người dùng về màn Đăng nhập). */
  onSessionExpired?: () => void;
  timeoutMs?: number;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export function createClient(opts: ClientOptions) {
  let session: StoredSession | null | undefined;
  let refreshing: Promise<boolean> | null = null;

  async function current() {
    if (session === undefined) session = await opts.store.load();
    return session;
  }

  async function setSession(next: StoredSession | null) {
    session = next;
    await opts.store.save(next);
  }

  async function raw<D>(method: Method, path: string, body?: unknown, token?: string): Promise<T.ApiEnvelope<D>> {
    const base = (await opts.baseUrl()).replace(/\/+$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => null)) as T.ApiEnvelope<D> | null;
      if (!json || typeof json.code !== 'string') throw new ApiError('NETWORK', `HTTP ${res.status}`);
      return json;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('NETWORK', 'Không thể kết nối Internet');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Thử refresh_token ĐÚNG MỘT LẦN; các request đồng thời dùng chung một lần refresh. */
  function refreshOnce(): Promise<boolean> {
    refreshing ??= (async () => {
      const s = await current();
      if (!s) return false;
      try {
        const r = await raw<T.TokenData>('POST', '/auth/refresh', { refresh_token: s.refresh_token });
        if (r.code !== Codes.OK) return false;
        await setSession({ ...s, access_token: r.data.access_token, refresh_token: r.data.refresh_token });
        return true;
      } catch (e) {
        // Lỗi mạng: không xóa phiên, để lần sau thử lại.
        if (e instanceof ApiError && e.code === 'NETWORK') throw e;
        return false;
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function call<D>(method: Method, path: string, body?: unknown, auth = true): Promise<D> {
    const token = auth ? (await current())?.access_token : undefined;
    if (auth && !token) throw new ApiError(Codes.TOKEN_INVALID, 'Token is invalid');
    let r = await raw<D>(method, path, body, token);
    if (auth && r.code === Codes.TOKEN_INVALID) {
      const before = token;
      const ok = (await current())?.access_token !== before || (await refreshOnce());
      if (!ok) {
        await setSession(null);
        opts.onSessionExpired?.();
        throw new ApiError(r.code, r.message);
      }
      r = await raw<D>(method, path, body, (await current())?.access_token);
    }
    if (r.code !== Codes.OK) throw new ApiError(r.code, r.message, r.data);
    return r.data;
  }

  async function startSession(d: T.LoginData) {
    await setSession({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      account_role: d.account_role,
      user: d.user,
      device: d.device,
    });
  }

  return {
    getSession: current,
    clearSession: () => setSession(null),

    health: () => call<{ status: string }>('GET', '/health', undefined, false),

    // A — Xác thực và tài khoản
    signup: (b: T.SignupRequest) => call<T.SignupData>('POST', '/auth/signup', b, false),
    getVerifyCode: (b: T.GetVerifyCodeRequest) => call<T.GetVerifyCodeData>('POST', '/auth/verify-code', b, false),
    async checkVerifyCode(b: T.CheckVerifyCodeRequest) {
      const d = await call<T.CheckVerifyCodeData>('POST', '/auth/verify-code/check', b, false);
      await startSession(d);
      return d;
    },
    async login(b: T.LoginRequest) {
      const d = await call<T.LoginData>('POST', '/auth/login', b, false);
      await startSession(d);
      return d;
    },
    forgotPassword: (b: T.ForgotPasswordRequest) => call<null>('POST', '/auth/password/forgot', b, false),
    async changePassword(b: T.ChangePasswordRequest) {
      const d = await call<T.TokenData>('PUT', '/auth/password', b);
      const s = await current();
      if (s) await setSession({ ...s, access_token: d.access_token, refresh_token: d.refresh_token });
      return d;
    },
    async logout() {
      try {
        await call<null>('POST', '/auth/logout', {});
      } finally {
        await setSession(null);
      }
    },
    async deleteAccount(password: string) {
      await call<null>('DELETE', '/users/me', { password });
      await setSession(null);
    },
    me: () => call<T.MeData>('GET', '/users/me'),

    // B — Phòng và ghép nối bằng mã mời
    createRoom: (b: T.CreateRoomRequest = {}) => call<T.RoomData>('POST', '/rooms', b),
    joinRoom: (b: T.JoinRoomRequest) => call<T.JoinRoomData>('POST', '/rooms/join', b),
    getRoomMembers: (roomId: string) =>
      call<T.RoomMembersData>('GET', `/rooms/${encodeURIComponent(roomId)}/members`),
    kickMember: (roomId: string, memberId: string) =>
      call<null>('DELETE', `/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}`),
    leaveRoom: (roomId: string) => call<null>('POST', `/rooms/${encodeURIComponent(roomId)}/leave`, {}),
    closeRoom: (roomId: string) => call<null>('DELETE', `/rooms/${encodeURIComponent(roomId)}`),

    // C — Đồng bộ trạng thái
    syncDevice: (deviceId: string, b: T.SyncDeviceRequest) =>
      call<T.SyncDeviceData>('POST', `/devices/${encodeURIComponent(deviceId)}/sync`, b),
    syncRoom: (roomId: string) => call<T.SyncRoomData>('GET', `/rooms/${encodeURIComponent(roomId)}/sync`),

    // Điều khiển quay. Mã 1010 (lệnh trùng do mạng chập chờn) được coi như thành công.
    startRecording: (roomId: string, clientCommandId: string) =>
      okIfDuplicate(call<T.CommandResult>('POST', `/rooms/${encodeURIComponent(roomId)}/recording/start`, { client_command_id: clientCommandId })),
    stopRecording: (roomId: string, clientCommandId: string) =>
      okIfDuplicate(call<T.CommandResult>('POST', `/rooms/${encodeURIComponent(roomId)}/recording/stop`, { client_command_id: clientCommandId })),
    switchCamera: (roomId: string, memberId: string, facing: T.CameraFacing, clientCommandId: string) =>
      okIfDuplicate(
        call<{ command_id: string }>(
          'POST',
          `/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}/camera`,
          { camera_facing: facing, client_command_id: clientCommandId },
        ),
      ),
  };
}

export type ApiClient = ReturnType<typeof createClient>;

/** 1010 = lệnh đã được thực hiện trước đó → trả lại kết quả cũ, KHÔNG gửi lại lệnh. */
async function okIfDuplicate<D>(p: Promise<D>): Promise<D> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && e.code === Codes.ACTION_DONE_PREVIOUSLY && e.data) return e.data as D;
    throw e;
  }
}

/** Ước lượng lệch đồng hồ client so với server từ các lần sync (giữ mẫu có độ trễ mạng thấp nhất). */
export class ClockSync {
  private best: { offset: number; rtt: number; at: number } | null = null;
  /** sentAt / receivedAt là giờ local (ms) lúc gửi và nhận response chứa serverMs. */
  sample(sentAt: number, receivedAt: number, serverMs: number) {
    const rtt = receivedAt - sentAt;
    const offset = serverMs - (sentAt + rtt / 2);
    const stale = !this.best || receivedAt - this.best.at > 60_000;
    if (stale || rtt <= this.best!.rtt * 1.2) this.best = { offset, rtt, at: receivedAt };
  }
  /** Lệch (ms): giờ server ≈ giờ local + offset */
  get offset() {
    return this.best?.offset ?? 0;
  }
  get rtt() {
    return this.best?.rtt ?? null;
  }
  /** Đổi giờ server sang giờ local */
  toLocal(serverMs: number) {
    return serverMs - this.offset;
  }
  serverNow() {
    return Date.now() + this.offset;
  }
}
