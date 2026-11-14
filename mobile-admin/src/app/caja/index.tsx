import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { Card, Divider, Empty, ErrorBox, Row, Screen, SectionHeader } from '@/components/ui';
import { useClosedCajaSessions } from '@/features/team/queries';
import { useCurrentCaja, useStaffNames } from '@/lib/common-queries';
import { dateTime, money, timeShort } from '@/lib/format';
import { space } from '@/theme';

export default function CajaListScreen() {
  const router = useRouter();
  const nameOf = useStaffNames();

  const current = useCurrentCaja();
  const closed = useClosedCajaSessions(30);

  const refreshing = current.isFetching || closed.isFetching;
  const refresh = () => {
    void current.refetch();
    void closed.refetch();
  };
  const openSession = current.data ?? null;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {(current.error ?? closed.error) ? <ErrorBox message={(current.error ?? closed.error)?.message ?? ''} onRetry={refresh} /> : null}

      {openSession ? (
        <View style={{ gap: space[2] }}>
          <SectionHeader title="Open now" />
          <Card>
            <Row
              icon="radio-button-on"
              iconTone="success"
              title={`Opened ${timeShort(openSession.opened_at)} by ${nameOf(openSession.opened_by)}`}
              subtitle={`Opening cash ${money(openSession.opening_cash)}`}
              onPress={() => {
                router.push({ pathname: '/caja/[id]', params: { id: openSession.id } });
              }}
            />
          </Card>
        </View>
      ) : null}

      <View style={{ gap: space[2] }}>
        <SectionHeader title="Closed sessions" />
        <Card>
          {closed.data && closed.data.length > 0 ? (
            closed.data.map((sess, i) => (
              <View key={sess.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  title={sess.closed_at ? dateTime(sess.closed_at) : dateTime(sess.opened_at)}
                  subtitle={`By ${nameOf(sess.closed_by)} · Opening ${money(sess.opening_cash)} → Closing ${money(sess.closing_cash)}`}
                  onPress={() => {
                    router.push({ pathname: '/caja/[id]', params: { id: sess.id } });
                  }}
                />
              </View>
            ))
          ) : (
            <Empty icon="cash-outline" title="No closed sessions yet" />
          )}
        </Card>
      </View>
    </Screen>
  );
}
