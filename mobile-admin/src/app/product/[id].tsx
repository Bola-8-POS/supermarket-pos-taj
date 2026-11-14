import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Card, Divider, Empty, ErrorBox, Kpi, Loading, Screen, SectionHeader, text, toneColor } from '@/components/ui';
import { marginPct, reasonLabel, useProductDetail, useProductMovements } from '@/features/inventory/queries';
import { useStaffNames } from '@/lib/common-queries';
import { dateTime, daysUntil, money, pct } from '@/lib/format';
import { space, touch } from '@/theme';

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = useProductDetail(id);
  const movements = useProductMovements(id, 20);
  const nameOf = useStaffNames();

  const refreshing = detail.isFetching || movements.isFetching;
  const refresh = () => {
    void detail.refetch();
    void movements.refetch();
  };

  if (detail.isPending) return <Loading />;
  if (detail.error) return <ErrorBox message={detail.error.message} onRetry={refresh} />;

  const { product, inventory } = detail.data;
  const margin = marginPct(product.base_price, inventory?.cost_price ?? null);
  const daysLeft = inventory?.expiry_date ? daysUntil(inventory.expiry_date) : null;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <View style={{ gap: 4 }}>
        <Text style={text.h1}>{product.name}</Text>
        <Text style={text.muted}>
          {[product.categories?.name, product.sku ? `SKU ${product.sku}` : null, product.barcode].filter(Boolean).join(' · ') || '—'}
        </Text>
      </View>

      <View style={s.kpiGrid}>
        <Kpi label="Price" value={money(product.base_price)} />
        <Kpi label="Cost" value={inventory?.cost_price != null ? money(inventory.cost_price) : '—'} />
        <Kpi label="Margin" value={pct(margin)} tone={margin != null && margin < 0 ? 'danger' : 'default'} />
        <Kpi
          label="On hand"
          value={inventory ? `${String(inventory.quantity_on_hand)} ${inventory.unit}` : '—'}
          tone={inventory && inventory.quantity_on_hand <= inventory.low_stock_threshold ? 'warning' : 'default'}
        />
        <Kpi
          label="Expiry"
          value={daysLeft == null ? '—' : daysLeft < 0 ? 'Expired' : `${String(daysLeft)}d`}
          tone={daysLeft != null && daysLeft < 3 ? 'danger' : daysLeft != null && daysLeft < 14 ? 'warning' : 'default'}
          hint={inventory?.expiry_date ?? undefined}
        />
        <Kpi label="Low-stock min" value={inventory ? String(inventory.low_stock_threshold) : '—'} />
      </View>

      <View style={{ gap: space[2] }}>
        <SectionHeader title="Movements" />
        <Card>
          {movements.error ? (
            <ErrorBox message={movements.error.message} />
          ) : movements.data && movements.data.length > 0 ? (
            movements.data.map((m, i) => (
              <View key={m.id}>
                {i > 0 ? <Divider /> : null}
                <View style={s.moveRow}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={text.body}>{reasonLabel(m.reason)}</Text>
                    <Text style={text.muted} numberOfLines={1}>
                      {[dateTime(m.created_at), nameOf(m.staff_id), m.notes].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  <Text style={[text.body, { fontWeight: '700', color: toneColor(m.quantity_delta >= 0 ? 'success' : 'danger') }]}>
                    {m.quantity_delta > 0 ? '+' : ''}
                    {m.quantity_delta}
                  </Text>
                </View>
              </View>
            ))
          ) : (
            <Empty icon="swap-vertical-outline" title="No movements yet" />
          )}
        </Card>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[4],
    minHeight: touch.comfy,
    paddingVertical: space[2],
  },
});
