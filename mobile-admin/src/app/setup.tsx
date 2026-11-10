import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandFooter, BrandLockup, Button, ErrorBox, text } from '@/components/ui';
import { useServer } from '@/lib/server';
import { colors, radius, space, type } from '@/theme';

export default function SetupScreen() {
  const insets = useSafeAreaInsets();
  const { saveConfig } = useServer();
  const [url, setUrl] = useState('');
  const [anonKey, setAnonKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveConfig({ url, anonKey });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save this store.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.flex}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          s.content,
          { paddingTop: insets.top + space[6], paddingBottom: insets.bottom + space[4] },
        ]}>
        <BrandLockup />
        <View style={s.intro}>
          <Text style={text.h1}>Connect this store</Text>
          <Text style={s.centerText}>
            Each store uses its own Supabase project. Enter its project URL and legacy anon key.
          </Text>
        </View>
        <View style={s.form}>
          <View style={s.field}>
            <Text style={s.label}>Supabase URL</Text>
            <TextInput
              accessibilityLabel="Supabase URL"
              placeholder="https://project.supabase.co"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              value={url}
              onChangeText={setUrl}
              style={s.input}
            />
          </View>
          <View style={s.field}>
            <Text style={s.label}>Legacy anon key</Text>
            <TextInput
              accessibilityLabel="Supabase legacy anon key"
              placeholder="sb_publishable_… or eyJ…"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              value={anonKey}
              onChangeText={setAnonKey}
              style={[s.input, s.keyInput]}
            />
          </View>
          <Text style={s.hint}>
            Local Wi-Fi example: http://192.168.1.20:54321. Remote projects must use HTTPS. Never use a
            service-role or secret key.
          </Text>
          {error ? <ErrorBox message={error} /> : null}
          <Button
            title="Test and save store"
            icon="checkmark-circle-outline"
            loading={busy}
            disabled={!url.trim() || !anonKey.trim()}
            onPress={() => {
              void submit();
            }}
          />
        </View>
        <BrandFooter />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: space[6], gap: space[6] },
  intro: { alignItems: 'center', gap: space[2] },
  centerText: { ...type.body, color: colors.mutedForeground, textAlign: 'center' },
  form: { gap: space[4] },
  field: { gap: space[2] },
  label: { ...type.small, color: colors.foreground, fontWeight: '600' },
  input: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.input,
    backgroundColor: colors.card,
    color: colors.foreground,
    paddingHorizontal: space[4],
    ...type.body,
  },
  keyInput: { fontFamily: type.mono.fontFamily, fontSize: 12 },
  hint: { ...type.small, color: colors.mutedForeground },
});
