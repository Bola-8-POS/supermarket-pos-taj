import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { PrintJobFilters } from '@entities/print-job';
import { renderWithProviders } from '@shared/lib/test-utils';

import { PrintJobFilterBar } from './PrintJobFilterBar';

describe('PrintJobFilterBar', () => {
  it('calls onApply with exactly the staged filter object when "Apply filters" is clicked', async () => {
    const user = userEvent.setup();
    const staged: PrintJobFilters = { printerName: 'Front Counter', origin: 'reprint' };
    const onApply = vi.fn();

    renderWithProviders(
      <PrintJobFilterBar staged={staged} onStagedChange={vi.fn()} onApply={onApply} />
    );

    await user.click(screen.getByRole('button', { name: /apply filters/i }));

    expect(onApply).toHaveBeenCalledWith(staged);
  });

  it('staging a printer name calls onStagedChange with the merged filters object', async () => {
    const user = userEvent.setup();
    const onStagedChange = vi.fn();

    renderWithProviders(
      <PrintJobFilterBar staged={{}} onStagedChange={onStagedChange} onApply={vi.fn()} />
    );

    await user.type(screen.getByPlaceholderText(/printer name/i), 'X');

    expect(onStagedChange).toHaveBeenCalledWith({ printerName: 'X' });
  });
});
