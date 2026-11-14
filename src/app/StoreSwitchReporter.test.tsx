import { render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const online = { value: true };
vi.mock('@shared/lib/connectivity', () => ({
  useOnlineStatus: () => online.value,
  isOnline: () => online.value,
}));
const report = vi.fn();
vi.mock('@shared/lib/store-switch/client', () => ({
  reportTillSync: (...a: unknown[]) => report(...a),
  fetchStoreSwitchState: () => Promise.resolve(null),
  backendKey: () => 'b',
}));

import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import { useOfflineSaleStore } from '@entities/offline-sale/model/store';
import { useStaffStore } from '@entities/staff/model/store';
import { useTabStore } from '@entities/tab/model/store';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { movedFlagKey, useStoreSwitchStore } from '@shared/lib/store-switch/store';
import { REPORT_BUSY_MS, REPORT_IDLE_MS, StoreSwitchReporter } from './StoreSwitchReporter';

const queued = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `a${String(i)}`,
    type: 'place-order',
    payload: {},
    expectedVersion: 0,
    timestamp: 0,
    retryCount: 0,
    lastError: null,
    nextAttemptAt: null,
  }));

beforeEach(() => {
  vi.useFakeTimers();
  report.mockReset();
  report.mockResolvedValue(null);
  online.value = true;
  useStaffStore.setState({ isAuthenticated: true });
  useTabStore.setState({ offlineQueue: queued(3) as never, deadLetterQueue: queued(1) as never });
  useStoreSwitchStore.setState({ state: 'active' });
  useOfflineSaleStore.setState({ records: [] });
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  useStaffStore.setState({ isAuthenticated: false });
  useTabStore.setState({ offlineQueue: [], deadLetterQueue: [] });
  useOfflineSaleStore.setState({ records: [] });
});

const sales = (status: OfflineSale['status'], n: number, from = 0): OfflineSale[] =>
  Array.from({ length: n }, (_, i) => makeSale({ status, id: `00000000-0000-4000-8000-${String(from + i).padStart(12, '0')}` }));
const firstReport = async (): Promise<void> => {
  render(<StoreSwitchReporter />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

describe('StoreSwitchReporter', () => {
  it('reports the queue depth, the dead letters and what the till currently knows', async () => {
    render(<StoreSwitchReporter />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(report).toHaveBeenCalledWith({ queueDepth: 3, deadLetterDepth: 1, seenState: 'active' });
  });

  it('reports again at once when the queue changes, and every 10 s once the store is busy', async () => {
    render(<StoreSwitchReporter />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      useTabStore.setState({ offlineQueue: queued(0) as never });
    });
    expect(report).toHaveBeenLastCalledWith({
      queueDepth: 0,
      deadLetterDepth: 1,
      seenState: 'active',
    });
    await act(async () => {
      useStoreSwitchStore.setState({ state: 'draining' });
    });
    expect(report).toHaveBeenLastCalledWith({
      queueDepth: 0,
      deadLetterDepth: 1,
      seenState: 'draining',
    });
    const n = report.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPORT_BUSY_MS);
    });
    expect(report.mock.calls.length).toBe(n + 1);
  });

  it('is quiet while active between the 5-minute beats, signed out, or offline', async () => {
    useStaffStore.setState({ isAuthenticated: false });
    render(<StoreSwitchReporter />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPORT_IDLE_MS * 2);
    });
    expect(report).not.toHaveBeenCalled();
    await act(async () => {
      useStaffStore.setState({ isAuthenticated: true });
      online.value = false;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPORT_IDLE_MS * 2);
    });
    expect(report).not.toHaveBeenCalled();
  });

  it('adopts the state the server answered with', async () => {
    report.mockResolvedValue('frozen');
    render(<StoreSwitchReporter />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useStoreSwitchStore.getState().state).toBe('frozen');
  });

  it('counts queued offline sales in the queue depth', async () => {
    useTabStore.setState({ offlineQueue: [], deadLetterQueue: [] });
    useOfflineSaleStore.setState({ records: sales('queued', 3) });
    await firstReport();
    expect(report).toHaveBeenCalledWith({ queueDepth: 3, deadLetterDepth: 0, seenState: 'active' });
  });

  it('counts a replaying offline sale in the queue depth (it is still unsent)', async () => {
    useTabStore.setState({ offlineQueue: [], deadLetterQueue: [] });
    useOfflineSaleStore.setState({ records: [...sales('queued', 1), ...sales('replaying', 2, 10)] });
    await firstReport();
    expect(report).toHaveBeenCalledWith({ queueDepth: 3, deadLetterDepth: 0, seenState: 'active' });
  });

  it('adds offline sales to the tab queue, and counts needs_review sales as dead letters', async () => {
    useOfflineSaleStore.setState({ records: [...sales('queued', 2), ...sales('needs_review', 1, 10)] });
    await firstReport();
    expect(report).toHaveBeenCalledWith({ queueDepth: 3 + 2, deadLetterDepth: 1 + 1, seenState: 'active' });
  });

  it('does not count confirmed or resolved offline sales', async () => {
    useTabStore.setState({ offlineQueue: [], deadLetterQueue: [] });
    useOfflineSaleStore.setState({ records: [...sales('confirmed', 2), ...sales('resolved', 2, 10)] });
    await firstReport();
    expect(report).toHaveBeenCalledWith({ queueDepth: 0, deadLetterDepth: 0, seenState: 'active' });
  });

  it('persists a moved answer so a restart still knows', async () => {
    report.mockResolvedValue('moved');
    await firstReport();
    expect(localStorage.getItem(movedFlagKey('b'))).toBe('1');
  });

  it('stops reporting once the store has moved', async () => {
    useStoreSwitchStore.setState({ state: 'moved' });
    await firstReport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPORT_BUSY_MS * 3);
    });
    expect(report).not.toHaveBeenCalled();
  });

  it('pins the idle beat at 5 minutes', () => {
    expect(REPORT_IDLE_MS).toBe(300_000);
  });

  it('beats once every REPORT_IDLE_MS while active, signed in and online', async () => {
    await firstReport();
    expect(report).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REPORT_IDLE_MS - 1);
    });
    expect(report).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(report).toHaveBeenCalledTimes(2);
  });
});
