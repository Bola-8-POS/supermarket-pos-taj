import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreSchemaState } from './classify';

const probeMock = vi.hoisted(() => vi.fn<() => Promise<StoreSchemaState>>());
vi.mock('./probe', () => ({ probeStoreSchema: probeMock }));
vi.mock('../connectivity', () => ({ isOnline: () => true }));

import { guardWrite } from './guard';
import { useStoreSchemaStore } from './store';

beforeEach(() => {
  probeMock.mockReset();
  useStoreSchemaStore.setState({ state: { kind: 'unreachable' }, checkedAt: 0 });
});

describe('guardWrite message', () => {
  it('blocking_rejects_with_STORE_SCHEMA_MISMATCH', async () => {
    useStoreSchemaStore.setState({
      state: { kind: 'server-outdated', server: { maxVersion: '20200101000001', applied: 1 } },
      checkedAt: Date.now(),
    });
    await expect(guardWrite()).rejects.toThrow(/^STORE_SCHEMA_MISMATCH: server-outdated \(server 20200101000001\/1, till \d{14}\/\d+\)$/);
  });

  it('ok_fresh_sends_without_a_probe', async () => {
    useStoreSchemaStore.setState({ state: { kind: 'ok' }, checkedAt: Date.now() });
    await guardWrite();
    expect(probeMock).not.toHaveBeenCalled();
  });
});
