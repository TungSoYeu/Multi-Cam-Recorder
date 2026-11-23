import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { passwordProblem } from '@multicam/shared';
import { api, getServerUrl, listServers, normalizeServer, pingServer, setServerUrl } from '../api';
import { Banner, Button, Field, Header, Screen, Title } from '../components/ui';
import { errField, errText, useNav } from '../nav';
import { colors } from '../theme';

// ======================= Cấu hình máy chủ =======================
export function ServerScreen() {
  const nav = useNav();
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [servers, setServers] = useState<{ url: string; ms: number | null | undefined }[]>([]);
  const [chosen, setChosen] = useState('');

  async function refresh() {
    const list = await listServers();
    setChosen(await getServerUrl());
    setServers(list.map((u) => ({ url: u, ms: undefined })));
    for (const u of list) pingServer(u).then((ms) => setServers((s) => s.map((x) => (x.url === u ? { ...x, ms } : x))));
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save() {
    if (!url.trim()) return setStatus({ ok: false, text: 'Nhập địa chỉ máy chủ' });
    setBusy(true);
    setStatus(null);
    try {
      await setServerUrl(url);
      const full = await getServerUrl();
      setUrl(full);
      void refresh();
      await api.health();
      setStatus({ ok: true, text: `Đã kết nối ${full}` });
    } catch (e) {
      setStatus({ ok: false, text: `Đã lưu nhưng chưa kết nối được: ${errText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Header title="Máy chủ" onBack={nav.pop} />
      <Title sub="Địa chỉ server Multi-Cam. Dùng IP LAN khi chung Wi-Fi, hoặc URL tunnel (https://…trycloudflare.com) khi dùng 3G/4G.">
        Chọn máy chủ
      </Title>
      {servers.map((s) => {
        const on = s.url === chosen;
        const dot =
          s.ms === undefined ? colors.muted : s.ms === null ? colors.danger : s.ms > 200 ? '#e5c33a' : colors.ok;
        return (
          <Pressable
            key={s.url}
            accessibilityRole="button"
            onPress={async () => {
              await setServerUrl(s.url);
              setChosen(s.url);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: colors.surface,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: on ? colors.accent : colors.border,
              padding: 14,
              marginBottom: 10,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>
                {s.url.replace(/^https?:\/\//, '').replace(/\/api$/, '')}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 12 }}>
                {s.ms === undefined ? 'Đang đo…' : s.ms === null ? 'Không kết nối được' : `${s.ms} ms`}
              </Text>
            </View>
            <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: dot }} />
          </Pressable>
        );
      })}
      <Field
        label="THÊM MÁY CHỦ"
        placeholder="192.168.1.10:3000 hoặc xxx.trycloudflare.com"
        value={url}
        onChangeText={setUrl}
        keyboardType="url"
        onSubmitEditing={save}
      />
      {url && !url.endsWith('/api') ? (
        <Text style={{ color: colors.muted, marginBottom: 12 }}>Sẽ lưu thành: {normalizeServer(url)}</Text>
      ) : null}
      {status ? <Banner text={status.text} tone={status.ok ? 'ok' : 'error'} /> : null}
      <Button title="Kiểm tra & lưu" onPress={save} loading={busy} />
    </Screen>
  );
}

// ======================= Đổi mật khẩu =======================
export function ChangePasswordScreen() {
  const nav = useNav();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    const e = {
      current: current ? undefined : 'Nhập mật khẩu hiện tại',
      next:
        passwordProblem(next, nav.session?.user.phone) ??
        (next === current ? 'Mật khẩu mới phải khác mật khẩu cũ' : undefined),
      confirm: confirm === next ? undefined : 'Mật khẩu nhập lại không khớp',
    };
    setErrors(e);
    if (e.current || e.next || e.confirm) return;
    setBusy(true);
    try {
      await api.changePassword({ password: current, new_password: next });
      await nav.reloadSession();
      Alert.alert('Đã đổi mật khẩu', 'Các thiết bị khác đăng nhập tài khoản này đã bị đăng xuất.', [
        { text: 'OK', onPress: nav.pop },
      ]);
    } catch (err) {
      setErrors(errField(err) === 'password' ? { current: 'Mật khẩu hiện tại không đúng' } : { form: errText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Header title="Đổi mật khẩu" onBack={nav.pop} />
      <Field label="MẬT KHẨU HIỆN TẠI" secure value={current} onChangeText={setCurrent} error={errors.current} />
      <Field
        label="MẬT KHẨU MỚI"
        placeholder="6–20 ký tự, chỉ chữ và số"
        secure
        value={next}
        onChangeText={setNext}
        error={errors.next}
      />
      <Field label="XÁC NHẬN MẬT KHẨU MỚI" secure value={confirm} onChangeText={setConfirm} error={errors.confirm} />
      {errors.form ? <Banner text={errors.form} tone="error" /> : null}
      <Button title="Lưu thay đổi" onPress={submit} loading={busy} />
    </Screen>
  );
}

// ======================= Xóa tài khoản =======================
export function DeleteAccountScreen() {
  const nav = useNav();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function submit() {
    if (!password) return setError('Nhập mật khẩu để xác nhận');
    Alert.alert('Xóa vĩnh viễn?', 'Tài khoản và toàn bộ video đã upload sẽ bị xóa, không thể khôi phục.', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Xóa vĩnh viễn',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          setError(null);
          try {
            await api.deleteAccount(password);
            await nav.reloadSession();
            nav.reset({ name: 'login', notice: 'Tài khoản đã được xóa vĩnh viễn.' });
          } catch (e) {
            setError(errField(e) === 'password' ? 'Mật khẩu không đúng' : errText(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <Screen>
      <Header title="Xóa tài khoản" onBack={nav.pop} />
      <Banner text="Thao tác này xóa vĩnh viễn tài khoản cùng toàn bộ video đã upload lên server." tone="error" />
      <Field label="MẬT KHẨU" secure value={password} onChangeText={setPassword} error={error} />
      <Button title="Xóa tài khoản vĩnh viễn" variant="danger" onPress={submit} loading={busy} />
    </Screen>
  );
}
