import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { Card, Divider, Row, Screen, SectionHeader, text } from '@/components/ui';
import { usePendingTransfers } from '@/features/more/queries';
import { useAuth } from '@/lib/auth';
import { space } from '@/theme';

export default function MoreScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const pending = usePendingTransfers();
  const pendingCount = pending.data?.length ?? 0;

  return (
    <Screen padTop refreshing={pending.isFetching} onRefresh={() => void pending.refetch()}>
      <Text style={text.h1}>More</Text>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="Records" />
        <Card>
          <Row
            title="Bank transfers"
            icon="swap-horizontal"
            iconTone="brand"
            right={pendingCount > 0 ? String(pendingCount) : undefined}
            onPress={() => {
              router.push('/transfers');
            }}
          />
          <Divider />
          <Row
            title="Refunds"
            icon="return-up-back-outline"
            onPress={() => {
              router.push('/refunds');
            }}
          />
          <Divider />
          <Row
            title="Audit log"
            icon="document-text-outline"
            onPress={() => {
              router.push('/audit');
            }}
          />
          <Divider />
          <Row
            title="Settings"
            icon="settings-outline"
            onPress={() => {
              router.push('/settings');
            }}
          />
        </Card>
      </View>

      <View style={{ alignItems: 'center', gap: 2, paddingTop: space[4] }}>
        <Text style={text.body}>{profile?.name}</Text>
        <Text style={text.muted}>{profile?.role}</Text>
      </View>
    </Screen>
  );
}
