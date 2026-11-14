import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Card, Chips, Divider, Empty, ErrorBox, Kpi, Loading, Pill, Row, Screen, SectionHeader, text } from '@/components/ui';
import { deficit, expiryTone, useLowStockInventory, useNearExpiryInventory, useProductSearch } from '@/features/inventory/queries';
import { useNearExpiryDays } from '@/lib/common-queries';
import { dateShort, daysUntil, money } from '@/lib/format';
import { colors, radius, space } from '@/theme';

type Segment = 'low' | 'expiry' | 'search';
const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'low', label: 'Low stock' },
  { key: 'expiry', label: 'Near expiry' },
  { key: 'search', label: 'Search' },
];

export default function InventoryScreen() {
  const params = useLocalSearchParams<{ seg?: string }>();
  const initialSeg: Segment = params.seg === 'expiry' || params.seg === 'search' ? params.seg : 'low';
  const [segment, setSegment] = useState<Segment>(initialSeg);

  const nearDays = useNearExpiryDays();

  return (
    <Screen padTop>
      <Text style={text.h1}>Inventory</Text>
      <Chips options={SEGMENTS} value={segment} onChange={setSegment} />
      {segment === 'low' ? <LowStockSegment /> : null}
      {segment === 'expiry' ? <NearExpirySegment days={nearDays.data ?? 14} /> : null}
      {segment === 'search' ? <SearchSegment /> : null}
    </Screen>
  );
}

function LowStockSegment() {
  const router = useRouter();
  const q = useLowStockInventory();

  if (q.isPending) return <Loading />;
  if (q.error)
    return (
      <ErrorBox
        message={q.error.message}
        onRetry={() => {
          void q.refetch();
        }}
      />
    );

  return (
    <View style={{ gap: space[2] }}>
      <Kpi label="Low stock" value={String(q.data.length)} tone={q.data.length > 0 ? 'warning' : 'default'} hint="items at or below their minimum" />
      <SectionHeader title="Items" />
      <Card>
        {q.data.length === 0 ? (
          <Empty icon="checkmark-circle-outline" title="Nothing low" hint="Every product is above its reorder point." />
        ) : (
          q.data.map((row, i) => (
            <View key={row.id}>
              {i > 0 ? <Divider /> : null}
              <Row
                title={row.products?.name ?? 'Unknown product'}
                subtitle={`${String(row.quantity_on_hand)} on hand · min ${String(row.low_stock_threshold)}`}
                right={money(row.cost_price)}
                leading={<Pill tone={row.quantity_on_hand <= 0 ? 'danger' : 'warning'} label={`-${String(deficit(row))}`} />}
                onPress={() => {
                  router.push({ pathname: '/product/[id]', params: { id: row.product_id } });
                }}
              />
            </View>
          ))
        )}
      </Card>
    </View>
  );
}

function NearExpirySegment({ days }: { days: number }) {
  const router = useRouter();
  const q = useNearExpiryInventory(days);

  if (q.isPending) return <Loading />;
  if (q.error)
    return (
      <ErrorBox
        message={q.error.message}
        onRetry={() => {
          void q.refetch();
        }}
      />
    );

  const totalAtRisk = q.data.reduce((sum, row) => sum + row.quantity_on_hand * (row.cost_price ?? 0), 0);

  return (
    <View style={{ gap: space[2] }}>
      <View style={s.kpiGrid}>
        <Kpi label="Near expiry" value={String(q.data.length)} tone={q.data.length > 0 ? 'danger' : 'default'} hint={`within ${String(days)} days`} />
        <Kpi label="Cost at risk" value={money(totalAtRisk)} />
      </View>
      <SectionHeader title="Items" />
      <Card>
        {q.data.length === 0 ? (
          <Empty icon="checkmark-circle-outline" title="Nothing expiring soon" />
        ) : (
          q.data.map((row, i) => {
            const left = row.expiry_date ? daysUntil(row.expiry_date) : 0;
            const label = left < 0 ? 'Expired' : left === 1 ? '1 day' : `${String(left)} days`;
            return (
              <View key={row.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  title={row.products?.name ?? 'Unknown product'}
                  subtitle={`${String(row.quantity_on_hand)} on hand · ${row.expiry_date ? dateShort(row.expiry_date) : '—'}`}
                  right={label}
                  rightSub={money(row.cost_price)}
                  iconTone={expiryTone(left)}
                  icon="time"
                  onPress={() => {
                    router.push({ pathname: '/product/[id]', params: { id: row.product_id } });
                  }}
                />
              </View>
            );
          })
        )}
      </Card>
    </View>
  );
}

function SearchSegment() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const q = useProductSearch(query);
  const showResults = query.trim().length >= 2;

  return (
    <View style={{ gap: space[2] }}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search by name, barcode or SKU"
        placeholderTextColor={colors.mutedForeground}
        style={s.input}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      {!showResults ? (
        <Empty icon="search-outline" title="Type at least 2 characters" />
      ) : q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox
          message={q.error.message}
          onRetry={() => {
            void q.refetch();
          }}
        />
      ) : (
        <Card>
          {q.data.length === 0 ? (
            <Empty icon="search-outline" title="No matches" />
          ) : (
            q.data.map((p, i) => {
              const inv = p.inventory.at(0);
              return (
                <View key={p.id}>
                  {i > 0 ? <Divider /> : null}
                  <Row
                    title={p.name}
                    subtitle={[p.categories?.name, p.barcode].filter(Boolean).join(' · ')}
                    right={money(p.base_price)}
                    rightSub={inv ? `${String(inv.quantity_on_hand)} on hand` : undefined}
                    onPress={() => {
                      router.push({ pathname: '/product/[id]', params: { id: p.id } });
                    }}
                  />
                </View>
              );
            })
          )}
        </Card>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
  input: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.input,
    paddingHorizontal: space[4],
    color: colors.foreground,
    fontSize: 15,
  },
});
