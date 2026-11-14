import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, Chips, Divider, Empty, ErrorBox, Loading, Pill, Screen, text, toneColor, type Tone } from '@/components/ui';
import { transferAgeTone, useTransferHistory, usePendingTransfers, type TransferRow } from '@/features/more/queries';
import { elapsed, money } from '@/lib/format';
import { colors, space, touch } from '@/theme';

type Segment = 'pending' | 'history';

export default function TransfersScreen() {
  const router = useRouter();
  const [seg, setSeg] = useState<Segment>('pending');
  const pending = usePendingTransfers();
  const history = useTransferHistory(50);
  const active = seg === 'pending' ? pending : history;

  const openDetail = (id: string) => {
    router.push({ pathname: '/transfers/[id]', params: { id } });
  };

  return (
    <Screen refreshing={active.isFetching} onRefresh={() => void active.refetch()}>
      <Chips
        options={[
          { key: 'pending', label: 'Pending' },
          { key: 'history', label: 'History' },
        ]}
        value={seg}
        onChange={setSeg}
      />

      {active.error ? <ErrorBox message={active.error.message} onRetry={() => void active.refetch()} /> : null}

      {active.isLoading ? (
        <Loading />
      ) : (
        <Card>
          {!active.data || active.data.length === 0 ? (
            <Empty icon="swap-horizontal" title={seg === 'pending' ? 'No pending transfers' : 'No history yet'} />
          ) : (
            active.data.map((t, i) => (
              <View key={t.id}>
                {i > 0 ? <Divider /> : null}
                <TransferListRow
                  transfer={t}
                  pending={seg === 'pending'}
                  onPress={() => {
                    openDetail(t.id);
                  }}
                />
              </View>
            ))
          )}
        </Card>
      )}
    </Screen>
  );
}

function TransferListRow({ transfer, pending, onPress }: { transfer: TransferRow; pending: boolean; onPress: () => void }) {
  const title = transfer.payments?.tabs?.customer_name ?? `Ticket ${transfer.payment_id.slice(0, 6).toUpperCase()}`;
  const ageTone: Tone = pending ? transferAgeTone(transfer.created_at) : 'default';
  const statusTone: Tone = transfer.status === 'disputed' ? 'danger' : transfer.status === 'confirmed' ? 'success' : 'default';

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed ? { backgroundColor: colors.accent } : null]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={text.body} numberOfLines={1}>
          {title}
        </Text>
        <Text style={text.muted} numberOfLines={1}>
          {transfer.customer_phone ?? 'No phone on file'}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text style={s.amount}>{money(transfer.payments?.amount)}</Text>
        {pending ? (
          <Text style={[text.small, { color: toneColor(ageTone), fontWeight: '600' }]}>{elapsed(transfer.created_at)}</Text>
        ) : (
          <Pill label={transfer.status} tone={statusTone} />
        )}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[4],
    minHeight: touch.comfy,
    paddingVertical: space[2],
  },
  amount: { ...text.body, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
