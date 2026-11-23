import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as Battery from 'expo-battery';
import { Paths } from 'expo-file-system';
import {
  ApiError,
  ClockSync,
  type CommandAck,
  type DeviceCommand,
  type LeftReason,
  type RecordingState,
  type SyncDeviceData,
} from '@multicam/shared';
import { api } from './api';
import { cameraState } from './cameraState';
import { useNav } from './nav';
import { liveUploadedBytes } from './video/liveUpload';
import { resumeUploads, uploadSummary } from './video/uploader';

export { cameraState };

/** Đồng hồ server ước lượng từ các lần sync — dùng để thực hiện lệnh đúng thời điểm hẹn. */
export const clock = new ClockSync();

export type CommandHandler = (cmd: DeviceCommand) => Promise<CommandAck['status']>;
let commandHandler: CommandHandler | null = null;

/** Màn quay đăng ký hàm thực thi lệnh (chỉ một màn tại một thời điểm). */
export function useCommandHandler(handler: CommandHandler | null) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!handler) return;
    const fn: CommandHandler = (c) => ref.current!(c);
    commandHandler = fn;
    return () => {
      if (commandHandler === fn) commandHandler = null;
    };
  }, [!!handler]);
}

export interface SyncInfo {
  room: SyncDeviceData['room'];
  /** Phòng đang quay (null nếu không) */
  recording: RecordingState | null;
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

/** Gọi sync_device định kỳ (server quyết định chu kỳ: 1 giây khi ở trong phòng) khi app đang mở. */
export function DeviceSyncProvider({ children }: { children: ReactNode }) {
  const nav = useNav();
  const deviceId = nav.session?.device?.device_id;
  const [room, setRoom] = useState<SyncDeviceData['room']>(null);
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [exitReason, setExitReason] = useState<LeftReason | null>(null);
  const [connected, setConnected] = useState(true);
  const [ready, setReady] = useState(false);
  const roomRef = useRef<string | null>(null);
  const intervalRef = useRef(1000);
  const busy = useRef(false);
  const again = useRef(false);
  const seen = useRef(new Set<string>());
  const acks = useRef<CommandAck[]>([]);

  const tick = useCallback(async (): Promise<void> => {
    if (!deviceId) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    const sending = acks.current.splice(0);
    try {
      const up = await uploadSummary().catch(() => null);
      const battery = await readBattery();
      const storage = readFreeStorage();
      const live = liveUploadedBytes();
      // Đo thời gian NGAY trước khi gửi: tính cả lúc đọc pin sẽ làm lệch phép bù đồng hồ
      const sentAt = Date.now();
      const d = await api.syncDevice(deviceId, {
        camera_facing: cameraState.facing,
        is_recording: cameraState.isRecording,
        battery_level: battery,
        free_storage_bytes: storage,
        resolution: cameraState.resolution,
        fps: cameraState.fps,
        ...(up ? { uploads_pending: up.pending, ...(up.progress !== null ? { upload_progress: up.progress } : {}) } : {}),
        ...(live !== null ? { live_uploaded_bytes: live } : {}),
        ...(sending.length ? { acks: sending } : {}),
      });
      clock.sample(sentAt, Date.now(), d.server_time_ms);
      intervalRef.current = d.interval_ms || 1000;
      const prev = roomRef.current;
      roomRef.current = d.room?.room_id ?? null;
      if (prev && !d.room && (d.last_left_reason === 'kicked' || d.last_left_reason === 'closed')) setExitReason(d.last_left_reason);
      if (!d.room) seen.current.clear();
      setRoom(d.room);
      setRecording(d.recording);
      setConnected(true);
      setReady(true);

      for (const cmd of d.commands) {
        if (seen.current.has(cmd.command_id) || !commandHandler) continue;
        seen.current.add(cmd.command_id);
        commandHandler(cmd)
          .catch(() => 'failed' as const)
          .then((status) => {
            acks.current.push({ command_id: cmd.command_id, status });
            tick(); // báo ACK ngay để Controller thấy
          });
      }
    } catch (e) {
      acks.current.unshift(...sending); // gửi lại ACK ở lần sau
      if (e instanceof ApiError && e.code === 'NETWORK') setConnected(false);
      setReady(true);
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        tick();
      }
    }
  }, [deviceId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = AppState.currentState === 'active';
    let stopped = false;
    const loop = async () => {
      if (active) await tick();
      if (!stopped) timer = setTimeout(loop, intervalRef.current);
    };
    loop();
    // Mở app / quay lại app: chạy tiếp các upload đang dở hoặc bị tạm dừng
    resumeUploads();
    const sub = AppState.addEventListener('change', (s) => {
      const wasActive = active;
      active = s === 'active';
      if (active) tick();
      if (active && !wasActive) resumeUploads();
    });
    return () => {
      stopped = true;
      clearTimeout(timer);
      sub.remove();
    };
  }, [tick]);

  const value: SyncInfo = {
    room,
    recording,
    exitReason,
    clearExitReason: () => setExitReason(null),
    connected,
    ready,
    refresh: tick,
  };
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
