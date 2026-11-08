import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, LogBox, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from '@/lib/auth';
import { ServerProvider, useServer } from '@/lib/server';
import { colors } from '@/theme';
import SetupScreen from './setup';

void SplashScreen.preventAutoHideAsync();

// expo-router's Tabs emits this from its own reanimated usage; nothing in this app does.
LogBox.ignoreLogs([/shared value's .value inside reanimated inline style/]);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnReconnect: true },
  },
});

function Gate() {
  const { loading, session, profile, roleDenied } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const onLogin = segments[0] === 'login';
    const allowed = !!session && !!profile && !roleDenied;
    if (!allowed && !onLogin) router.replace('/login');
    else if (allowed && onLogin) router.replace('/(tabs)');
  }, [loading, session, profile, roleDenied, segments, router]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
        headerTitleStyle: { fontWeight: '600' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}>
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="setup" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="transactions/index" options={{ title: 'Transactions' }} />
      <Stack.Screen name="transactions/[id]" options={{ title: 'Sale' }} />
      <Stack.Screen name="product/[id]" options={{ title: 'Product' }} />
      <Stack.Screen name="staff/[id]" options={{ title: 'Staff' }} />
      <Stack.Screen name="caja/index" options={{ title: 'Register sessions' }} />
      <Stack.Screen name="caja/[id]" options={{ title: 'Register session' }} />
      <Stack.Screen name="transfers/index" options={{ title: 'Bank transfers' }} />
      <Stack.Screen name="transfers/[id]" options={{ title: 'Bank transfer' }} />
      <Stack.Screen name="audit" options={{ title: 'Audit log' }} />
      <Stack.Screen name="refunds" options={{ title: 'Refunds' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
    </Stack>
  );
}

function AppShell() {
  const { loading, config } = useServer();

  useEffect(() => {
    if (!loading) void SplashScreen.hideAsync();
  }, [loading]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }

  if (!config) return <SetupScreen />;

  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ServerProvider>
          <StatusBar style="light" />
          <AppShell />
        </ServerProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
