import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { ApiError } from '@multicam/shared';
import { api } from '../api';
import { QrScanner } from '../components/QrScanner';
import { Banner, Button, CodeInput, Field } from '../components/ui';
import { errText, useNav } from '../nav';
import { getPrefs, loadPrefs, setPrefs } from '../prefs';
import { useSync } from '../sync';
import { colors } from '../theme';
import { Recorder } from './Recorder';

const EXIT_TEXT = {
  kicked: 'Bạn đã bị Controller loại khỏi phòng. Thiết bị chuyển về chế độ quay độc lập.',
  closed: 'Phòng đã đóng. Thiết bị chuyển về chế độ quay độc lập.',
} as const;

export function RoomTab() {
  const sync = useSync();
  const [solo, setSolo] = useState(false);

  // 2005 / bị kick: ẩn banner đỏ và đưa máy về chế độ quay độc lập (theo bảng mã response)
  useEffect(() => {
    if (sync.exitReason) setSolo(true);
  }, [sync.exitReason]);

  if (!sync.ready)
    return (
      <View style={st.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );

  if (sync.room) {
    const room = sync.room;
    return (
      <Recorder
        roomId={room.room_id}
        controlled
        roomRecording={sync.recording}
        banner={
          <View>
            <View style={st.controlled}>
              <View style={st.liveDot} />
              <Text style={st.controlledText} numberOfLines={1}>
                Đang được điều khiển từ xa · {room.room_name}
              </Text>
            </View>
            {!sync.connected ? <Text style={st.offline}>Mất kết nối tới máy chủ, đang thử lại…</Text> : null}
          </View>
        }
        footer={<LeaveButton roomId={room.room_id} />}
      />
    );
  }

  if (solo)
    return (
      <Recorder
        roomId={null}
        banner={
          <View style={st.soloBanner}>
            <Text style={st.soloText}>
              {(sync.exitReason && EXIT_TEXT[sync.exitReason as keyof typeof EXIT_TEXT]) ||
                'Quay độc lập (không trong phòng)'}
            </Text>
          </View>
        }
        footer={
          <Pressable
            onPress={() => {
              sync.clearExitReason();
              setSolo(false);
            }}
            style={st.smallBtn}
            accessibilityRole="button"
          >
            <Text style={st.smallBtnText}>Vào phòng</Text>
          </Pressable>
        }
      />
    );

  return (
    <JoinRoom
      onJoined={async () => {
        sync.clearExitReason();
        await sync.refresh();
      }}
      onSolo={() => setSolo(true)}
    />
  );
}

function LeaveButton({ roomId }: { roomId: string }) {
  const sync = useSync();
  return (
    <Pressable
      style={st.smallBtn}
      accessibilityRole="button"
      onPress={() =>
        Alert.alert('Rời phòng?', 'Controller sẽ không điều khiển được thiết bị này nữa.', [
          { text: 'Hủy', style: 'cancel' },
          {
            text: 'Rời phòng',
            style: 'destructive',
            onPress: async () => {
              try {
                await api.leaveRoom(roomId);
                await sync.refresh();
              } catch (e) {
                Alert.alert('Lỗi', errText(e));
              }
            },
          },
        ])
      }
    >
      <Text style={[st.smallBtnText, { color: colors.danger }]}>Rời phòng</Text>
    </Pressable>
  );
}

// ---------------- Tham gia phòng ----------------
function JoinRoom({ onJoined, onSolo }: { onJoined: () => Promise<void>; onSolo: () => void }) {
  const nav = useNav();
  const [code, setCode] = useState('');
  const [cameraName, setCameraName] = useState(getPrefs().cameraName ?? nav.session?.device?.camera_name ?? 'Cam 01');
  useEffect(() => {
    loadPrefs().then((p) => p.cameraName && setCameraName(p.cameraName));
  }, []);
  const [consent, setConsent] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const join = useCallback(
    async (inviteCode: string) => {
      const device = nav.session?.device;
      if (inviteCode.length !== 6) return setError('Mã phòng gồm 6 ký tự');
      if (!cameraName.trim()) return setError('Nhập tên camera');
      if (!consent) return setError('Bạn cần đồng ý cấp quyền điều khiển quay cho Controller');
      if (!device) return setError('Thiết bị chưa được đăng ký, hãy đăng xuất và đăng nhập lại');
      setBusy(true);
      setError(null);
      const body = {
        invite_code: inviteCode,
        device_id: device.device_id,
        camera_name: cameraName.trim(),
        grant_control: true as const,
      };
      try {
        await api.joinRoom(body);
        void setPrefs({ cameraName: body.camera_name }).catch(() => undefined);
        await onJoined();
      } catch (e) {
        if (e instanceof ApiError && e.code === '2003') {
          const old = (e.data as { room_id?: string } | null)?.room_id;
          Alert.alert('Thiết bị đang ở phòng khác', 'Rời phòng cũ để vào phòng này?', [
            { text: 'Hủy', style: 'cancel' },
            {
              text: 'Rời và vào phòng mới',
              onPress: async () => {
                try {
                  if (old) await api.leaveRoom(old);
                  await api.joinRoom(body);
                  await onJoined();
                } catch (err) {
                  setError(errText(err));
                }
              },
            },
          ]);
        } else if (e instanceof ApiError && e.code === '2001') {
          setError('Mã mời không đúng hoặc đã hết hạn. Hãy xin mã mới từ Controller.');
          setCode('');
        } else setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [cameraName, consent, nav.session, onJoined],
  );

  return (
    <ScrollView contentContainerStyle={st.pad} keyboardShouldPersistTaps="handled">
      <Text style={st.h1}>Tham gia phòng</Text>
      <Text style={st.sub}>Nhập mã 6 ký tự hoặc quét mã QR hiển thị trên máy Controller.</Text>
      <CodeInput value={code} onChange={setCode} />
      <Button title="Quét mã QR" variant="secondary" onPress={() => setScanning(true)} style={{ marginVertical: 12 }} />
      <Field
        label="TÊN CAMERA (HIỂN THỊ TRÊN CONTROLLER)"
        value={cameraName}
        onChangeText={setCameraName}
        maxLength={30}
        autoCapitalize="words"
      />
      <View style={st.consent}>
        <Text style={st.consentText}>Cho phép Controller điều khiển quay trên thiết bị này (bắt buộc)</Text>
        <Switch
          value={consent}
          onValueChange={setConsent}
          trackColor={{ true: colors.accent, false: colors.border }}
          thumbColor="#fff"
        />
      </View>
      {error ? <Banner text={error} tone="error" /> : null}
      <Button
        title="Tham gia phòng"
        onPress={() => join(code)}
        loading={busy}
        disabled={code.length !== 6 || !consent}
      />
      <Button title="Quay độc lập" variant="ghost" onPress={onSolo} style={{ marginTop: 8 }} />
      <QrScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onCode={(c) => {
          setScanning(false);
          setCode(c);
          if (!consent) setError('Đã quét mã. Bật đồng ý cấp quyền điều khiển rồi bấm Tham gia phòng.');
        }}
      />
    </ScrollView>
  );
}

const st = StyleSheet.create({
  pad: { padding: 20, flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  h1: { color: colors.text, fontSize: 24, fontWeight: '700', marginBottom: 6 },
  sub: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 16 },
  consent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  consentText: { color: colors.text, flex: 1, fontSize: 14, lineHeight: 20 },
  controlled: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.danger,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#fff' },
  controlledText: { color: '#fff', fontWeight: '700', fontSize: 14, flex: 1 },
  offline: {
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.6)',
    marginTop: 6,
    padding: 6,
    borderRadius: 8,
    overflow: 'hidden',
    fontSize: 12,
    textAlign: 'center',
  },
  soloBanner: { backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14 },
  soloText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  smallBtn: { backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  smallBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});
