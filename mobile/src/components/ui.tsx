import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius } from '../theme';

export function Screen({
  children,
  scroll = true,
  padded = true,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
}) {
  const body = <View style={[padded && styles.padded, { flexGrow: 1 }]}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {scroll ? (
          <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
            {body}
          </ScrollView>
        ) : (
          body
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Header({ title, onBack, right }: { title?: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Quay lại">
          <Text style={styles.back}>‹</Text>
        </Pressable>
      ) : (
        <View style={{ width: 20 }} />
      )}
      {title ? <Text style={styles.headerTitle}>{title}</Text> : <View />}
      <View style={{ minWidth: 20, alignItems: 'flex-end' }}>{right}</View>
    </View>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <View style={{ marginBottom: 20 }}>
      <Text style={styles.title}>{children}</Text>
      {sub ? <Text style={styles.sub}>{sub}</Text> : null}
    </View>
  );
}

type FieldProps = TextInputProps & { label?: string; error?: string | null; secure?: boolean };

export function Field({ label, error, secure, style, ...rest }: FieldProps) {
  const [hidden, setHidden] = useState(true);
  return (
    <View style={{ marginBottom: 14 }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View>
        <TextInput
          placeholderTextColor="#5c5c63"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={secure && hidden}
          style={[
            styles.input,
            error ? { borderColor: colors.danger } : null,
            secure ? { paddingRight: 56 } : null,
            style,
          ]}
          {...rest}
        />
        {secure ? (
          <Pressable style={styles.eye} onPress={() => setHidden((h) => !h)} hitSlop={8} accessibilityRole="button">
            <Text style={styles.eyeText}>{hidden ? 'Hiện' : 'Ẩn'}</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.btn,
        styles[`btn_${variant}`],
        off && { opacity: 0.45 },
        pressed && { opacity: 0.8 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.accentInk : colors.text} />
      ) : (
        <Text
          style={[
            styles.btnText,
            variant === 'primary' && { color: colors.accentInk },
            variant === 'danger' && { color: colors.danger },
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Link({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="link">
      <Text style={styles.link}>{title}</Text>
    </Pressable>
  );
}

export function Banner({ text, tone = 'warn' }: { text: string; tone?: 'warn' | 'error' | 'ok' }) {
  const c = tone === 'ok' ? colors.ok : tone === 'error' ? colors.danger : colors.accent;
  return (
    <View style={[styles.banner, { borderColor: c + '66', backgroundColor: c + '1f' }]}>
      <Text style={{ color: c, fontSize: 14 }}>{text}</Text>
    </View>
  );
}

/** Ô nhập mã nhiều ký tự (mã xác thực 6 số / mã phòng 6 ký tự). */
export function CodeInput({
  value,
  onChange,
  length = 6,
  numeric,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  numeric?: boolean;
  autoFocus?: boolean;
}) {
  const ref = useRef<ComponentRef<typeof TextInput>>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (autoFocus) setTimeout(() => ref.current?.focus(), 300);
  }, [autoFocus]);
  return (
    <Pressable onPress={() => ref.current?.focus()} style={styles.codeRow} accessibilityLabel="Ô nhập mã">
      {Array.from({ length }, (_, i) => {
        const active = focused && i === Math.min(value.length, length - 1);
        return (
          <View key={i} style={[styles.codeBox, active && { borderColor: colors.accent }]}>
            <Text style={styles.codeChar}>{value[i] ?? ''}</Text>
          </View>
        );
      })}
      <TextInput
        ref={ref}
        value={value}
        onChangeText={(t) => {
          const clean = numeric ? t.replace(/\D/g, '') : t.toUpperCase().replace(/[^A-Z0-9]/g, '');
          onChange(clean.slice(0, length));
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        keyboardType={numeric ? 'number-pad' : 'default'}
        autoCapitalize="characters"
        autoCorrect={false}
        textContentType={numeric ? 'oneTimeCode' : 'none'}
        maxLength={length}
        style={styles.hiddenInput}
        caretHidden
      />
    </Pressable>
  );
}

export function Row({
  label,
  value,
  onPress,
  danger,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
      <Text style={[styles.rowLabel, danger && { color: colors.danger }]}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value ?? ''} {onPress ? '›' : ''}
      </Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  padded: { paddingHorizontal: 20, paddingBottom: 20 },
  header: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { color: colors.text, fontSize: 34, lineHeight: 36, width: 20 },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: '600' },
  title: { color: colors.text, fontSize: 26, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: 14, marginTop: 6, lineHeight: 20 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6, letterSpacing: 0.4 },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  eye: { position: 'absolute', right: 12, top: 0, bottom: 0, justifyContent: 'center' },
  eyeText: { color: colors.muted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13, marginTop: 6 },
  btn: { minHeight: 50, borderRadius: radius, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btn_primary: { backgroundColor: colors.accent },
  btn_secondary: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
  btn_danger: { backgroundColor: colors.danger + '1f', borderWidth: 1, borderColor: colors.danger + '77' },
  btn_ghost: { backgroundColor: 'transparent' },
  btnText: { color: colors.text, fontSize: 16, fontWeight: '600' },
  link: { color: colors.accent, fontSize: 14, fontWeight: '500' },
  banner: { borderWidth: 1, borderRadius: radius, padding: 12, marginBottom: 14 },
  codeRow: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginVertical: 8 },
  codeBox: {
    width: 46,
    height: 56,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeChar: { color: colors.text, fontSize: 24, fontWeight: '700' },
  hiddenInput: { position: 'absolute', opacity: 0.01, width: 1, height: 1 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surface,
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLabel: { color: colors.text, fontSize: 15 },
  rowValue: { color: colors.muted, fontSize: 14, maxWidth: '60%' },
});
