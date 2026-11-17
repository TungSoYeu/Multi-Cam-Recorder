import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Switch, Text, View } from 'react-native';
import { ApiError, type RoomMember } from '@multicam/shared';
import { api } from '../api';
import { QrScanner } from '../components/QrScanner';
import { Banner, Button, CodeInput, Field } from '../components/ui';
import { errText, useNav } from '../nav';
import { colors } from '../theme';

const POLL_MS = 3000;

export function RoomTab() {
  const [roomId, setRoomId] = useState<string | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  // Khôi phục trạng thái phòng khi mở lại app
  useEffect(() => {
    api
      .me()
      .then((d) => setRoomId(d.room_id))
      .catch(() => setRoomId(null));
  }, []);

  if (roomId === undefined)
    return (
      <View style={st.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  if (roomId)
    return (
      <InRoom
        roomId={roomId}
        onExit={(msg) => {
          setNotice(msg);
          setRoomId(null);
        }}
      />
    );
  return (
    <JoinRoom
      notice={notice}
      onJoined={(id) => {
        setNotice(null);
        setRoomId(id);
      }}
    />
  );
}

// ---------------- Tham gia phòng ----------------
function JoinRoom({ notice, onJoined }: { notice: string | null; onJoined: (roomId: string) => void }) {
  const nav = useNav();
  const [code, setCode] = useState('');
  const [cameraName, setCameraName] = useState(nav.session?.device?.camera_name ?? 'Cam 01');
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
      const body = { invite_code: inviteCode, device_id: device.device_id, camera_name: cameraName.trim(), grant_control: true as const };
      try {
        const r = await api.joinRoom(body);
        onJoined(r.room_id);
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
                  const r = await api.joinRoom(body);
                  onJoined(r.room_id);
                } catch (err) {
                  setError(errText(err));
                }
              },
            },
          ]);
        } else {
          setError(e instanceof ApiError && e.code === '2001' ? 'Mã mời không đúng hoặc đã hết hạn. Hãy xin mã mới từ Controller.' : errText(e));
          if (e instanceof ApiError && e.code === '2001') setCode('');
        }
      } finally {
        setBusy(false);
      }
    },
    [cameraName, consent, nav.session, onJoined],
  );

  return (
    <View style={st.pad}>
      <Text style={st.h1}>Tham gia phòng</Text>
      <Text style={st.sub}>Nhập mã 6 ký tự hoặc quét mã QR hiển thị trên máy Controller.</Text>
      {notice ? <Banner text={notice} /> : null}
      <CodeInput value={code} onChange={setCode} />
      <Button title="Quét mã QR" variant="secondary" onPress={() => setScanning(true)} style={{ marginVertical: 12 }} />
      <Field label="TÊN CAMERA (HIỂN THỊ TRÊN CONTROLLER)" value={cameraName} onChangeText={setCameraName} maxLength={30} autoCapitalize="words" />
      <View style={st.consent}>
        <Text style={st.consentText}>Cho phép Controller điều khiển quay trên thiết bị này (bắt buộc)</Text>
        <Switch value={consent} onValueChange={setConsent} trackColor={{ true: colors.accent, false: colors.border }} thumbColor="#fff" />
      </View>
      {error ? <Banner text={error} tone="error" /> : null}
      <Button title="Tham gia phòng" onPress={() => join(code)} loading={busy} disabled={code.length !== 6 || !consent} />
      <QrScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onCode={(c) => {
          setScanning(false);
          setCode(c);
          if (!consent) setError('Đã quét mã. Bật đồng ý cấp quyền điều khiển rồi bấm Tham gia phòng.');
        }}
      />
    </View>
  );
}

// ---------------- Đang ở trong phòng ----------------
function InRoom({ roomId, onExit }: { roomId: string; onExit: (msg: string | null) => void }) {
  const nav = useNav();
  const [roomName, setRoomName] = useState('');
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [offline, setOffline] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const myDevice = nav.session?.device?.device_id;

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const d = await api.getRoomMembers(roomId);
        if (stop) return;
        setRoomName(d.room_name);
        setMembers(d.members);
        setOffline(false);
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiError && e.code === '2005') onExit('Phòng đã đóng. Thiết bị chuyển về chế độ độc lập.');
        else if (e instanceof ApiError && e.code === '1009') {
          const reason = (e.data as { reason?: string } | null)?.reason;
          onExit(reason === 'kicked' ? 'Bạn đã bị Controller loại khỏi phòng.' : 'Thiết bị không còn ở trong phòng.');
        } else if (e instanceof ApiError && e.code === 'NETWORK') setOffline(true);
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [roomId, onExit]);

  function leave() {
    Alert.alert('Rời phòng?', 'Controller sẽ không điều khiển được thiết bị này nữa.', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Rời phòng',
        style: 'destructive',
        onPress: async () => {
          setLeaving(true);
          try {
            await api.leaveRoom(roomId);
            onExit(null);
          } catch (e) {
            Alert.alert('Lỗi', errText(e));
          } finally {
            setLeaving(false);
          }
        },
      },
    ]);
  }

  return (
    <View style={st.pad}>
      <View style={st.controlled}>
        <View style={st.recDot} />
        <Text style={st.controlledText}>Đang được điều khiển từ xa</Text>
      </View>
      {offline ? <Banner text="Mất kết nối tới máy chủ, đang thử lại…" tone="error" /> : null}
      <Text style={st.h1}>{roomName || 'Phòng'}</Text>
      <Text style={st.sub}>Thiết bị đang chờ lệnh quay từ Controller. Giữ ứng dụng mở trong suốt buổi quay.</Text>
      <Text style={st.section}>THIẾT BỊ TRONG PHÒNG ({members.length})</Text>
      {members.map((m, i) => (
        <View key={m.member_id} style={st.member}>
          <View style={[st.dot, { backgroundColor: m.is_online === '1' ? colors.ok : colors.muted }]} />
          <Text style={st.memberName}>
            Cam {String(i + 1).padStart(2, '0')} · {m.camera_name}
          </Text>
          {m.device_id === myDevice ? <Text style={st.me}>Máy này</Text> : null}
        </View>
      ))}
      <View style={{ flex: 1, minHeight: 24 }} />
      <Button title="Rời phòng" variant="danger" onPress={leave} loading={leaving} />
    </View>
  );
}

const st = StyleSheet.create({
  pad: { flex: 1, padding: 20 },
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
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 18,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#fff' },
  controlledText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  section: { color: colors.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.5, marginTop: 8, marginBottom: 8 },
  member: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface, borderRadius: 10, padding: 14, marginBottom: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  memberName: { color: colors.text, fontSize: 15, flex: 1 },
  me: { color: colors.accent, fontSize: 12, fontWeight: '600' },
});
