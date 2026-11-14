import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Card, Chips, Divider, Empty, ErrorBox, Loading, Row, Screen } from '@/components/ui';
import { humaniseAction, useAuditLogs } from '@/features/more/queries';
import { useStaffNames } from '@/lib/common-queries';
import { dateTime } from '@/lib/format';

const ALL = '__all__';

export default function AuditScreen() {
  const logs = useAuditLogs(100);
  const nameOf = useStaffNames();
  const [filter, setFilter] = useState<string>(ALL);

  const options = useMemo(() => {
    const types = Array.from(new Set((logs.data ?? []).map(l => l.entity_type))).sort();
    return [{ key: ALL, label: 'All' }, ...types.map(t => ({ key: t, label: t }))];
  }, [logs.data]);

  const rows = (logs.data ?? []).filter(l => filter === ALL || l.entity_type === filter);

  return (
    <Screen padTop refreshing={logs.isFetching} onRefresh={() => void logs.refetch()}>
      <Chips options={options} value={filter} onChange={setFilter} />

      {logs.error ? <ErrorBox message={logs.error.message} onRetry={() => void logs.refetch()} /> : null}

      {logs.isLoading ? (
        <Loading />
      ) : (
        <Card>
          {rows.length === 0 ? (
            <Empty icon="document-text-outline" title="No audit entries" />
          ) : (
            rows.map((l, i) => (
              <View key={l.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  title={humaniseAction(l.action)}
                  subtitle={`${l.entity_type} · ${l.entity_id ? l.entity_id.slice(0, 8) : '—'} · ${nameOf(l.actor_id)}`}
                  right={dateTime(l.created_at)}
                  rightSub={l.source}
                />
              </View>
            ))
          )}
        </Card>
      )}
    </Screen>
  );
}
