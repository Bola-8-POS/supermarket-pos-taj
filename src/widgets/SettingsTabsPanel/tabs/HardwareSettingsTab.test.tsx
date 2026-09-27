/**
 * Unit tests for HardwareSettingsTab — broker-submission failure-class toast
 * copy (Phase 19: Store-Local Durable Printing Service).
 *
 * Covers: runTestPrint / runOpenDrawer both routing through the shared
 * printJobErrorCopyKey() helper (pos-printer.ts, Plan 19-04) — every
 * AppErrorCode, including ones with no dedicated copy key, resolves to one
 * of the three locked common:printJobError.* translations (never the raw
 * result.error.message); a successful durable acceptance shows no toast
 * (no-success-toast rule, PRN-04/UX).
 */

import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PosPrinter from '@shared/lib/pos-printer';
import { openCashDrawer, testPrint } from '@shared/lib/pos-printer';
import { err, ok } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';

import { UnsavedChangesContext } from '../model/unsaved-changes';
import { HardwareSettingsTab } from './HardwareSettingsTab';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@shared/lib/pos-printer', async importOriginal => {
  const actual = await importOriginal<typeof PosPrinter>();
  return {
    ...actual,
    testPrint: vi.fn(),
    openCashDrawer: vi.fn(),
  };
});

vi.mock('@entities/settings', () => ({
  useReceiptSettings: () => ({ data: undefined }),
  useMutationUpdateReceiptSettings: () => ({ mutate: vi.fn() }),
}));

describe('HardwareSettingsTab — printJobError copy mapping', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(testPrint).mockReset();
    vi.mocked(openCashDrawer).mockReset();
    vi.mocked(testPrint).mockResolvedValue(ok({ jobId: 'x' }));
    vi.mocked(openCashDrawer).mockResolvedValue(ok({ jobId: 'x' }));
  });

  it('shows the translated brokerUnreachable copy on Test Print (not the raw message)', async () => {
    const user = userEvent.setup();
    vi.mocked(testPrint).mockResolvedValue(
      err({ code: 'PRINT_BROKER_UNREACHABLE', message: 'raw' })
    );
    renderWithProviders(<HardwareSettingsTab currentRole="admin" />);

    await user.click(screen.getByRole('button', { name: 'Test Print' }));

    expect(toast.error).toHaveBeenCalledWith(
      'Print service unavailable — check that the print broker is running.'
    );
  });

  it('shows the translated rejected copy on Test Print (not the raw message)', async () => {
    const user = userEvent.setup();
    vi.mocked(testPrint).mockResolvedValue(err({ code: 'PRINT_JOB_REJECTED', message: 'raw' }));
    renderWithProviders(<HardwareSettingsTab currentRole="admin" />);

    await user.click(screen.getByRole('button', { name: 'Test Print' }));

    expect(toast.error).toHaveBeenCalledWith(
      'Printer rejected this job. Check the printer name in Settings and try again.'
    );
  });

  it('shows the same brokerUnreachable copy on Open Cash Drawer (shared mapErrorToCopyKey)', async () => {
    const user = userEvent.setup();
    vi.mocked(openCashDrawer).mockResolvedValue(
      err({ code: 'PRINT_BROKER_UNREACHABLE', message: 'raw' })
    );
    renderWithProviders(<HardwareSettingsTab currentRole="admin" />);

    await user.click(screen.getByRole('button', { name: 'Open Cash Drawer' }));

    expect(toast.error).toHaveBeenCalledWith(
      'Print service unavailable — check that the print broker is running.'
    );
  });

  it('falls back to the translated failed copy (not the raw message) for a non-print AppErrorCode', async () => {
    const user = userEvent.setup();
    vi.mocked(testPrint).mockResolvedValue(err({ code: 'NETWORK_OFFLINE', message: 'offline raw' }));
    renderWithProviders(<HardwareSettingsTab currentRole="admin" />);

    await user.click(screen.getByRole('button', { name: 'Test Print' }));

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't print after several attempts. Try again or check the printer."
    );
  });

  it('does not silently discard a failed print Result and shows no toast on success', async () => {
    const user = userEvent.setup();
    vi.mocked(testPrint).mockResolvedValue(ok({ jobId: 'x' }));
    renderWithProviders(<HardwareSettingsTab currentRole="admin" />);

    await user.click(screen.getByRole('button', { name: 'Test Print' }));

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('HardwareSettingsTab — Terminal ID field', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it('saves a valid terminal id to localStorage', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HardwareSettingsTab currentRole="admin" />);

    const input = screen.getByTestId('terminal-id-input');
    await user.clear(input);
    await user.type(input, 'POS-2');
    await user.click(screen.getByTestId('terminal-id-save'));

    expect(localStorage.getItem('pos.terminal_id')).toBe('POS-2');
  });

  it('shows validation error for an invalid id and does not persist', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HardwareSettingsTab currentRole="admin" />);

    const input = screen.getByTestId('terminal-id-input');
    await user.clear(input);
    await user.type(input, 'bad id');
    await user.click(screen.getByTestId('terminal-id-save'));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(localStorage.getItem('pos.terminal_id')).toBeNull();
  });

  it('reports dirty to the unsaved-changes registry after an edit, and the registered save persists it', async () => {
    const report = vi.fn();
    const clear = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <UnsavedChangesContext.Provider value={{ report, clear }}>
        <HardwareSettingsTab currentRole="admin" />
      </UnsavedChangesContext.Provider>
    );

    const input = screen.getByTestId('terminal-id-input');
    await user.clear(input);
    await user.type(input, 'POS-2');

    expect(report).toHaveBeenLastCalledWith(true, expect.any(Function));

    const lastCall = report.mock.lastCall as [boolean, () => Promise<boolean>];
    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await lastCall[1]();
    });
    expect(saveResult).toBe(true);
    expect(localStorage.getItem('pos.terminal_id')).toBe('POS-2');
  });

  it('resolves the registered save to false when the terminal ID fails validation, and does not persist', async () => {
    const report = vi.fn();
    const clear = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <UnsavedChangesContext.Provider value={{ report, clear }}>
        <HardwareSettingsTab currentRole="admin" />
      </UnsavedChangesContext.Provider>
    );

    const input = screen.getByTestId('terminal-id-input');
    await user.clear(input);
    await user.type(input, 'bad id');

    expect(report).toHaveBeenLastCalledWith(true, expect.any(Function));

    const lastCall = report.mock.lastCall as [boolean, () => Promise<boolean>];
    let saveResult: boolean | undefined;
    await act(async () => {
      saveResult = await lastCall[1]();
    });
    expect(saveResult).toBe(false);
    expect(localStorage.getItem('pos.terminal_id')).toBeNull();
  });
});
