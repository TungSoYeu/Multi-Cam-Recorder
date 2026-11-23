import { createClient, type StoredSession } from '@multicam/shared';

/** Điều khiển "mạng" trong test: tắt mạng, làm hỏng vài lần gửi, ghi lại chỉ số mảnh đã gửi. */
export const net = { base: '', online: true, puts: [] as string[], failPuts: 0 };

let s: StoredSession | null = null;
export const api = createClient({
  baseUrl: () => net.base,
  store: {
    load: async () => s,
    save: async (x) => {
      s = x;
    },
  },
  timeoutMs: 3000,
  binaryFetch: (async (url: string, init: RequestInit) => {
    if (!net.online) throw new TypeError('offline');
    if (net.failPuts > 0) {
      net.failPuts--;
      throw new TypeError('lỗi mạng');
    }
    net.puts.push(String(url).split('/').pop()!);
    return fetch(url, init);
  }) as typeof fetch,
});
