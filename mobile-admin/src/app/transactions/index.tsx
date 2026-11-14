import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Empty, ErrorBox, Loading, Row } from '@/components/ui';
import { useTransactions, type TransactionRow } from '@/features/sales/queries';
import { useStaffNames } from '@/lib/common-queries';
import { methodLabel, money, timeShort } from '@/lib/format';
import { colors, radius, space, type as typeTokens } from '@/theme';

export default function TransactionsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const nameOf = useStaffNames();

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query);
    }, 250);
    return () => {
      clearTimeout(t);
    };
  }, [query]);

  const { data, error, isPending, isFetching, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useTransactions(debounced);
  const rows = data?.pages.flat() ?? [];

  const renderItem = ({ item }: { item: TransactionRow }) => (
    <Row
      title={item.customer_name ?? `Ticket ${item.id.slice(0, 6).toUpperCase()}`}
      subtitle={`${item.closed_at ? timeShort(item.closed_at) : ''} · ${nameOf(item.staff_id)} · ${
        item.methods.length > 0 ? item.methods.map(m => methodLabel[m] ?? m).join(' + ') : 'No payment'
      }`}
      right={money(item.total)}
      onPress={() => {
        router.push({ pathname: '/transactions/[id]', params: { id: item.id } });
      }}
    />
  );

  return (
    <View style={[s.screen, { paddingTop: space[4] }]}>
      <View style={{ paddingHorizontal: space[4], gap: space[3] }}>
        <View style={s.searchBox}>
          <Ionicons name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search by customer or ticket id"
            placeholderTextColor={colors.mutedForeground}
            style={s.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>
        {error ? (
          <ErrorBox
            message={error.message}
            onRetry={() => {
              void refetch();
            }}
          />
        ) : null}
      </View>

      {isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <View style={{ padding: space[4] }}>
          <Card>
            <Empty icon="receipt-outline" title="No transactions found" hint={debounced ? 'Try a different search.' : undefined} />
          </Card>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={item => item.id}
          contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[6], gap: space[2] }}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !isFetchingNextPage}
              onRefresh={() => {
                void refetch();
              }}
              tintColor={colors.brand}
              colors={[colors.brand]}
            />
          }
          renderItem={({ item }) => <Card>{renderItem({ item })}</Card>}
          ListFooterComponent={
            hasNextPage ? (
              <Button
                title={isFetchingNextPage ? 'Loading…' : 'Load more'}
                tone="ghost"
                loading={isFetchingNextPage}
                onPress={() => {
                  void fetchNextPage();
                }}
                style={{ marginTop: space[3] }}
              />
            ) : null
          }
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    backgroundColor: colors.muted,
    borderRadius: radius.md,
    paddingHorizontal: space[3],
    height: 44,
  },
  searchInput: { flex: 1, color: colors.foreground, ...typeTokens.body, paddingVertical: 0 },
});
