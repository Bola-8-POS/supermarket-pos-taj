import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar, Card, Chips, Divider, Empty, ErrorBox, Kpi, Loading, Pill, Row, Screen, SectionHeader, text, type Tone } from '@/components/ui';
import { hoursWorked, useStaffProfile, useStaffSales, useStaffShifts } from '@/features/team/queries';
import { dateShort, money, rangeFor, timeShort, type RangeKey } from '@/lib/format';
import type { Role } from '@/lib/schemas';
import { space } from '@/theme';

const ROLE_TONE: Record<Role, Tone> = { admin: 'brand', manager: 'success', cashier: 'default', kitchen: 'default' };

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

export default function StaffDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [rangeKey, setRangeKey] = useState<RangeKey>('today');
  const range = useMemo(() => rangeFor(rangeKey), [rangeKey]);

  const profile = useStaffProfile(id);
  const sales = useStaffSales(id, range);
  const shifts = useStaffShifts(id);

  const refreshing = profile.isFetching || sales.isFetching || shifts.isFetching;
  const refresh = () => {
    void profile.refetch();
    void sales.refetch();
    void shifts.refetch();
  };

  const hours = shifts.data ? hoursWorked(shifts.data, range.from, range.to) : 0;
  const openShiftCount = (shifts.data ?? []).filter(s => !s.clock_out).length;
  const recentShifts = (shifts.data ?? []).slice(0, 30);

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      {profile.error ? <ErrorBox message={profile.error.message} onRetry={refresh} /> : null}

      {profile.isPending ? (
        <Loading />
      ) : !profile.data ? (
        <Empty icon="person-outline" title="Staff member not found" />
      ) : (
        <>
          <View style={s.header}>
            <Avatar name={profile.data.name} size={56} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={text.h1} numberOfLines={1}>
                {profile.data.name}
              </Text>
              <View style={s.headerMeta}>
                <Pill tone={ROLE_TONE[profile.data.role]} label={profile.data.role} />
                {!profile.data.is_active ? <Pill tone="default" label="Inactive" /> : null}
              </View>
            </View>
          </View>

          <Chips options={RANGE_OPTIONS} value={rangeKey} onChange={setRangeKey} />

          {sales.error ? <ErrorBox message={sales.error.message} onRetry={() => void sales.refetch()} /> : null}

          <View style={s.kpiGrid}>
            <Kpi label="Sales attributed" value={money(sales.data?.sales)} tone="brand" />
            <Kpi label="Tickets" value={String(sales.data?.tickets ?? 0)} />
            <Kpi label="Hours worked" value={`${hours.toFixed(1)}h`} hint={openShiftCount > 0 ? `${String(openShiftCount)} shift open` : ' '} />
          </View>

          <View style={{ gap: space[2] }}>
            <SectionHeader title="Shifts" />
            <Card>
              {shifts.error ? (
                <ErrorBox message={shifts.error.message} onRetry={() => void shifts.refetch()} />
              ) : recentShifts.length === 0 ? (
                <Empty icon="time-outline" title="No shifts yet" />
              ) : (
                recentShifts.map((sh, i) => (
                  <View key={sh.id}>
                    {i > 0 ? <Divider /> : null}
                    <Row
                      title={`${dateShort(sh.clock_in)} · ${timeShort(sh.clock_in)} → ${sh.clock_out ? timeShort(sh.clock_out) : 'now'}`}
                      subtitle={`Opening ${money(sh.opening_cash)}${sh.closing_cash != null ? ` · Closing ${money(sh.closing_cash)}` : ''}`}
                      chevron={false}
                    />
                  </View>
                ))
              )}
            </Card>
          </View>
        </>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  headerMeta: { flexDirection: 'row', gap: space[2] },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
});
