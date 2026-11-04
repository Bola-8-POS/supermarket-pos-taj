import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { Card, Divider, Empty, ErrorBox, Loading, Row, Screen, SectionHeader, text } from '@/components/ui';
import { useTransactionDetail } from '@/features/sales/queries';
import { useStaffNames } from '@/lib/common-queries';
import { dateTime, methodLabel, money } from '@/lib/format';
import type { OrderItem, Payment, Refund } from '@/lib/schemas';
import { colors, space } from '@/theme';

function lineItemSubtitle(item: OrderItem): string {
  const qty = item.weight_grams != null ? `${(item.weight_grams / 1000).toFixed(3)} kg` : `${String(item.quantity)} ×`;
  const base = `${qty} ${money(item.unit_price)}`;
  return item.discount_amount && item.discount_amount > 0 ? `${base} · −${money(item.discount_amount)} discount` : base;
}

function lineItemTotal(item: OrderItem): number {
  return item.quantity * item.unit_price - (item.discount_amount ?? 0);
}

// Mirrors today/queries.ts' summarize(): only 'completed' payments are settled money
// (excludes pending/disputed bank transfers and reopened/voided sales).
function isSettled(p: Payment): boolean {
  return p.status === 'completed';
}

export default function TransactionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const nameOf = useStaffNames();
  const { data, error, isPending, refetch } = useTransactionDetail(id);

  if (isPending) return <Loading />;
  if (error)
    return (
      <ErrorBox
        message={error.message}
        onRetry={() => {
          void refetch();
        }}
      />
    );

  const { tab, orderItems, payments, refunds } = data;
  const grandTotal = payments.filter(p => !p.is_refund && isSettled(p)).reduce((s, p) => s + p.amount, 0);

  return (
    <Screen padTop>
      <View style={{ gap: 4 }}>
        <Text style={text.h1} numberOfLines={1}>
          {tab.customer_name ?? `Ticket ${tab.id.slice(0, 6).toUpperCase()}`}
        </Text>
        <Text style={text.muted}>
          {tab.closed_at ? dateTime(tab.closed_at) : dateTime(tab.opened_at)} · {nameOf(tab.staff_id)}
        </Text>
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="Line items" />
        <Card>
          {orderItems.length === 0 ? (
            <Empty title="No line items" />
          ) : (
            orderItems.map((item, i) => (
              <View key={item.id}>
                {i > 0 ? <Divider /> : null}
                <Row title={item.products?.name ?? 'Unknown product'} subtitle={lineItemSubtitle(item)} right={money(lineItemTotal(item))} />
              </View>
            ))
          )}
        </Card>
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="Payments" />
        <Card>
          {payments.length === 0 ? (
            <Empty title="No payments" />
          ) : (
            payments.map((p: Payment, i) => (
              <View key={p.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  title={methodLabel[p.method] ?? p.method}
                  subtitle={`${p.status}${p.reference_number ? ` · ${p.reference_number}` : ''}`}
                  right={`${p.is_refund ? '−' : ''}${money(Math.abs(p.amount))}`}
                />
              </View>
            ))
          )}
        </Card>
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="Refunds" />
        <Card>
          {refunds.length === 0 ? (
            <Empty title="No refunds" />
          ) : (
            refunds.map((r: Refund, i) => (
              <View key={r.id}>
                {i > 0 ? <Divider /> : null}
                <Row title={r.reason} subtitle={`${nameOf(r.created_by)} · ${dateTime(r.created_at)}`} right={money(r.amount)} />
              </View>
            ))
          )}
        </Card>
      </View>

      <Card style={{ padding: space[4], flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={text.h2}>Total</Text>
        <Text style={[text.h1, { color: colors.brand }]}>{money(grandTotal)}</Text>
      </Card>
    </Screen>
  );
}
