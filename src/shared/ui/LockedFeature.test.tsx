import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeaturesModule from '@shared/lib/license/features';
import { useUpgradeDialogStore } from '@shared/lib/license/upgrade-dialog-store';
import { LockedFeature } from './LockedFeature';

const featureState = { enabled: true };
vi.mock('@shared/lib/license/features', async importOriginal => {
  const actual = await importOriginal<typeof FeaturesModule>();
  return {
    ...actual,
    useFeature: (key: string) => ({
      enabled: featureState.enabled,
      locked: !featureState.enabled,
      requestUpgrade: () => {
        useUpgradeDialogStore.getState().openFor(key as never);
      },
    }),
  };
});

describe('LockedFeature', () => {
  beforeEach(() => {
    featureState.enabled = true;
    useUpgradeDialogStore.getState().close();
  });

  it('renders the child untouched when enabled', () => {
    render(
      <LockedFeature feature="report_export">
        <button type="button">Export</button>
      </LockedFeature>
    );
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    expect(screen.queryByTestId('locked-feature')).toBeNull();
    expect(screen.queryByTestId('locked-feature-overlay')).toBeNull();
  });

  it('disables the child and opens the upgrade dialog on click when locked', () => {
    featureState.enabled = false;
    render(
      <LockedFeature feature="report_export">
        <button type="button">Export</button>
      </LockedFeature>
    );
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    fireEvent.click(screen.getByTestId('locked-feature'));
    expect(useUpgradeDialogStore.getState()).toMatchObject({ open: true, feature: 'report_export' });
  });

  it('renders a click-capturing overlay above the disabled child when locked', () => {
    featureState.enabled = false;
    render(
      <LockedFeature feature="report_export">
        <button type="button">Export</button>
      </LockedFeature>
    );
    expect(screen.getByTestId('locked-feature-overlay')).toBeInTheDocument();
  });

  it('opens the upgrade dialog when the click lands on the overlay, not the disabled child itself', () => {
    featureState.enabled = false;
    render(
      <LockedFeature feature="report_export">
        <button type="button">Export</button>
      </LockedFeature>
    );
    fireEvent.click(screen.getByTestId('locked-feature-overlay'));
    expect(useUpgradeDialogStore.getState()).toMatchObject({ open: true, feature: 'report_export' });
  });

  it('merges an explicit disabled prop when enabled', () => {
    render(
      <LockedFeature feature="report_export" disabled>
        <button type="button">Export</button>
      </LockedFeature>
    );
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });
});
