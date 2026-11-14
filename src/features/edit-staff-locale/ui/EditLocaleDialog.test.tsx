import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Staff } from '@shared/lib/domain';

// ---------------------------------------------------------------------------
// jsdom polyfills — Radix Select uses pointer-capture APIs not implemented
// by jsdom; safe no-ops keep trigger/open/select interactions deterministic.
// ---------------------------------------------------------------------------
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

const { mutateAsyncMock, toastErrorMock, toastSuccessMock, changeLanguageMock, tMock } =
  vi.hoisted(() => ({
    mutateAsyncMock: vi.fn(),
    toastErrorMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    changeLanguageMock: vi.fn(),
    tMock: vi.fn((key: string) => key),
  }));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}));

vi.mock('@shared/lib/i18n', () => ({
  default: { changeLanguage: (...args: unknown[]) => changeLanguageMock(...args) },
}));

vi.mock('@entities/staff/model/queries', () => ({
  useMutationUpdateStaffLocale: () => ({
    mutateAsync: mutateAsyncMock,
    isPending: false,
  }),
}));

import { EditLocaleDialog } from './EditLocaleDialog';

const targetStaff: Staff = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Alex',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

describe('EditLocaleDialog', () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    changeLanguageMock.mockReset();
    tMock.mockClear();
  });

  it("opens with the target staff's current locale pre-selected and lists both locale options", async () => {
    const user = userEvent.setup();
    render(<EditLocaleDialog open onOpenChange={vi.fn()} staff={targetStaff} />);

    expect(screen.getByRole('combobox')).toHaveTextContent('es-MX');

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'es-MX' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'en-US' })).toBeInTheDocument();
  });

  it('on Save, calls useMutationUpdateStaffLocale with { staffId, locale } and on success closes + fires an interpolated success toast', async () => {
    mutateAsyncMock.mockResolvedValueOnce({ ok: true });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<EditLocaleDialog open onOpenChange={onOpenChange} staff={targetStaff} />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'en-US' }));
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

    expect(mutateAsyncMock).toHaveBeenCalledWith({ staffId: targetStaff.id, locale: 'en-US' });
    expect(tMock).toHaveBeenCalledWith('locale.updateSuccess', {
      name: targetStaff.name,
      locale: 'en-US',
    });
    expect(toastSuccessMock).toHaveBeenCalledWith('locale.updateSuccess');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('never calls i18n.changeLanguage — only the target staff record is written', async () => {
    mutateAsyncMock.mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    render(<EditLocaleDialog open onOpenChange={vi.fn()} staff={targetStaff} />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'en-US' }));
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

    expect(changeLanguageMock).not.toHaveBeenCalled();
  });

  it('WR-01 regression: remounting with a different staff.id shows that staff\'s own locale, not a carried-over selection', () => {
    const otherStaff: Staff = {
      ...targetStaff,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Sam',
      locale: 'en-US',
    };
    const { rerender } = render(
      <EditLocaleDialog key={targetStaff.id} open onOpenChange={vi.fn()} staff={targetStaff} />
    );
    expect(screen.getByRole('combobox')).toHaveTextContent('es-MX');

    // StaffDashboard remounts EditLocaleDialog per target (key={staff.id}) so
    // that a caller-provided different `staff` prop is never carried over —
    // this is the fix for WR-01 (the dialog was previously mounted once and
    // reused across targets, leaking the last-selected locale).
    rerender(
      <EditLocaleDialog key={otherStaff.id} open onOpenChange={vi.fn()} staff={otherStaff} />
    );
    expect(screen.getByRole('combobox')).toHaveTextContent('en-US');
  });

  it('on failure, fires an error toast and the dialog stays open', async () => {
    mutateAsyncMock.mockResolvedValueOnce({ ok: false, error: { message: 'nope' } });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<EditLocaleDialog open onOpenChange={onOpenChange} staff={targetStaff} />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'en-US' }));
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

    expect(toastErrorMock).toHaveBeenCalledWith('locale.updateError');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
