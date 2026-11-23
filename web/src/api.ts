import { createClient, type StoredSession } from '@multicam/shared';

const SESSION_KEY = 'multicam.session';
const DEVICE_KEY = 'multicam.device_id';

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

/** UUID v4. crypto.randomUUID chỉ có trên https/localhost, nên cần phương án cho http://<IP LAN>. */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UUID của trình duyệt này, sinh lần đầu chạy (device_id gửi trong login). */
export function clientDeviceId(): string {
  let id = read<string>(DEVICE_KEY);
  if (!id) {
    id = uuid();
    try {
      localStorage.setItem(DEVICE_KEY, JSON.stringify(id));
    } catch {
      /* chế độ riêng tư: dùng id tạm */
    }
  }
  return id;
}

export function browserName(): string {
  const ua = navigator.userAgent;
  const name = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Trình duyệt';
  return `${name} (Controller)`;
}

const listeners = new Set<() => void>();
export const onSessionExpired = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export const api = createClient({
  baseUrl: () => import.meta.env.VITE_API_URL || '/api',
  store: {
    async load() {
      return read<StoredSession>(SESSION_KEY);
    },
    async save(s) {
      try {
        if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
        else localStorage.removeItem(SESSION_KEY);
      } catch {
        /* bỏ qua */
      }
    },
  },
  onSessionExpired: () => listeners.forEach((fn) => fn()),
});
