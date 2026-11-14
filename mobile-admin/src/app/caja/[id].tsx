import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Card, Divider, Empty, ErrorBox, Kpi, Loading, Pill, Row, Screen, SectionHeader, text } from '@/components/ui';
import { expectedCash, summarizeEntries, useCajaCashFlow, useCajaEntries, useCajaSessionDetail } from '@/features/team/queries';
import { useStaffNames } from '@/lib/common-queries';
import { dateTime, money } from '@/lib/format';
import { space } from '@/theme';

export default function CajaDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const nameOf = useStaffNames();

  const session = useCajaSessionDetail(id);
  const cashFlow = useCajaCashFlow(id);
  const entries = useCajaEntries(id);

  const refreshing = session.isFetching || cashFlow.isFetching || entries.isFetching;
  const refresh = () => {
    void session.refetch();
    void cashFlow.refetch();
    void entries.refetch();
  };

  const isOpen = session.data?.status === 'open';
  const { entriesIn, entriesOut } = entries.data ? summarizeEntries(entries.data) : { entriesIn: 0, entriesOut: 0 };
  const expected =
    session.data && cashFlow.data
      ? expectedCash({
          openingCash: session.data.opening_cash,
          cashSales: cashFlow.data.cashSales,
          cashRefunds: cashFlow.data.cashRefunds,
          entriesIn,
          entriesOut,
        })
      : null;
  const diff = expected != null && session.data?.closing_cash != null ? session.data.closing_cash - expected : null;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {session.error ? <ErrorBox message={session.error.message} onRetry={refresh} /> : null}
      {cashFlow.error ? <ErrorBox message={cashFlow.error.message} onRetry={refresh} /> : null}
      {entries.error ? <ErrorBox message={entries.error.message} onRetry={refresh} /> : null}

      {session.isPending ? (
        <Loading />
      ) : !session.data ? (
        <Empty icon="cash-outline" title="Session not found" />
      ) : (
        <>
          <View style={s.headRow}>
            <Pill tone={isOpen ? 'success' : 'default'} icon={isOpen ? 'radio-button-on' : 'radio-button-off'} label={isOpen ? 'Open' : 'Closed'} />
            {diff != null ? (
              <Pill tone={Math.abs(diff) < 1 ? 'success' : 'warning'} icon={Math.abs(diff) < 1 ? 'checkmark-circle' : 'alert-circle'} label={`Diff ${money(diff)}`} />
            ) : null}
          </View>

          <View style={{ gap: 2 }}>
            <Text style={text.body}>Opened {dateTime(session.data.opened_at)} by {nameOf(session.data.opened_by)}</Text>
            {session.data.closed_at ? (
              <Text style={text.body}>Closed {dateTime(session.data.closed_at)} by {nameOf(session.data.closed_by)}</Text>
            ) : null}
          </View>

          <View style={s.kpiGrid}>
            <Kpi label="Opening cash" value={money(session.data.opening_cash)} />
            <Kpi label="Cash sales" value={money(cashFlow.data?.cashSales)} tone="brand" />
            <Kpi label="Cash refunds" value={money(cashFlow.data?.cashRefunds)} tone={cashFlow.data && cashFlow.data.cashRefunds > 0 ? 'danger' : 'default'} />
            <Kpi label="Expected cash" value={expected != null ? money(expected) : '—'} />
            <Kpi label="Closing cash" value={session.data.closing_cash != null ? money(session.data.closing_cash) : '—'} />
          </View>

          <View style={{ gap: space[2] }}>
            <SectionHeader title="Entries" />
            <Card>
              {entries.data && entries.data.length > 0 ? (
                entries.data.map((e, i) => (
                  <View key={e.id}>
                    {i > 0 ? <Divider /> : null}
                    <Row
                      icon={e.type === 'expense' ? 'arrow-down-circle-outline' : 'arrow-up-circle-outline'}
                      iconTone={e.type === 'expense' ? 'danger' : 'success'}
                      title={e.concept}
                      subtitle={`${e.type} · ${nameOf(e.staff_id)} · ${dateTime(e.created_at)}`}
                      right={`${e.type === 'expense' ? '-' : '+'}${money(e.amount)}`}
                      chevron={false}
                    />
                  </View>
                ))
              ) : (
                <Empty icon="list-outline" title="No entries" />
              )}
            </Card>
          </View>

          {session.data.notes ? (
            <View style={{ gap: space[2] }}>
              <SectionHeader title="Notes" />
              <Card style={{ padding: space[4] }}>
                <Text style={text.small}>{session.data.notes}</Text>
              </Card>
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  headRow: { flexDirection: 'row', gap: space[2], flexWrap: 'wrap' },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
});
