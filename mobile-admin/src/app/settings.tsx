import { useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { Alert } from 'react-native';

import { BrandFooter, Button, Card, Divider, Row, Screen } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useStoreName } from '@/lib/common-queries';
import { useServer } from '@/lib/server';

export default function SettingsScreen() {
  const { profile, signOut } = useAuth();
  const { config, clearConfig } = useServer();
  const queryClient = useQueryClient();
  const storeName = useStoreName();

  const doSignOut = () => {
    Alert.alert('Sign out', 'You will need to sign in again to use this app.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ]);
  };

  const changeStore = () => {
    Alert.alert('Change store', 'This signs you out and removes this store configuration from this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Change store',
        style: 'destructive',
        onPress: () => {
          queryClient.clear();
          void clearConfig();
        },
      },
    ]);
  };

  return (
    <Screen padTop>
      <Card>
        <Row title={profile?.name ?? '—'} icon="person-outline" />
        <Divider />
        <Row title={profile?.role ?? '—'} subtitle="Role" icon="shield-checkmark-outline" />
      </Card>

      <Card>
        <Row title={storeName.data ?? 'Store'} subtitle="Store name" icon="storefront-outline" />
        <Divider />
        <Row title={config?.url ?? 'Not configured'} subtitle="Active store server" icon="server-outline" />
        <Divider />
        <Row title={Constants.expoConfig?.version ?? '—'} subtitle="App version" icon="information-circle-outline" />
      </Card>

      <Button title="Change store" tone="ghost" icon="server-outline" onPress={changeStore} />
      <Button title="Sign out" tone="danger" icon="log-out-outline" onPress={doSignOut} />
      <BrandFooter />
    </Screen>
  );
}
