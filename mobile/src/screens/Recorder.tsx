import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import type { CameraFacing, DeviceCommand, RecordingState } from '@multicam/shared';
import { Button } from '../components/ui';
import { cameraState, clock, useCommandHandler } from '../sync';
import { colors } from '../theme';
import { formatDuration, saveRecording } from '../video/library';
import { kickUploads } from '../video/uploader';

const KEEP_AWAKE_TAG = 'recorder';
/** Máy lỡ lệnh Start: chờ thêm 1 giây sau giờ hẹn rồi mới tự bắt đầu theo trạng thái phòng. */
const LATE_START_GRACE_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Màn quay video.
 * - Quay độc lập (controlled = false): người dùng tự bấm quay/dừng.
 * - Trong phòng (controlled = true): Controller điều khiển bằng lệnh có hẹn giờ; nút quay trên máy bị khóa.
 *   Nếu lỡ lệnh, máy tự khớp theo `roomRecording` (trạng thái quay của phòng từ sync_device).
 */
export function Recorder({
  banner,
  roomId,
  footer,
  controlled = false,
  roomRecording = null,
}: {
  banner: ReactNode;
  roomId: string | null;
  footer?: ReactNode;
  controlled?: boolean;
  roomRecording?: RecordingState | null;
}) {
  const [camPerm, requestCam] = useCameraPermissions();
  const [micPerm, requestMic] = useMicrophonePermissions();
  const granted = !!camPerm?.granted && !!micPerm?.granted;
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const [facing, setFacing] = useState<CameraFacing>(cameraState.facing);
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  /** Phiên quay của phòng mà máy đang/đã quay — tránh bắt đầu lại cùng phiên */
  const sessionRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const startedAt = useRef(0);

  const markReady = (v: boolean) => {
    readyRef.current = v;
    setReady(v);
  };

  useEffect(() => {
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG);
      if (recordingRef.current) camera.current?.stopRecording();
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
    return () => clearInterval(t);
  }, [recording]);

  async function waitReady(timeoutMs = 3000) {
    const end = Date.now() + timeoutMs;
    while (!readyRef.current && Date.now() < end) await sleep(50);
    return readyRef.current;
  }

  /** Bắt đầu quay. Trả true nếu camera đã nhận lệnh quay. */
  function begin(sessionId: string | null): boolean {
    if (!camera.current || !readyRef.current || recordingRef.current) return false;
    recordingRef.current = true;
    cameraState.isRecording = true;
    sessionRef.current = sessionId;
    startedAt.current = Date.now();
    const startedAtServer = clock.serverNow();
    const facingAtStart = cameraState.facing;
    setElapsed(0);
    setMessage(null);
    setRecording(true);
    // iPhone: ép H.264 để file phát được trên mọi trình duyệt (HEVC không phát được trên Chrome/Windows)
    camera.current
      .recordAsync(Platform.OS === 'ios' ? { codec: 'avc1' } : {})
      .then(async (result) => {
        const durationMs = Date.now() - startedAt.current;
        recordingRef.current = false;
        cameraState.isRecording = false;
        setRecording(false);
        if (!result?.uri) return;
        setSaving(true);
        const clip = await saveRecording(result.uri, {
          startedAt: startedAt.current,
          durationMs,
          facing: facingAtStart,
          roomId,
          recordingSessionId: sessionId,
          startedAtServerMs: sessionId ? startedAtServer : null,
        });
        setMessage(`Đã lưu ${clip.file_name} · đang tải lên`);
        kickUploads(); // dừng quay là tự upload
      })
      .catch((e: unknown) => {
        setMessage(`Lỗi quay: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        recordingRef.current = false;
        cameraState.isRecording = false;
        setRecording(false);
        setSaving(false);
      });
    return true;
  }

  function end() {
    if (recordingRef.current) camera.current?.stopRecording();
  }

  function changeFacing(next: CameraFacing) {
    if (recordingRef.current || next === cameraState.facing) return;
    markReady(false);
    cameraState.facing = next;
    setFacing(next);
  }

  // ---------- Lệnh từ Controller ----------
  useCommandHandler(
    controlled && granted
      ? async (cmd: DeviceCommand) => {
          const wait = clock.toLocal(cmd.execute_at_ms) - Date.now();
          if (cmd.type === 'start_recording' && wait > 0) setMessage(`Bắt đầu quay sau ${Math.ceil(wait / 1000)} giây…`);
          if (wait > 0) await sleep(Math.min(wait, 10_000));
          switch (cmd.type) {
            case 'start_recording':
              if (recordingRef.current) return 'done';
              if (sessionRef.current === cmd.recording_session_id) return 'done';
              if (!(await waitReady())) return 'failed';
              return begin(cmd.recording_session_id ?? null) ? 'done' : 'failed';
            case 'stop_recording':
              end();
              return 'done';
            case 'switch_camera':
              if (recordingRef.current || !cmd.camera_facing) return 'failed';
              changeFacing(cmd.camera_facing);
              return 'done';
            default:
              return 'failed';
          }
        }
      : null,
  );

  // ---------- Tự khớp với trạng thái quay của phòng (máy lỡ lệnh / vào phòng muộn) ----------
  useEffect(() => {
    if (!controlled || !granted) return;
    const r = roomRecording;
    // Đã có lệnh dừng: máy đang quay phiên này dừng đúng giờ hẹn (phòng khi lỡ lệnh Stop)
    if (r?.stop_at_ms) {
      if (!recordingRef.current || sessionRef.current !== r.recording_session_id) return;
      const t = setTimeout(end, Math.max(0, clock.toLocal(r.stop_at_ms) - Date.now()));
      return () => clearTimeout(t);
    }
    if (r && !recordingRef.current && sessionRef.current !== r.recording_session_id) {
      const dueIn = clock.toLocal(r.started_at_ms + LATE_START_GRACE_MS) - Date.now();
      const t = setTimeout(() => {
        if (!recordingRef.current && sessionRef.current !== r.recording_session_id) {
          waitReady().then((ok) => ok && begin(r.recording_session_id));
        }
      }, Math.max(0, dueIn));
      return () => clearTimeout(t);
    }
    if (!r && recordingRef.current && sessionRef.current) end();
  }, [controlled, granted, roomRecording?.recording_session_id, roomRecording?.stop_at_ms]);

  if (!camPerm || !micPerm) return <View style={st.fill} />;
  if (!granted) {
    return (
      <View style={[st.fill, st.center]}>
        {banner}
        <Text style={st.permTitle}>Cần quyền camera và micro</Text>
        <Text style={st.permText}>Ứng dụng cần camera và micro để quay video có tiếng{controlled ? ' khi Controller ra lệnh' : ''}.</Text>
        <Button
          title="Cấp quyền"
          onPress={async () => {
            if (!camPerm.granted) await requestCam();
            if (!micPerm.granted) await requestMic();
          }}
          style={{ alignSelf: 'stretch', marginTop: 16 }}
        />
        {!camPerm.canAskAgain || !micPerm.canAskAgain ? (
          <Text style={st.permText}>Nếu không hiện hộp thoại, hãy bật quyền trong Cài đặt của điện thoại.</Text>
        ) : null}
      </View>
    );
  }

  const idleHint = controlled ? 'Chờ lệnh quay từ Controller' : `1080p · ${facing === 'back' ? 'Camera sau' : 'Camera trước'}`;
  return (
    <View style={st.fill}>
      <CameraView
        ref={camera}
        style={StyleSheet.absoluteFill}
        facing={facing}
        mode="video"
        videoQuality="1080p"
        mute={false}
        onCameraReady={() => markReady(true)}
        onMountError={(e) => Alert.alert('Lỗi camera', e.message)}
      />
      <View style={st.top}>{banner}</View>
      <View style={st.status}>
        {recording ? (
          <View style={st.recPill}>
            <View style={st.recDot} />
            <Text style={st.recText}>{formatDuration(elapsed)}</Text>
          </View>
        ) : (
          <Text style={st.hint}>{saving ? 'Đang lưu…' : message ?? idleHint}</Text>
        )}
      </View>
      <View style={st.controls}>
        <View style={st.side}>{footer}</View>
        <Pressable
          onPress={() => (recording ? end() : begin(null))}
          disabled={controlled || !ready || saving}
          style={[st.shutter, (controlled || !ready || saving) && { opacity: controlled ? 0.35 : 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel={controlled ? 'Controller điều khiển quay' : recording ? 'Dừng quay' : 'Bắt đầu quay'}
        >
          <View style={recording ? st.stopSquare : st.recCircle} />
        </Pressable>
        <View style={st.side}>
          <Pressable
            onPress={() => changeFacing(facing === 'back' ? 'front' : 'back')}
            disabled={recording}
            style={[st.roundBtn, recording && { opacity: 0.35 }]}
            accessibilityRole="button"
            accessibilityLabel="Đổi camera trước/sau"
          >
            <Text style={{ fontSize: 22 }}>🔄</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: colors.bg },
  permTitle: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 16 },
  permText: { color: colors.muted, textAlign: 'center', marginTop: 8, lineHeight: 20 },
  top: { position: 'absolute', top: 12, left: 12, right: 12 },
  status: { position: 'absolute', bottom: 132, left: 0, right: 0, alignItems: 'center' },
  hint: { color: '#fff', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, overflow: 'hidden', fontSize: 13 },
  recPill: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger },
  recText: { color: '#fff', fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  controls: { position: 'absolute', bottom: 24, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly' },
  side: { width: 90, alignItems: 'center' },
  shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  recCircle: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.danger },
  stopSquare: { width: 30, height: 30, borderRadius: 6, backgroundColor: colors.danger },
  roundBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
});
