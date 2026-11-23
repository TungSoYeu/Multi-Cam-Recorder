import * as SecureStore from 'expo-secure-store';
import { cameraState } from './cameraState';

export type Quality = '2160p' | '1080p' | '720p';
export const QUALITIES: { value: Quality; label: string }[] = [
  { value: '2160p', label: '4K' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
];
export const qualityLabel = (q: Quality) => QUALITIES.find((x) => x.value === q)!.label;

export interface Prefs {
  quality: Quality;
  /** Tên hiển thị trên máy Controller (null = tên thiết bị) */
  cameraName: string | null;
}

const KEY = 'multicam.prefs';
let prefs: Prefs = { quality: '1080p', cameraName: null };
let loaded = false;
const listeners = new Set<() => void>();

export async function loadPrefs(): Promise<Prefs> {
  if (!loaded) {
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      if (raw) prefs = { ...prefs, ...(JSON.parse(raw) as Partial<Prefs>) };
    } catch {
      /* dùng mặc định */
    }
    loaded = true;
    cameraState.resolution = qualityLabel(prefs.quality);
  }
  return prefs;
}

export const getPrefs = () => prefs;

export async function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  cameraState.resolution = qualityLabel(prefs.quality);
  listeners.forEach((fn) => fn());
  await SecureStore.setItemAsync(KEY, JSON.stringify(prefs));
}

export function subscribePrefs(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
