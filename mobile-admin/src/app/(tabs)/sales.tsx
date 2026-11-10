import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Bars, Card, Chips, Columns, Divider, Empty, ErrorBox, Kpi, Loading, Row, Screen, SectionHeader, text } from '@/components/ui';
import {
  aggregatePaymentMethods,
  busiestHourIndex,
  categoryBars,
  fillHours,
  summarizeRange,
  topN,
  useCategoryRevenueReport,
  usePaymentMethodsReport,
  usePeakHoursReport,
  useProductSalesReport,
  useSalesPayments,
} from '@/features/sales/queries';
import { money, pct, plural, rangeFor, type RangeKey } from '@/lib/format';
import { colors, space } from '@/theme';

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

export default function SalesScreen() {
  const router = useRouter();
  const [rangeKey, setRangeKey] = useState<RangeKey>('today');
  const range = useMemo(() => rangeFor(rangeKey), [rangeKey]);

  const payments = useSalesPayments(range);
  const methods = usePaymentMethodsReport(range);
  const hours = usePeakHoursReport(range);
  const products = useProductSalesReport(range);
  const categories = useCategoryRevenueReport(range);

  const refreshing = payments.isFetching || methods.isFetching || hours.isFetching || products.isFetching || categories.isFetching;
  const refresh = () => {
    void payments.refetch();
    void methods.refetch();
    void hours.refetch();
    void products.refetch();
    void categories.refetch();
  };

  const sum = payments.data ? summarizeRange(payments.data) : null;
  const methodBars = methods.data ? aggregatePaymentMethods(methods.data) : [];
  const hourBars = hours.data ? fillHours(hours.data) : [];
  const busiest = busiestHourIndex(hourBars);
  const topProducts = products.data ? topN(products.data, 10) : [];
  const categoryBarData = categories.data ? categoryBars(categories.data) : [];

  return (
    <Screen padTop refreshing={refreshing} onRefresh={refresh}>
      <View style={s.headRow}>
        <Text style={text.h1}>Sales</Text>
        <Pressable
          onPress={() => {
            router.push('/transactions');
          }}
          hitSlop={8}>
          <Text style={[text.small, { color: colors.brand, fontWeight: '600' }]}>Transactions</Text>
        </Pressable>
      </View>

      <Chips options={RANGE_OPTIONS} value={rangeKey} onChange={setRangeKey} />

      {payments.error ? <ErrorBox message={payments.error.message} onRetry={refresh} /> : null}

      <View style={s.kpiGrid}>
        <Kpi label="Revenue" value={money(sum?.revenue)} tone="brand" hint={sum ? plural(sum.tickets, 'ticket') : ' '} />
        <Kpi label="Avg ticket" value={money(sum?.avgTicket)} />
        <Kpi
          label="Refunds"
          value={money(sum?.refunds)}
          tone={sum && sum.refunds > 0 ? 'danger' : 'default'}
          hint={sum ? `${String(sum.refundCount)} today` : ' '}
        />
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="Payment methods" />
        <Card style={{ padding: space[4] }}>
          {methods.error ? (
            <ErrorBox
              message={methods.error.message}
              onRetry={() => {
                void methods.refetch();
              }}
            />
          ) : methods.isPending ? (
            <Loading />
          ) : methodBars.length === 0 ? (
            <Empty title="No payments in range" />
          ) : (
            <Bars data={methodBars} formatValue={money} />
          )}
        </Card>
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="By hour" />
        <Card style={{ padding: space[4] }}>
          {hours.error ? (
            <ErrorBox
              message={hours.error.message}
              onRetry={() => {
                void hours.refetch();
              }}
            />
          ) : hours.isPending ? (
            <Loading />
          ) : (
            <Columns data={hourBars} highlightIndex={busiest} />
          )}
        </Card>
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="Top products" />
        <Card>
          {products.error ? (
            <ErrorBox
              message={products.error.message}
              onRetry={() => {
                void products.refetch();
              }}
            />
          ) : products.isPending ? (
            <Loading />
          ) : topProducts.length === 0 ? (
            <Empty title="No sales in range" />
          ) : (
            topProducts.map((p, i) => (
              <View key={p.productId}>
                {i > 0 ? <Divider /> : null}
                <Row
                  title={p.productName ?? 'Unknown product'}
                  subtitle={`${plural(p.units, 'unit')}${p.marginPct != null ? ` · ${pct(p.marginPct)} margin` : ''}`}
                  right={money(p.revenue)}
                />
              </View>
            ))
          )}
        </Card>
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="By category" />
        <Card style={{ padding: space[4] }}>
          {categories.error ? (
            <ErrorBox
              message={categories.error.message}
              onRetry={() => {
                void categories.refetch();
              }}
            />
          ) : categories.isPending ? (
            <Loading />
          ) : categoryBarData.length === 0 ? (
            <Empty title="No sales in range" />
          ) : (
            <Bars data={categoryBarData} formatValue={money} />
          )}
        </Card>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
});
