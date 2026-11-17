import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { fetch as expoFetch } from 'expo/fetch';
import { createClient, type DeviceInfo, type StoredSession } from '@multicam/shared';

const SESSION_KEY = 'multicam.session';
const DEVICE_KEY = 'multicam.device_id';
const SERVER_KEY = 'multicam.server_url';

const DEFAULT_SERVER = process.env.EXPO_PUBLIC_API_URL ?? '';

let serverUrl: string | null = null;

/** Chuẩn hóa địa chỉ máy chủ: thêm http(s):// và hậu tố /api nếu thiếu. */
export function normalizeServer(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) return '';
  // IP LAN / localhost → http; tên miền (trycloudflare, ngrok, VPS) → https
  if (!/^https?:\/\//i.test(s)) s = (/^(\d|localhost)/i.test(s) ? 'http://' : 'https://') + s;
  if (!/\/api$/i.test(s)) s += '/api';
  return s;
}

export async function getServerUrl(): Promise<string> {
  if (serverUrl === null) serverUrl = (await SecureStore.getItemAsync(SERVER_KEY)) ?? normalizeServer(DEFAULT_SERVER);
  return serverUrl;
}

export async function setServerUrl(url: string) {
  serverUrl = normalizeServer(url);
  await SecureStore.setItemAsync(SERVER_KEY, serverUrl);
}

/** Thông tin thiết bị gửi trong login: UUID sinh ở client lần đầu chạy. */
export async function deviceInfo(): Promise<DeviceInfo> {
  let id = await SecureStore.getItemAsync(DEVICE_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_KEY, id);
  }
  const consts = Platform.constants as { Model?: string; Brand?: string };
  const device_name =
    Platform.OS === 'ios'
      ? Platform.isPad
        ? 'iPad'
        : 'iPhone'
      : [consts.Brand, consts.Model].filter(Boolean).join(' ') || 'Android';
  return { device_id: id, device_type: Platform.OS === 'ios' ? 2 : 1, device_name };
}

const listeners = new Set<() => void>();
export function onSessionExpired(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Token lưu trong Keychain (iOS) / Keystore (Android) qua SecureStore. */
export const api = createClient({
  baseUrl: async () => {
    const url = await getServerUrl();
    if (!url) throw new Error('Chưa cấu hình máy chủ');
    return url;
  },
  store: {
    async load() {
      const raw = await SecureStore.getItemAsync(SESSION_KEY);
      try {
        return raw ? (JSON.parse(raw) as StoredSession) : null;
      } catch {
        return null;
      }
    },
    async save(s) {
      if (s) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s));
      else await SecureStore.deleteItemAsync(SESSION_KEY);
    },
  },
  onSessionExpired: () => listeners.forEach((fn) => fn()),
  // fetch mặc định của React Native không gửi được Uint8Array → dùng fetch native của Expo cho upload mảnh
  binaryFetch: expoFetch as unknown as typeof fetch,
});
