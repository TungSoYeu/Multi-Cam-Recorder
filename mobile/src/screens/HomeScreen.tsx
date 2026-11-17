import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, getServerUrl } from '../api';
import { Button, Row } from '../components/ui';
import { errText, useNav } from '../nav';
import { colors } from '../theme';
import { DeviceSyncProvider } from '../sync';
import { LibraryTab } from './LibraryTab';
import { RoomTab } from './RoomTab';

type Tab = 'room' | 'library' | 'settings';
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'room', label: 'Phòng', icon: '🚪' },
  { key: 'library', label: 'Thư viện', icon: '📁' },
  { key: 'settings', label: 'Cài đặt', icon: '⚙️' },
];

export function HomeScreen() {
  const nav = useNav();
  const [tab, setTab] = useState<Tab>('room');

  if (nav.session?.account_role === 'controller') return <ControllerNotice />;

  return (
    <DeviceSyncProvider>
    <SafeAreaView style={st.screen} edges={['top', 'left', 'right']}>
      <View style={{ flex: 1 }}>
        {/* Tab Phòng luôn được giữ lại để camera sẵn sàng nhận lệnh và không ngắt clip đang quay */}
        <View style={[{ flex: 1 }, tab !== 'room' && { display: 'none' }]}>
          <RoomTab />
        </View>
        {tab === 'library' && <LibraryTab />}
        {tab === 'settings' && <SettingsTab />}
      </View>
      <SafeAreaView edges={['bottom']} style={st.tabbar}>
        {TABS.map((t) => (
          <Pressable key={t.key} style={st.tab} onPress={() => setTab(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
            <Text style={{ fontSize: 20, opacity: tab === t.key ? 1 : 0.5 }}>{t.icon}</Text>
            <Text style={[st.tabLabel, tab === t.key && { color: colors.accent }]}>{t.label}</Text>
          </Pressable>
        ))}
      </SafeAreaView>
    </SafeAreaView>
    </DeviceSyncProvider>
  );
}


function SettingsTab() {
  const nav = useNav();
  const s = nav.session;
  const [server, setServer] = useState('');
  useEffect(() => {
    getServerUrl().then(setServer);
  }, []);

  function logout() {
    Alert.alert('Đăng xuất?', 'Thiết bị sẽ rời phòng hiện tại.', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Đăng xuất',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.logout();
          } catch (e) {
            // Lỗi mạng: phiên local vẫn được xóa
            if (!/Internet/.test(errText(e))) Alert.alert('Lỗi', errText(e));
          }
          await nav.reloadSession();
          nav.reset({ name: 'login' });
        },
      },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 18 }}>
      <Text style={st.h1}>Cài đặt</Text>
      <View style={st.profile}>
        <View style={st.avatar}>
          <Text style={{ color: colors.accent, fontWeight: '700', fontSize: 18 }}>
            {(s?.user.last_name?.[0] ?? '') + (s?.user.first_name?.[0] ?? '')}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={st.name}>
            {s?.user.last_name} {s?.user.first_name}
          </Text>
          <Text style={st.badge}>Remote Camera</Text>
        </View>
      </View>
      <View>
        <Text style={st.section}>THIẾT BỊ</Text>
        <View style={st.group}>
          <Row label="Tên thiết bị" value={s?.device?.device_name} />
          <Row label="Tên camera" value={s?.device?.camera_name} />
          <Row label="Máy chủ" value={server.replace(/^https?:\/\//, '')} onPress={() => nav.push({ name: 'server' })} />
        </View>
      </View>
      <View>
        <Text style={st.section}>TÀI KHOẢN</Text>
        <View style={st.group}>
          <Row label="Số điện thoại" value={s?.user.phone} />
          <Row label="Email" value={s?.user.email} />
          <Row label="Đổi mật khẩu" onPress={() => nav.push({ name: 'changePassword' })} />
        </View>
      </View>
      <Button title="Đăng xuất" variant="secondary" onPress={logout} />
      <Button title="Xóa tài khoản" variant="danger" onPress={() => nav.push({ name: 'deleteAccount' })} />
    </ScrollView>
  );
}

function ControllerNotice() {
  const nav = useNav();
  return (
    <SafeAreaView style={[st.screen, st.centerPad]}>
      <Text style={{ fontSize: 40 }}>🖥️</Text>
      <Text style={st.h1}>Tài khoản Controller</Text>
      <Text style={st.muted}>Controller điều khiển phòng trên giao diện web. Mở địa chỉ máy chủ bằng trình duyệt trên laptop.</Text>
      <Button
        title="Đăng xuất"
        variant="secondary"
        style={{ alignSelf: 'stretch', marginTop: 20 }}
        onPress={async () => {
          await api.logout().catch(() => undefined);
          await nav.reloadSession();
          nav.reset({ name: 'login' });
        }}
      />
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  centerPad: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  h1: { color: colors.text, fontSize: 24, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  tabbar: { flexDirection: 'row', backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  tab: { flex: 1, alignItems: 'center', paddingTop: 8, paddingBottom: 6, gap: 2 },
  tabLabel: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.surface, borderRadius: 14, padding: 14 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#2a2118', alignItems: 'center', justifyContent: 'center' },
  name: { color: colors.text, fontSize: 17, fontWeight: '600' },
  badge: { color: colors.muted, fontSize: 12, marginTop: 2 },
  section: { color: colors.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8 },
  group: { borderRadius: 14, overflow: 'hidden' },
});
