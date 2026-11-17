import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as Battery from 'expo-battery';
import { Paths } from 'expo-file-system';
import { ApiError, type CameraFacing, type LeftReason, type SyncDeviceData } from '@multicam/shared';
import { api } from './api';
import { useNav } from './nav';

/** Trạng thái camera hiện tại — màn quay cập nhật, vòng sync đọc và gửi lên server. */
export const cameraState = {
  facing: 'back' as CameraFacing,
  isRecording: false,
  resolution: '1080p',
  fps: 30,
};

export interface SyncInfo {
  room: SyncDeviceData['room'];
  /** Lý do vừa rời phòng (bị kick / phòng đóng) — hiển thị một lần */
  exitReason: LeftReason | null;
  clearExitReason(): void;
  connected: boolean;
  /** true sau lần sync đầu tiên */
  ready: boolean;
  /** Đồng bộ ngay (sau khi join / rời phòng) */
  refresh(): Promise<void>;
}

const SyncContext = createContext<SyncInfo | null>(null);
export const useSync = () => useContext(SyncContext)!;

async function readBattery(): Promise<number | undefined> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    return level < 0 ? -1 : Math.round(level * 100);
  } catch {
    return undefined;
  }
}

function readFreeStorage(): number | undefined {
  try {
    return Math.floor(Paths.availableDiskSpace);
  } catch {
    return undefined;
  }
}

/** Gọi sync_device định kỳ (mặc định 2 giây) khi app đang mở. */
export function DeviceSyncProvider({ children }: { children: ReactNode }) {
  const nav = useNav();
  const deviceId = nav.session?.device?.device_id;
  const [room, setRoom] = useState<SyncDeviceData['room']>(null);
  const [exitReason, setExitReason] = useState<LeftReason | null>(null);
  const [connected, setConnected] = useState(true);
  const [ready, setReady] = useState(false);
  const roomRef = useRef<string | null>(null);
  const intervalRef = useRef(2000);
  const busy = useRef(false);

  const tick = useCallback(async () => {
    if (!deviceId || busy.current) return;
    busy.current = true;
    try {
      const d = await api.syncDevice(deviceId, {
        camera_facing: cameraState.facing,
        is_recording: cameraState.isRecording,
        battery_level: await readBattery(),
        free_storage_bytes: readFreeStorage(),
        resolution: cameraState.resolution,
        fps: cameraState.fps,
      });
      intervalRef.current = d.interval_ms || 2000;
      const prev = roomRef.current;
      roomRef.current = d.room?.room_id ?? null;
      if (prev && !d.room && (d.last_left_reason === 'kicked' || d.last_left_reason === 'closed')) setExitReason(d.last_left_reason);
      setRoom(d.room);
      setConnected(true);
      setReady(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NETWORK') setConnected(false);
      setReady(true);
    } finally {
      busy.current = false;
    }
  }, [deviceId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = AppState.currentState === 'active';
    const loop = async () => {
      if (active) await tick();
      timer = setTimeout(loop, intervalRef.current);
    };
    loop();
    const sub = AppState.addEventListener('change', (s) => {
      active = s === 'active';
      if (active) tick();
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [tick]);

  const value: SyncInfo = {
    room,
    exitReason,
    clearExitReason: () => setExitReason(null),
    connected,
    ready,
    refresh: tick,
  };
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
