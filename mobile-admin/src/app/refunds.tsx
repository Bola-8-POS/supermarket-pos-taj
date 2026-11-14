import { View } from 'react-native';

import { Card, Divider, Empty, ErrorBox, Kpi, Loading, Row, Screen } from '@/components/ui';
import { useRefunds30d, useRefundsList } from '@/features/more/queries';
import { useStaffNames } from '@/lib/common-queries';
import { dateTime, money } from '@/lib/format';
import { space } from '@/theme';

export default function RefundsScreen() {
  const refunds = useRefundsList(100);
  const stats = useRefunds30d();
  const nameOf = useStaffNames();

  const refreshing = refunds.isFetching || stats.isFetching;
  const refresh = () => {
    void refunds.refetch();
    void stats.refetch();
  };

  return (
    <Screen padTop refreshing={refreshing} onRefresh={refresh}>
      <View style={{ flexDirection: 'row', gap: space[3] }}>
        <Kpi label="Refunded (30d)" value={money(stats.data?.total)} tone="danger" hint={stats.data ? `${String(stats.data.count)} refunds` : ' '} />
      </View>

      {refunds.error ? <ErrorBox message={refunds.error.message} onRetry={() => void refunds.refetch()} /> : null}

      {refunds.isLoading ? (
        <Loading />
      ) : (
        <Card>
          {!refunds.data || refunds.data.length === 0 ? (
            <Empty icon="return-up-back-outline" title="No refunds" />
          ) : (
            refunds.data.map((r, i) => {
              const customer = r.payments?.tabs?.customer_name ?? `Ticket ${r.payments?.tab_id.slice(0, 6).toUpperCase() ?? '—'}`;
              return (
                <View key={r.id}>
                  {i > 0 ? <Divider /> : null}
                  <Row
                    title={customer}
                    subtitle={`${r.reason} · ${nameOf(r.created_by)} · ${dateTime(r.created_at)}`}
                    right={money(r.amount)}
                    icon="return-up-back-outline"
                    iconTone="danger"
                  />
                </View>
              );
            })
          )}
        </Card>
      )}
    </Screen>
  );
}
