import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesContext } from '../model/unsaved-changes';

// ---------------------------------------------------------------------------
// jsdom polyfills — Radix Select uses pointer-capture APIs not implemented
// by jsdom; safe no-ops keep trigger/open/select interactions deterministic.
// ---------------------------------------------------------------------------
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

const { mutateAsyncMock, toastErrorMock, toastSuccessMock, changeLanguageMock, staffState } =
  vi.hoisted(() => ({
    mutateAsyncMock: vi.fn(),
    toastErrorMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    changeLanguageMock: vi.fn(),
    staffState: { locale: 'es-MX' as 'es-MX' | 'en-US' },
  }));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@shared/lib/i18n', () => ({
  default: { changeLanguage: (...args: unknown[]) => changeLanguageMock(...args) },
}));

vi.mock('@entities/staff/model/queries', () => ({
  useMutationSetOwnLocale: () => ({
    mutateAsync: mutateAsyncMock,
    isPending: false,
  }),
}));

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: (selector: (state: { currentStaff: { locale: string } | null }) => unknown) =>
    selector({ currentStaff: { locale: staffState.locale } }),
}));

import { LanguageSettingsTab } from './LanguageSettingsTab';

describe('LanguageSettingsTab', () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    changeLanguageMock.mockReset();
    staffState.locale = 'es-MX';
  });

  it('renders a Select pre-selected to the current staff locale', () => {
    render(<LanguageSettingsTab />);

    expect(screen.getByRole('combobox')).toHaveTextContent('language.option.esMX');
  });

  it('changing the Select marks dirty; Save enabled only when dirty', async () => {
    const user = userEvent.setup();
    render(<LanguageSettingsTab />);

    expect(screen.getByRole('button', { name: 'language.save' })).toBeDisabled();

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'language.option.enUS' }));

    expect(screen.getByRole('button', { name: 'language.save' })).not.toBeDisabled();
  });

  it('on successful mutation, calls i18n.changeLanguage and fires a success toast', async () => {
    mutateAsyncMock.mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    render(<LanguageSettingsTab />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'language.option.enUS' }));
    await user.click(screen.getByRole('button', { name: 'language.save' }));

    expect(mutateAsyncMock).toHaveBeenCalledWith({ locale: 'en-US' });
    expect(changeLanguageMock).toHaveBeenCalledWith('en-US');
    expect(toastSuccessMock).toHaveBeenCalledWith('language.saveSuccess');
  });

  it('on failed mutation, fires an error toast and does not revert the selection', async () => {
    mutateAsyncMock.mockResolvedValueOnce({ ok: false, error: { message: 'nope' } });
    const user = userEvent.setup();
    render(<LanguageSettingsTab />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'language.option.enUS' }));
    await user.click(screen.getByRole('button', { name: 'language.save' }));

    expect(toastErrorMock).toHaveBeenCalledWith('language.saveError');
    expect(changeLanguageMock).not.toHaveBeenCalled();
    // Form stays dirty and the selection is NOT reverted — Save is still enabled.
    expect(screen.getByRole('button', { name: 'language.save' })).not.toBeDisabled();
    expect(screen.getByRole('combobox')).toHaveTextContent('language.option.enUS');
  });

  it('reports dirty to the unsaved-changes registry after an edit, and the registered save persists', async () => {
    mutateAsyncMock.mockResolvedValueOnce({ ok: true });
    const report = vi.fn();
    const clear = vi.fn();
    const user = userEvent.setup();
    render(
      <UnsavedChangesContext.Provider value={{ report, clear }}>
        <LanguageSettingsTab />
      </UnsavedChangesContext.Provider>
    );

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'language.option.enUS' }));

    expect(report).toHaveBeenLastCalledWith(true, expect.any(Function));

    const lastCall = report.mock.lastCall as [boolean, () => Promise<boolean>];
    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await lastCall[1]();
    });
    expect(saveResult).toBe(true);
    expect(mutateAsyncMock).toHaveBeenCalledWith({ locale: 'en-US' });
  });
});
