import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar, Card, Divider, Empty, ErrorBox, Loading, Pill, Row, Screen, SectionHeader, text, type Tone } from '@/components/ui';
import { expectedCash, summarizeEntries, roleRank, useCajaCashFlow, useCajaEntries, useLastClosedCaja } from '@/features/team/queries';
import { useCurrentCaja, useOpenShifts, useStaffList, useStaffNames } from '@/lib/common-queries';
import { elapsed, money, timeShort } from '@/lib/format';
import type { Role } from '@/lib/schemas';
import { colors, space, touch } from '@/theme';

const ROLE_TONE: Record<Role, Tone> = { admin: 'brand', manager: 'success', cashier: 'default', kitchen: 'default' };

export default function TeamScreen() {
  const router = useRouter();
  const nameOf = useStaffNames();

  const shifts = useOpenShifts();
  const staff = useStaffList();
  const caja = useCurrentCaja();
  const lastClosed = useLastClosedCaja();

  const openEntries = useCajaEntries(caja.data?.id ?? null);
  const closedCashFlow = useCajaCashFlow(!caja.data ? (lastClosed.data?.id ?? null) : null);
  const closedEntries = useCajaEntries(!caja.data ? (lastClosed.data?.id ?? null) : null);

  const refreshing = shifts.isFetching || staff.isFetching || caja.isFetching;
  const refresh = () => {
    void shifts.refetch();
    void staff.refetch();
    void caja.refetch();
    void lastClosed.refetch();
  };

  const sortedStaff = [...(staff.data ?? [])].sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name));

  let closedDiff: number | null = null;
  if (!caja.data && lastClosed.data && closedCashFlow.data && closedEntries.data) {
    const { entriesIn, entriesOut } = summarizeEntries(closedEntries.data);
    closedDiff =
      (lastClosed.data.closing_cash ?? 0) -
      expectedCash({ openingCash: lastClosed.data.opening_cash, cashSales: closedCashFlow.data.cashSales, cashRefunds: closedCashFlow.data.cashRefunds, entriesIn, entriesOut });
  }

  return (
    <Screen padTop refreshing={refreshing} onRefresh={refresh}>
      <Text style={text.h1}>Team</Text>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="On shift now" />
        <Card>
          {shifts.error ? (
            <ErrorBox message={shifts.error.message} onRetry={refresh} />
          ) : shifts.data && shifts.data.length > 0 ? (
            shifts.data.map((sh, i) => (
              <View key={sh.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  leading={<Avatar name={nameOf(sh.staff_id)} />}
                  title={nameOf(sh.staff_id)}
                  subtitle={`since ${timeShort(sh.clock_in)}`}
                  right={elapsed(sh.clock_in)}
                  onPress={() => {
                    router.push({ pathname: '/staff/[id]', params: { id: sh.staff_id } });
                  }}
                />
              </View>
            ))
          ) : (
            <Empty icon="people-outline" title="Nobody clocked in" />
          )}
        </Card>
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader
          title="Register"
          action="History"
          onAction={() => {
            router.push('/caja');
          }}
        />
        <Card>
          {caja.error ? (
            <ErrorBox message={caja.error.message} onRetry={refresh} />
          ) : caja.isPending ? (
            <Loading />
          ) : caja.data ? (
            <View style={s.registerBody}>
              <View style={s.registerHead}>
                <Pill tone="success" icon="radio-button-on" label={`Open since ${timeShort(caja.data.opened_at)}`} />
              </View>
              <Text style={text.muted}>Opened by {nameOf(caja.data.opened_by)}</Text>
              <View style={s.registerStats}>
                <Text style={text.small}>Opening cash: {money(caja.data.opening_cash)}</Text>
                <Text style={text.small}>{openEntries.data?.length ?? 0} entries</Text>
              </View>
            </View>
          ) : lastClosed.data ? (
            <View style={s.registerBody}>
              <View style={s.registerHead}>
                <Pill tone="default" icon="radio-button-off" label="Closed" />
                {closedDiff != null ? (
                  <Pill
                    tone={Math.abs(closedDiff) < 1 ? 'success' : 'warning'}
                    icon={Math.abs(closedDiff) < 1 ? 'checkmark-circle' : 'alert-circle'}
                    label={`Diff ${money(closedDiff)}`}
                  />
                ) : null}
              </View>
              <Text style={text.muted}>Last closed {timeShort(lastClosed.data.closed_at ?? lastClosed.data.opened_at)} by {nameOf(lastClosed.data.closed_by)}</Text>
            </View>
          ) : (
            <Empty icon="cash-outline" title="No register sessions yet" />
          )}
        </Card>
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="Staff" />
        <Card>
          {staff.error ? (
            <ErrorBox message={staff.error.message} onRetry={refresh} />
          ) : sortedStaff.length === 0 ? (
            <Empty icon="person-outline" title="No staff yet" />
          ) : (
            sortedStaff.map((p, i) => (
              <View key={p.id}>
                {i > 0 ? <Divider /> : null}
                <Pressable
                  onPress={() => {
                    router.push({ pathname: '/staff/[id]', params: { id: p.id } });
                  }}
                  style={({ pressed }) => [s.staffRow, !p.is_active ? s.inactive : null, pressed ? { backgroundColor: colors.accent } : null]}>
                  <Avatar name={p.name} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={text.small} numberOfLines={1}>
                      {p.name}
                    </Text>
                    {!p.is_active ? <Text style={text.muted}>Inactive</Text> : null}
                  </View>
                  <Pill tone={ROLE_TONE[p.role]} label={p.role} />
                </Pressable>
              </View>
            ))
          )}
        </Card>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  registerBody: { padding: space[4], gap: space[2] },
  registerHead: { flexDirection: 'row', alignItems: 'center', gap: space[2], flexWrap: 'wrap' },
  registerStats: { flexDirection: 'row', justifyContent: 'space-between' },
  staffRow: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: touch.min, paddingHorizontal: space[4], paddingVertical: space[2] },
  inactive: { opacity: 0.5 },
});
