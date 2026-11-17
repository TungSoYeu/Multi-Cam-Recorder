import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, BackHandler, StatusBar, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { StoredSession } from '@multicam/shared';
import { api, onSessionExpired } from './src/api';
import { NavContext, type Nav, type Route } from './src/nav';
import { ForgotScreen, LoginScreen, NewPasswordScreen, SignupScreen, VerifyScreen } from './src/screens/AuthScreens';
import { ChangePasswordScreen, DeleteAccountScreen, ServerScreen } from './src/screens/AccountScreens';
import { HomeScreen } from './src/screens/HomeScreen';
import { colors } from './src/theme';

function render(r: Route) {
  switch (r.name) {
    case 'login':
      return <LoginScreen notice={r.notice} identifier={r.identifier} />;
    case 'signup':
      return <SignupScreen />;
    case 'verify':
      return <VerifyScreen {...r} />;
    case 'forgot':
      return <ForgotScreen />;
    case 'newPassword':
      return <NewPasswordScreen ident={r.ident} code={r.code} />;
    case 'server':
      return <ServerScreen />;
    case 'home':
      return <HomeScreen />;
    case 'changePassword':
      return <ChangePasswordScreen />;
    case 'deleteAccount':
      return <DeleteAccountScreen />;
  }
}

export default function App() {
  const [stack, setStack] = useState<Route[] | null>(null);
  const [session, setSession] = useState<StoredSession | null>(null);

  const reloadSession = useCallback(async () => {
    const s = await api.getSession();
    setSession(s);
    return s;
  }, []);

  useEffect(() => {
    reloadSession().then((s) => setStack([s ? { name: 'home' } : { name: 'login' }]));
    return onSessionExpired(() => {
      setSession(null);
      setStack([{ name: 'login', notice: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.' }]);
    });
  }, [reloadSession]);

  const nav = useMemo<Nav>(
    () => ({
      push: (r) => setStack((s) => [...(s ?? []), r]),
      pop: () => setStack((s) => (s && s.length > 1 ? s.slice(0, -1) : s)),
      reset: (r) => setStack([r]),
      session,
      reloadSession,
    }),
    [session, reloadSession],
  );

  // Nút Back của Android quay lại màn trước
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack && stack.length > 1) {
        nav.pop();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [stack, nav]);

  const top = stack?.[stack.length - 1];
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <NavContext.Provider value={nav}>
        {top ? (
          <View key={`${stack!.length}-${top.name}`} style={{ flex: 1, backgroundColor: colors.bg }}>
            {render(top)}
          </View>
        ) : (
          <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        )}
      </NavContext.Provider>
    </SafeAreaProvider>
  );
}
