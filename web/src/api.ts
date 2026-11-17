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

/** UUID của trình duyệt này, sinh lần đầu chạy (device_id gửi trong login). */
export function clientDeviceId(): string {
  let id = read<string>(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
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
  const name = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Trình duyệt';
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
