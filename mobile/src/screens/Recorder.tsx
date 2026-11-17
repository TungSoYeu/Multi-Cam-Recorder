import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import type { CameraFacing } from '@multicam/shared';
import { Button } from '../components/ui';
import { cameraState } from '../sync';
import { colors } from '../theme';
import { formatDuration, saveRecording } from '../video/library';

const KEEP_AWAKE_TAG = 'recorder';

/**
 * Màn quay video. Tuần 2: người dùng tự bấm quay/dừng trên máy.
 * Tuần 3: lệnh Start/Stop/đổi camera từ Controller sẽ gọi cùng các hàm start()/stop()/flip().
 */
export function Recorder({ banner, roomId, footer }: { banner: ReactNode; roomId: string | null; footer?: ReactNode }) {
  const [camPerm, requestCam] = useCameraPermissions();
  const [micPerm, requestMic] = useMicrophonePermissions();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<CameraFacing>(cameraState.facing);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG);
      if (cameraState.isRecording) camera.current?.stopRecording();
      cameraState.isRecording = false;
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
    return () => clearInterval(t);
  }, [recording]);

  async function start() {
    if (!camera.current || !ready || recording || saving) return;
    startedAt.current = Date.now();
    setElapsed(0);
    setLastSaved(null);
    setRecording(true);
    cameraState.isRecording = true;
    const facingAtStart = facing;
    try {
      // iPhone: ép H.264 để file phát được trên mọi trình duyệt (HEVC không phát được trên Chrome/Windows)
      const result = await camera.current.recordAsync(Platform.OS === 'ios' ? { codec: 'avc1' } : {});
      const durationMs = Date.now() - startedAt.current;
      setRecording(false);
      cameraState.isRecording = false;
      if (!result?.uri) return;
      setSaving(true);
      const clip = await saveRecording(result.uri, { startedAt: startedAt.current, durationMs, facing: facingAtStart, roomId });
      setLastSaved(`Đã lưu ${clip.file_name}`);
    } catch (e) {
      Alert.alert('Không quay được', e instanceof Error ? e.message : String(e));
    } finally {
      setRecording(false);
      setSaving(false);
      cameraState.isRecording = false;
    }
  }

  function stop() {
    if (recording) camera.current?.stopRecording();
  }

  function flip() {
    if (recording) return;
    const next = facing === 'back' ? 'front' : 'back';
    setReady(false);
    setFacing(next);
    cameraState.facing = next;
  }

  if (!camPerm || !micPerm) return <View style={st.fill} />;
  if (!camPerm.granted || !micPerm.granted) {
    return (
      <View style={[st.fill, st.center]}>
        {banner}
        <Text style={st.permTitle}>Cần quyền camera và micro</Text>
        <Text style={st.permText}>Ứng dụng cần camera và micro để quay video có tiếng.</Text>
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

  return (
    <View style={st.fill}>
      <CameraView
        ref={camera}
        style={StyleSheet.absoluteFill}
        facing={facing}
        mode="video"
        videoQuality="1080p"
        mute={false}
        onCameraReady={() => setReady(true)}
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
          <Text style={st.hint}>{saving ? 'Đang lưu…' : lastSaved ?? `1080p · ${facing === 'back' ? 'Camera sau' : 'Camera trước'}`}</Text>
        )}
      </View>
      <View style={st.controls}>
        <View style={st.side}>{footer}</View>
        <Pressable
          onPress={recording ? stop : start}
          disabled={!ready || saving}
          style={[st.shutter, (!ready || saving) && { opacity: 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel={recording ? 'Dừng quay' : 'Bắt đầu quay'}
        >
          <View style={recording ? st.stopSquare : st.recCircle} />
        </Pressable>
        <View style={st.side}>
          <Pressable
            onPress={flip}
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
