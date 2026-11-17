import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  ApiError,
  EMAIL_RE,
  PHONE_RE,
  passwordProblem,
  type Identifier,
  type VerifyPurpose,
} from '@multicam/shared';
import { api, deviceInfo, getServerUrl } from '../api';
import { Banner, Button, CodeInput, Field, Header, Link, Screen, Title } from '../components/ui';
import { errField, errText, identText, toIdent, useNav } from '../nav';
import { colors } from '../theme';

/** Gửi mã xác thực; nếu đang trong 120 giây chờ thì vẫn chuyển sang màn nhập mã. */
async function requestCode(ident: Identifier, purpose: VerifyPurpose) {
  try {
    const d = await api.getVerifyCode({ ...ident, purpose } as Parameters<typeof api.getVerifyCode>[0]);
    return { masked: d.masked_target, devCode: d.code_verify, retryAfter: d.resend_after };
  } catch (e) {
    if (e instanceof ApiError && e.code === '1012')
      return { masked: undefined, devCode: undefined, retryAfter: (e.data as { retry_after?: number })?.retry_after ?? 120 };
    throw e;
  }
}

// ======================= Đăng nhập =======================
export function LoginScreen({ notice, identifier: initial }: { notice?: string; identifier?: string }) {
  const nav = useNav();
  const [identifier, setIdentifier] = useState(initial ?? '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ id?: string; pw?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState('');

  useEffect(() => {
    getServerUrl().then(setServer);
  }, []);

  async function submit() {
    const id = identifier.trim();
    const next: typeof errors = {};
    if (!id) next.id = 'Nhập email hoặc số điện thoại';
    if (!password) next.pw = 'Nhập mật khẩu';
    setErrors(next);
    if (next.id || next.pw) return;
    setBusy(true);
    const ident = toIdent(id);
    try {
      await api.login({ ...ident, password, ...(await deviceInfo()) } as Parameters<typeof api.login>[0]);
      await nav.reloadSession();
      nav.reset({ name: 'home' });
    } catch (e) {
      if (e instanceof ApiError && e.code === '9995') {
        const d = e.data as { verify_required?: string } | null;
        if (d?.verify_required === '1') {
          // Đã đăng ký nhưng chưa xác thực → gửi mã và chuyển sang màn nhập mã
          try {
            const r = await requestCode(ident, 'signup');
            nav.push({ name: 'verify', ident, purpose: 'signup', ...r });
          } catch (err) {
            setErrors({ form: errText(err) });
          }
        } else setErrors({ id: 'Tài khoản không tồn tại' });
      } else if (errField(e) === 'password') setErrors({ pw: 'Sai mật khẩu' });
      else setErrors({ form: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={s.logoWrap}>
        <View style={s.logo}>
          <Text style={{ fontSize: 30 }}>🎥</Text>
        </View>
        <Text style={s.appName}>Multi-Cam Recorder</Text>
        <Text style={s.tag}>REMOTE CAMERA</Text>
      </View>
      {notice ? <Banner text={notice} tone="ok" /> : null}
      {!server ? <Banner text="Chưa cấu hình máy chủ. Bấm “Máy chủ” ở cuối màn hình." /> : null}
      <Field
        label="EMAIL HOẶC SỐ ĐIỆN THOẠI"
        placeholder="email@example.com / 09xxxxxxxx"
        value={identifier}
        onChangeText={setIdentifier}
        keyboardType="email-address"
        textContentType="username"
        error={errors.id}
      />
      <Field
        label="MẬT KHẨU"
        placeholder="Mật khẩu"
        value={password}
        onChangeText={setPassword}
        secure
        textContentType="password"
        error={errors.pw}
        onSubmitEditing={submit}
      />
      {errors.form ? <Banner text={errors.form} tone="error" /> : null}
      <Button title="Đăng nhập" onPress={submit} loading={busy} />
      <View style={s.links}>
        <Link title="Quên mật khẩu?" onPress={() => nav.push({ name: 'forgot' })} />
        <Link title="Đăng ký tài khoản" onPress={() => nav.push({ name: 'signup' })} />
      </View>
      <View style={{ flex: 1 }} />
      <Pressable onPress={() => nav.push({ name: 'server' })} style={s.server} accessibilityRole="button">
        <Text style={s.serverText} numberOfLines={1}>
          Máy chủ: {server || 'chưa đặt'} ›
        </Text>
      </Pressable>
    </Screen>
  );
}

// ======================= Đăng ký =======================
export function SignupScreen() {
  const nav = useNav();
  const [f, setF] = useState({ first_name: '', last_name: '', phone: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((o) => ({ ...o, [k]: v }));

  async function submit() {
    const e: Record<string, string> = {};
    const email = f.email.trim().toLowerCase();
    const phone = f.phone.trim();
    if (!f.last_name.trim()) e.last_name = 'Nhập họ';
    if (!f.first_name.trim()) e.first_name = 'Nhập tên';
    if (!PHONE_RE.test(phone)) e.phone = 'Số điện thoại gồm 10 số, bắt đầu bằng 0';
    if (!EMAIL_RE.test(email)) e.email = 'Email không hợp lệ';
    const pw = passwordProblem(f.password, phone);
    if (pw) e.password = pw;
    if (f.confirm !== f.password) e.confirm = 'Mật khẩu nhập lại không khớp';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api.signup({ first_name: f.first_name.trim(), last_name: f.last_name.trim(), email, phone, password: f.password });
      const ident = { email };
      const r = await requestCode(ident, 'signup').catch(() => ({ masked: undefined, devCode: undefined, retryAfter: 0 }));
      nav.push({ name: 'verify', ident, purpose: 'signup', ...r });
    } catch (err) {
      const field = errField(err);
      if (err instanceof ApiError && err.code === '9996')
        setErrors({ [field ?? 'email']: field === 'phone' ? 'Số điện thoại đã được đăng ký' : 'Email đã được đăng ký' });
      else if (field) setErrors({ [field]: errText(err) });
      else setErrors({ form: errText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Header title="Tạo tài khoản" onBack={nav.pop} />
      <Text style={s.note}>Tài khoản đăng ký sẽ hoạt động ở vai trò Remote Camera.</Text>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Field label="HỌ" placeholder="Nguyễn" value={f.last_name} onChangeText={set('last_name')} autoCapitalize="words" error={errors.last_name} />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="TÊN" placeholder="Văn A" value={f.first_name} onChangeText={set('first_name')} autoCapitalize="words" error={errors.first_name} />
        </View>
      </View>
      <Field label="SỐ ĐIỆN THOẠI" placeholder="09xxxxxxxx" keyboardType="phone-pad" value={f.phone} onChangeText={set('phone')} maxLength={10} error={errors.phone} />
      <Field label="EMAIL" placeholder="email@example.com" keyboardType="email-address" value={f.email} onChangeText={set('email')} error={errors.email} />
      <Field label="MẬT KHẨU" placeholder="6–20 ký tự, chỉ chữ và số" secure value={f.password} onChangeText={set('password')} textContentType="newPassword" error={errors.password} />
      <Field label="XÁC NHẬN MẬT KHẨU" placeholder="Nhập lại mật khẩu" secure value={f.confirm} onChangeText={set('confirm')} error={errors.confirm} />
      {errors.form ? <Banner text={errors.form} tone="error" /> : null}
      <Button title="Tạo tài khoản" onPress={submit} loading={busy} />
      <View style={[s.links, { justifyContent: 'center' }]}>
        <Text style={{ color: colors.muted }}>Đã có tài khoản? </Text>
        <Link title="Đăng nhập" onPress={nav.pop} />
      </View>
    </Screen>
  );
}

// ======================= Nhập mã xác thực =======================
export function VerifyScreen(p: { ident: Identifier; purpose: VerifyPurpose; masked?: string; devCode?: string; retryAfter?: number }) {
  const nav = useNav();
  const [code, setCode] = useState('');
  const [masked, setMasked] = useState(p.masked ?? identText(p.ident));
  const [devCode, setDevCode] = useState(p.devCode);
  const [wait, setWait] = useState(p.retryAfter ?? 120);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function resend() {
    setError(null);
    try {
      const r = await requestCode(p.ident, p.purpose);
      if (r.masked) setMasked(r.masked);
      setDevCode(r.devCode);
      setWait(r.retryAfter);
      setCode('');
    } catch (e) {
      setError(errText(e));
    }
  }

  async function submit(value = code) {
    if (value.length !== 6) return setError('Nhập đủ 6 số');
    setError(null);
    if (p.purpose === 'forgot_password') {
      nav.push({ name: 'newPassword', ident: p.ident, code: value });
      return;
    }
    setBusy(true);
    try {
      await api.checkVerifyCode({ ...p.ident, code_verify: value, ...(await deviceInfo()) } as Parameters<typeof api.checkVerifyCode>[0]);
      await nav.reloadSession();
      nav.reset({ name: 'home' });
    } catch (e) {
      setError(errText(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const mm = `${String(Math.floor(wait / 60)).padStart(2, '0')}:${String(wait % 60).padStart(2, '0')}`;
  return (
    <Screen>
      <Header onBack={nav.pop} />
      <Title sub={`Mã gồm 6 chữ số đã gửi tới ${masked}`}>Nhập mã xác minh</Title>
      <CodeInput
        value={code}
        numeric
        autoFocus
        onChange={(v) => {
          setCode(v);
          if (v.length === 6 && p.purpose === 'signup') submit(v);
        }}
      />
      {devCode ? (
        <Pressable onPress={() => setCode(devCode)} style={s.devCode}>
          <Text style={{ color: colors.muted, fontSize: 13 }}>
            Mã server trả về (thử nghiệm): <Text style={{ color: colors.accent, fontWeight: '700' }}>{devCode}</Text> — chạm để điền
          </Text>
        </Pressable>
      ) : null}
      {error ? <Text style={[s.center, { color: colors.danger, marginTop: 8 }]}>{error}</Text> : null}
      <View style={{ alignItems: 'center', marginVertical: 16 }}>
        {wait > 0 ? <Text style={{ color: colors.muted }}>Gửi lại mã sau {mm}</Text> : <Link title="Gửi lại mã" onPress={resend} />}
      </View>
      <View style={{ flex: 1 }} />
      <Button title="Xác nhận" onPress={() => submit()} loading={busy} disabled={code.length !== 6} />
    </Screen>
  );
}

// ======================= Quên mật khẩu =======================
export function ForgotScreen() {
  const nav = useNav();
  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const id = identifier.trim();
    if (!id) return setError('Nhập số điện thoại hoặc email');
    const ident = toIdent(id);
    setBusy(true);
    setError(null);
    try {
      const r = await requestCode(ident, 'forgot_password');
      nav.push({ name: 'verify', ident, purpose: 'forgot_password', ...r });
    } catch (e) {
      setError(e instanceof ApiError && e.code === '9995' ? 'Tài khoản không tồn tại hoặc chưa kích hoạt' : errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Header onBack={nav.pop} />
      <Title sub="Nhập số điện thoại hoặc email đã đăng ký, chúng tôi sẽ gửi mã xác minh.">Khôi phục mật khẩu</Title>
      <Field placeholder="Số điện thoại hoặc email" value={identifier} onChangeText={setIdentifier} keyboardType="email-address" error={error} onSubmitEditing={submit} />
      <View style={{ flex: 1 }} />
      <Button title="Gửi mã xác minh" onPress={submit} loading={busy} />
    </Screen>
  );
}

// ======================= Tạo mật khẩu mới =======================
export function NewPasswordScreen({ ident, code }: { ident: Identifier; code: string }) {
  const nav = useNav();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ pw?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const rules = [
    { ok: pw.length >= 6 && pw.length <= 20, text: '6–20 ký tự' },
    { ok: pw.length > 0 && /^[A-Za-z0-9]*$/.test(pw), text: 'Chỉ gồm chữ và số' },
    { ok: pw.length > 0 && pw !== ident.phone, text: 'Không trùng số điện thoại' },
  ];

  async function submit() {
    const p = passwordProblem(pw, ident.phone);
    const e = { pw: p ?? undefined, confirm: confirm !== pw ? 'Mật khẩu nhập lại không khớp' : undefined };
    setErrors(e);
    if (e.pw || e.confirm) return;
    setBusy(true);
    try {
      await api.forgotPassword({ ...ident, code_verify: code, new_password: pw } as Parameters<typeof api.forgotPassword>[0]);
      nav.reset({ name: 'login', notice: 'Đã đặt lại mật khẩu. Hãy đăng nhập bằng mật khẩu mới.', identifier: identText(ident) });
    } catch (err) {
      if (err instanceof ApiError && err.code === '9993') {
        Alert.alert('Mã xác thực không đúng', 'Mã sai hoặc đã hết hạn, vui lòng nhập lại.', [{ text: 'OK', onPress: nav.pop }]);
      } else setErrors({ form: errText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Header onBack={nav.pop} />
      <Title>Tạo mật khẩu mới</Title>
      <Field label="MẬT KHẨU MỚI" secure value={pw} onChangeText={setPw} textContentType="newPassword" error={errors.pw} />
      <Field label="XÁC NHẬN MẬT KHẨU MỚI" secure value={confirm} onChangeText={setConfirm} error={errors.confirm} />
      {rules.map((r) => (
        <Text key={r.text} style={{ color: r.ok ? colors.ok : colors.muted, marginBottom: 6 }}>
          {r.ok ? '✓' : '○'} {r.text}
        </Text>
      ))}
      {errors.form ? <Banner text={errors.form} tone="error" /> : null}
      <View style={{ flex: 1, minHeight: 20 }} />
      <Button title="Lưu mật khẩu" onPress={submit} loading={busy} />
    </Screen>
  );
}

const s = StyleSheet.create({
  logoWrap: { alignItems: 'center', marginTop: 48, marginBottom: 32 },
  logo: { width: 72, height: 72, borderRadius: 20, backgroundColor: '#2a2118', alignItems: 'center', justifyContent: 'center' },
  appName: { color: colors.text, fontSize: 24, fontWeight: '800', marginTop: 14 },
  tag: { color: colors.muted, fontSize: 11, letterSpacing: 2, marginTop: 4 },
  links: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 },
  note: { color: colors.muted, marginBottom: 16, lineHeight: 20 },
  server: { alignItems: 'center', paddingVertical: 12 },
  serverText: { color: colors.muted, fontSize: 12 },
  center: { textAlign: 'center' },
  devCode: { alignItems: 'center', marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: colors.surface },
});
