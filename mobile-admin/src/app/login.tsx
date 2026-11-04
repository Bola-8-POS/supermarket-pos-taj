import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Avatar,
  BrandFooter,
  BrandLockup,
  Button,
  Card,
  Divider,
  Empty,
  ErrorBox,
  Row,
  text,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { type LoginProfile } from '@/lib/auth-policy';
import { useLoginStaff } from '@/lib/common-queries';
import { canSubmitPin, errorAfterTyping } from '@/lib/login-guards';
import { useServer } from '@/lib/server';
import { signInMessage } from '@/lib/staff-sign-in';
import { colors, radius, space, type } from '@/theme';

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { signIn, signOut, roleDenied, profile } = useAuth();
  const { config, clearConfig } = useServer();
  const staff = useLoginStaff();
  const [selected, setSelected] = useState<LoginProfile | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lockedUntil, setLockedUntil] = useState<number | null>(null);

  // UX only: re-enable the button when the server's retryAfter has elapsed. The server stays the authority.
  useEffect(() => {
    if (lockedUntil === null) return;
    const timer = setTimeout(() => {
      setLockedUntil(null);
    }, Math.max(0, lockedUntil - Date.now()));
    return () => {
      clearTimeout(timer);
    };
  }, [lockedUntil]);

  const submit = async () => {
    if (!selected || !canSubmitPin({ hasSelection: true, pin, lockedUntil, busy })) return;
    setBusy(true);
    setError(null);
    const result = await signIn(selected.id, pin);
    setBusy(false);
    if (result.kind === 'ok') return;
    setPin('');
    if (result.kind === 'LOCKED') setLockedUntil(Date.now() + result.retryAfter * 1000);
    setError(signInMessage(result));
  };

  const configureStore = async () => {
    queryClient.clear();
    await clearConfig();
  };

  if (roleDenied) {
    return (
      <View
        style={[
          s.centered,
          { paddingTop: insets.top + space[8], paddingBottom: insets.bottom + space[4] },
        ]}>
        <Ionicons name="lock-closed" size={36} color={colors.warning} />
        <Text style={text.h1}>Managers only</Text>
        <Text style={s.centerText}>
          {profile?.name ?? 'This account'} is signed in as {profile?.role}. This app is for admins and managers.
        </Text>
        <Button
          title="Sign out"
          tone="ghost"
          onPress={() => {
            void signOut();
          }}
        />
      </View>
    );
  }

  if (selected) {
    return (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.flex}>
        <View
          style={[
            s.centered,
            { paddingTop: insets.top + space[6], paddingBottom: insets.bottom + space[4] },
          ]}>
          <BrandLockup compact />
          <View style={s.selectedUser}>
            <Avatar name={selected.name} size={64} />
            <Text style={text.h1}>{selected.name}</Text>
            <Text style={[text.muted, s.capitalize]}>{selected.role}</Text>
          </View>
          <View style={s.form}>
            <TextInput
              accessibilityLabel={`PIN for ${selected.name}`}
              placeholder="6-digit PIN"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="number-pad"
              secureTextEntry
              textContentType="password"
              maxLength={6}
              value={pin}
              onChangeText={value => {
                setPin(value.replace(/\D/g, ''));
                setError(current => errorAfterTyping(current, lockedUntil));
              }}
              editable={!busy}
              onSubmitEditing={() => {
                void submit();
              }}
              style={s.input}
              returnKeyType="go"
            />
            {error ? <ErrorBox message={error} /> : null}
            <Button
              title="Sign in"
              onPress={() => {
                void submit();
              }}
              loading={busy}
              disabled={!canSubmitPin({ hasSelection: true, pin, lockedUntil, busy })}
            />
            <Button
              title="Choose another user"
              tone="ghost"
              onPress={() => {
                setSelected(null);
                setPin('');
                setError(null);
                setLockedUntil(null);
              }}
            />
          </View>
          <BrandFooter />
        </View>
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top + space[4], paddingBottom: insets.bottom + space[3] }]}>
      <BrandLockup />
      <View style={s.rosterHeader}>
        <Text style={text.h1}>Who are you?</Text>
        <Text style={s.centerText}>Choose your profile, then enter your staff PIN.</Text>
      </View>
      {staff.error ? (
        <ErrorBox
          message={staff.error.message}
          onRetry={() => {
            void staff.refetch();
          }}
        />
      ) : (
        <Card style={s.rosterCard}>
          <FlatList
            data={staff.data ?? []}
            keyExtractor={item => item.id}
            ItemSeparatorComponent={Divider}
            contentContainerStyle={staff.data?.length ? undefined : s.emptyList}
            ListEmptyComponent={
              staff.isPending ? null : <Empty icon="people-outline" title="No manager profiles available" />
            }
            renderItem={({ item }) => (
              <Row
                leading={<Avatar name={item.name} />}
                title={item.name}
                subtitle={item.role}
                onPress={() => {
                  setSelected(item);
                  setError(null);
                }}
              />
            )}
          />
        </Card>
      )}
      <View style={s.bottom}>
        <Text style={text.muted} numberOfLines={1}>
          {config?.url.replace(/^https?:\/\//, '')}
        </Text>
        <Button
          title="Configure another store"
          tone="ghost"
          onPress={() => {
            void configureStore();
          }}
        />
        <BrandFooter />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: space[5], gap: space[4] },
  centered: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: space[6],
    gap: space[6],
    justifyContent: 'center',
  },
  centerText: { ...type.body, color: colors.mutedForeground, textAlign: 'center' },
  rosterHeader: { alignItems: 'center', gap: space[1] },
  rosterCard: { flex: 1 },
  emptyList: { flexGrow: 1, justifyContent: 'center' },
  selectedUser: { alignItems: 'center', gap: space[2] },
  capitalize: { textTransform: 'capitalize' },
  form: { gap: space[3] },
  input: {
    height: 56,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.input,
    backgroundColor: colors.card,
    color: colors.foreground,
    paddingHorizontal: space[4],
    ...type.body,
    fontSize: 20,
    letterSpacing: 8,
    textAlign: 'center',
  },
  bottom: { gap: space[2], alignItems: 'stretch' },
});
