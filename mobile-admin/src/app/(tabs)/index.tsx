import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar, Card, Divider, Empty, ErrorBox, Kpi, Pill, Row, Screen, SectionHeader, text } from '@/components/ui';
import { summarize, useAttentionCounts, useRecentSales, useTodayPayments, useTodayRealtime } from '@/features/today/queries';
import { useAuth } from '@/lib/auth';
import { useCurrentCaja, useNearExpiryDays, useOpenShifts, useStaffNames, useStoreName } from '@/lib/common-queries';
import { dateLong, elapsed, methodLabel, money, plural, timeShort } from '@/lib/format';
import { colors, space } from '@/theme';

export default function TodayScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  useTodayRealtime();

  const storeName = useStoreName();
  const caja = useCurrentCaja();
  const shifts = useOpenShifts();
  const payments = useTodayPayments();
  const recent = useRecentSales(5);
  const nearDays = useNearExpiryDays();
  const attention = useAttentionCounts(nearDays.data ?? 14);
  const nameOf = useStaffNames();

  const refreshing = payments.isFetching || caja.isFetching || shifts.isFetching || attention.isFetching;
  const refresh = () => {
    void payments.refetch();
    void caja.refetch();
    void shifts.refetch();
    void recent.refetch();
    void attention.refetch();
  };

  const sum = payments.data ? summarize(payments.data) : null;
  const a = attention.data;
  const attentionItems = [
    a && a.pendingTransfers > 0
      ? { key: 'transfers', title: 'Pending bank transfers', count: a.pendingTransfers, icon: 'swap-horizontal' as const, tone: 'brand' as const, href: '/transfers' as const }
      : null,
    a && a.lowStock > 0
      ? { key: 'low', title: 'Low stock', count: a.lowStock, icon: 'cube' as const, tone: 'warning' as const, href: '/(tabs)/inventory?seg=low' as const }
      : null,
    a && a.nearExpiry > 0
      ? { key: 'exp', title: 'Near expiry', count: a.nearExpiry, icon: 'time' as const, tone: 'danger' as const, href: '/(tabs)/inventory?seg=expiry' as const }
      : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  return (
    <Screen padTop refreshing={refreshing} onRefresh={refresh}>
      <View style={{ gap: 4 }}>
        <Text style={text.muted}>{dateLong(new Date())}</Text>
        <View style={s.headRow}>
          <Text style={text.h1} numberOfLines={1}>
            {storeName.data ?? 'Store'}
          </Text>
          {caja.data ? (
            <Pill tone="success" icon="radio-button-on" label={`Register open · ${timeShort(caja.data.opened_at)}`} />
          ) : (
            <Pill tone="default" icon="radio-button-off" label="Register closed" />
          )}
        </View>
        <Text style={text.muted}>Hi {profile?.name.split(' ')[0]}</Text>
      </View>

      {payments.error ? <ErrorBox message={payments.error.message} onRetry={refresh} /> : null}

      <View style={s.kpiGrid}>
        <Kpi label="Sales today" value={money(sum?.revenue)} tone="brand" hint={sum ? plural(sum.tickets, 'ticket') : ' '} />
        <Kpi label="Avg ticket" value={money(sum?.avgTicket)} />
        <Kpi label="Refunds" value={money(sum?.refunds)} tone={sum && sum.refunds > 0 ? 'danger' : 'default'} hint={sum ? `${String(sum.refundCount)} today` : ' '} />
        <Kpi label="On shift" value={String(shifts.data?.length ?? 0)} hint="staff clocked in" />
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="Needs attention" />
        <Card>
          {attention.error ? (
            <ErrorBox message={attention.error.message} />
          ) : attentionItems.length === 0 ? (
            <Empty title="All clear" hint="No pending transfers, low stock or near-expiry items." />
          ) : (
            attentionItems.map((it, i) => (
              <View key={it.key}>
                {i > 0 ? <Divider /> : null}
                <Row title={it.title} icon={it.icon} iconTone={it.tone} right={String(it.count)} onPress={() => { router.push(it.href); }} />
              </View>
            ))
          )}
        </Card>
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="On shift now" action="Team" onAction={() => { router.push('/(tabs)/team'); }} />
        <Card>
          {shifts.data && shifts.data.length > 0 ? (
            shifts.data.map((sh, i) => (
              <View key={sh.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  leading={<Avatar name={nameOf(sh.staff_id)} />}
                  title={nameOf(sh.staff_id)}
                  subtitle={`since ${timeShort(sh.clock_in)}`}
                  right={elapsed(sh.clock_in)}
                  onPress={() => { router.push({ pathname: '/staff/[id]', params: { id: sh.staff_id } }); }}
                />
              </View>
            ))
          ) : (
            <Empty icon="people-outline" title="Nobody clocked in" />
          )}
        </Card>
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="Last sales" action="All" onAction={() => { router.push('/transactions'); }} />
        <Card>
          {recent.data && recent.data.length > 0 ? (
            recent.data.map((t, i) => (
              <View key={t.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  title={t.customer_name ?? `Ticket ${t.id.slice(0, 6).toUpperCase()}`}
                  subtitle={`${t.closed_at ? timeShort(t.closed_at) : ''} · ${nameOf(t.staff_id)} · ${t.methods.map(m => methodLabel[m] ?? m).join(' + ')}`}
                  right={money(t.total)}
                  onPress={() => { router.push({ pathname: '/transactions/[id]', params: { id: t.id } }); }}
                />
              </View>
            ))
          ) : (
            <Empty icon="receipt-outline" title="No sales yet" />
          )}
        </Card>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[3] },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
  dim: { color: colors.mutedForeground },
});
