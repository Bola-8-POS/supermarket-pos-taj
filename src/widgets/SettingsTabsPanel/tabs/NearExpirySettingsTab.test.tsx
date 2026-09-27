import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesContext } from '../model/unsaved-changes';

const { mutateAsyncMock, toastErrorMock, toastSuccessMock, mockSettingsData } = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  // Stable object reference — useEffect([data, ...]) fires on every render if data is recreated
  mockSettingsData: {
    nearExpiry: { thresholdDays: 14, discountPercent: 15 },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

vi.mock('@entities/settings', () => ({
  useSettings: () => ({ data: mockSettingsData }),
  useMutationUpdateSetting: () => ({
    mutateAsync: mutateAsyncMock,
    mutate: mutateAsyncMock,
    isPending: false,
  }),
}));

import { NearExpirySettingsTab } from './NearExpirySettingsTab';

describe('NearExpirySettingsTab', () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    mutateAsyncMock.mockResolvedValue({ ok: true, data: null });
  });

  it('prefills the discount field from the saved setting, defaulting to 15', () => {
    render(<NearExpirySettingsTab currentRole="admin" />);
    expect(screen.getByLabelText('Near-expiry discount (%)')).toHaveValue(15);
  });

  it('saves both thresholdDays and discountPercent on the near_expiry key', async () => {
    const user = userEvent.setup();
    render(<NearExpirySettingsTab currentRole="admin" />);

    const discountInput = screen.getByLabelText('Near-expiry discount (%)');
    await user.clear(discountInput);
    await user.type(discountInput, '20');
    await user.click(screen.getByRole('button', { name: 'Save alert window' }));

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      key: 'near_expiry',
      value: { thresholdDays: 14, discountPercent: 20 },
    });
  });

  it('rejects the save silently when the discount percent is out of range', async () => {
    const user = userEvent.setup();
    render(<NearExpirySettingsTab currentRole="admin" />);

    const discountInput = screen.getByLabelText('Near-expiry discount (%)');
    await user.clear(discountInput);
    await user.type(discountInput, '150');
    await user.click(screen.getByRole('button', { name: 'Save alert window' }));

    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('reports dirty to the unsaved-changes registry after an edit, and the registered save persists', async () => {
    const report = vi.fn();
    const clear = vi.fn();
    const user = userEvent.setup();
    render(
      <UnsavedChangesContext.Provider value={{ report, clear }}>
        <NearExpirySettingsTab currentRole="admin" />
      </UnsavedChangesContext.Provider>
    );

    const discountInput = screen.getByLabelText('Near-expiry discount (%)');
    await user.clear(discountInput);
    await user.type(discountInput, '20');

    expect(report).toHaveBeenLastCalledWith(true, expect.any(Function));

    const lastCall = report.mock.lastCall as [boolean, () => Promise<boolean>];
    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await lastCall[1]();
    });
    expect(saveResult).toBe(true);
    expect(mutateAsyncMock).toHaveBeenCalledWith({
      key: 'near_expiry',
      value: { thresholdDays: 14, discountPercent: 20 },
    });
  });
});
