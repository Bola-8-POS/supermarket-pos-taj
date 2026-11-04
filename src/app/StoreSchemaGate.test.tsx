import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import enCommon from '@shared/lib/i18n/locales/en-US/common.json';
import esCommon from '@shared/lib/i18n/locales/es-MX/common.json';
import { resetStoreRuntimeConfigForTests } from '@shared/lib/store-mode';
import type { StoreSchemaState } from '@shared/lib/store-schema/classify';
import { getExpectedSchema } from '@shared/lib/store-schema/expected';
import { useStoreSchemaStore } from '@shared/lib/store-schema/store';
import { useUpdaterStore, type UpdateCheckOutcome } from '@shared/lib/useAppUpdater';
import { StoreUpdatingBanner } from '@shared/ui/StoreUpdatingBanner';
import { StoreSchemaGate } from './StoreSchemaGate';

const refreshMock = vi.fn(() => Promise.resolve({ kind: 'ok' } as StoreSchemaState));

function setState(state: StoreSchemaState) {
  useStoreSchemaStore.setState({ state, checkedAt: Date.now(), refresh: refreshMock });
}

beforeEach(() => {
  refreshMock.mockClear();
  resetStoreRuntimeConfigForTests();
  setState({ kind: 'ok' });
});

describe('StoreSchemaGate', () => {
  it('renders_children_when_ok', () => {
    render(<StoreSchemaGate><p>app</p></StoreSchemaGate>);
    expect(screen.getByText('app')).toBeTruthy();
    expect(screen.queryByTestId('store-schema-gate')).toBeNull();
  });

  it.each<StoreSchemaState>([{ kind: 'unreachable' }, { kind: 'updating' }])(
    'renders_children_when_unreachable_or_updating: %o',
    state => {
      setState(state);
      render(<StoreSchemaGate><p>app</p></StoreSchemaGate>);
      expect(screen.getByText('app')).toBeTruthy();
      expect(screen.queryByTestId('store-schema-gate')).toBeNull();
    }
  );

  it.each<[StoreSchemaState, RegExp, string]>([
    [{ kind: 'client-outdated', server: { maxVersion: '99999999999999', applied: 999 } }, /Update the app on this till/, '99999999999999 / 999'],
    [{ kind: 'server-outdated', server: { maxVersion: '20200101000001', applied: 1 } }, /does not have the update yet/, '20200101000001 / 1'],
    [{ kind: 'inconsistent', server: { maxVersion: '20200101000001', applied: 300 } }, /half-updated/, '20200101000001 / 300'],
    [{ kind: 'missing' }, /could not be read/, '—'],
  ])('renders_the_overlay_for_each_blocking_kind: %o', (state, text, serverText) => {
    setState(state);
    render(<StoreSchemaGate><p>app</p></StoreSchemaGate>);
    expect(screen.queryByText('app')).toBeNull();
    const gate = screen.getByTestId('store-schema-gate');
    expect(gate).toHaveAttribute('data-kind', state.kind);
    expect(gate).toHaveTextContent(text);
    const want = getExpectedSchema();
    expect(screen.getByTestId('store-schema-client-level')).toHaveTextContent(`${want.maxVersion} / ${String(want.applied)}`);
    expect(screen.getByTestId('store-schema-server-level')).toHaveTextContent(serverText);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('retry_calls_refresh', () => {
    setState({ kind: 'missing' });
    render(<StoreSchemaGate><p>app</p></StoreSchemaGate>);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('gate_renders_nothing_extra_in_cloud_mode', () => {
    // Cloud mode never probes, so the store stays at its initial non-blocking state.
    useStoreSchemaStore.setState({ state: { kind: 'unreachable' }, checkedAt: 0 });
    const { container } = render(<StoreSchemaGate><p>app</p></StoreSchemaGate>);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe('P');
  });
});

describe('StoreSchemaGate update button', () => {
  it.each<[UpdateCheckOutcome, RegExp | null]>([
    ['none', /No update is available yet/],
    ['deferred', /Waiting for the store server/],
    ['error', /Could not check for the update/],
    ['skipped', /update window has ended/],
    ['available', null],
  ])('update_now_maps_each_outcome: %s', async (outcome, text) => {
    setState({ kind: 'client-outdated', server: { maxVersion: '99999999999999', applied: 999 } });
    const check = vi.fn(() => Promise.resolve(outcome));
    useUpdaterStore.setState({ checkForUpdates: check });
    render(<StoreSchemaGate><p>app</p></StoreSchemaGate>);
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    await waitFor(() => {
      expect(check).toHaveBeenCalledTimes(1);
    });
    if (text) expect(await screen.findByTestId('store-schema-update-message')).toHaveTextContent(text);
    else expect(screen.queryByTestId('store-schema-update-message')).toBeNull();
  });
});

describe('StoreUpdatingBanner', () => {
  it('banner_shows_only_when_updating', () => {
    setState({ kind: 'ok' });
    const { rerender } = render(<StoreUpdatingBanner />);
    expect(screen.queryByTestId('store-updating-banner')).toBeNull();
    setState({ kind: 'updating' });
    rerender(<StoreUpdatingBanner />);
    const banner = screen.getByTestId('store-updating-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent(/store is updating/i);
  });
});

describe('storeSchema catalogs', () => {
  it('locales_have_identical_storeSchema_keys', () => {
    const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
    expect(keys(esCommon.storeSchema)).toEqual(keys(enCommon.storeSchema));
    expect(keys(enCommon.storeSchema)).toEqual(
      ['clientLevel', 'clientOutdated', 'inconsistent', 'missing', 'retry', 'serverLevel', 'serverOutdated', 'title', 'updateError', 'updateNone', 'updateNow', 'updateSkipped', 'updateWaiting', 'updating']
    );
  });
});
