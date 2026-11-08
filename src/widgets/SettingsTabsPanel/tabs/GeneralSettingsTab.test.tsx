import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mutateAsyncMock, toastErrorMock, toastSuccessMock, mockSettingsData } = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  mockSettingsData: {
    general: {
      storeName: 'Taj',
      address: 'Av. Revolucion 123',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      receiptFooterText: '',
      storeLogoPath: null,
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, ready: true }),
}));

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
vi.mock('@entities/settings', () => ({
  ACCEPTED_LOGO_MIME_TYPES: ['image/png'],
  useSettings: () => ({ data: mockSettingsData }),
  useMutationUpdateSetting: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
  useStoreLogoUpload: () => idle,
  useRemoveStoreLogo: () => idle,
  useStoreLogoUrl: () => ({ url: null, isLoading: false }),
}));

import { GeneralSettingsTab } from './GeneralSettingsTab';

async function typeZoneAndSave(zone: string): Promise<void> {
  const user = userEvent.setup();
  render(<GeneralSettingsTab />);
  const input = screen.getByLabelText('Timezone');
  await user.clear(input);
  await user.type(input, zone);
  await user.click(screen.getByRole('button', { name: 'Save General' }));
}

describe('GeneralSettingsTab timezone', () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
  });

  it('an unlisted timezone cannot be saved', async () => {
    await typeZoneAndSave('UTC-6');
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    // the form stays as typed (and dirty), nothing was lost
    expect(screen.getByLabelText('Timezone').getAttribute('value')).toBe('UTC-6');
  });

  it('a timezone is saved in its canonical spelling', async () => {
    mutateAsyncMock.mockResolvedValueOnce({ ok: true, data: undefined });
    await typeZoneAndSave('america/monterrey');
    expect(mutateAsyncMock).toHaveBeenCalledWith({
      key: 'general',
      value: expect.objectContaining({ timezone: 'America/Monterrey' }),
    });
  });

  it('a store-name edit saves when the stored timezone is a legacy value', async () => {
    mockSettingsData.general.timezone = 'UTC-6';
    try {
      mutateAsyncMock.mockResolvedValueOnce({ ok: true, data: undefined });
      const user = userEvent.setup();
      render(<GeneralSettingsTab />);
      const name = screen.getByLabelText('Store name');
      await user.clear(name);
      await user.type(name, 'Taj 2');
      await user.click(screen.getByRole('button', { name: 'Save General' }));
      expect(toastErrorMock).not.toHaveBeenCalled();
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        key: 'general',
        value: expect.objectContaining({ storeName: 'Taj 2', timezone: 'UTC-6' }),
      });
    } finally {
      mockSettingsData.general.timezone = 'America/Mexico_City';
    }
  });
});
