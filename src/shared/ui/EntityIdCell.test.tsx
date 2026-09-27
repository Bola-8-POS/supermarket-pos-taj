import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@shared/lib/test-utils';
import { EntityIdCell } from './EntityIdCell';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderCell(props: React.ComponentProps<typeof EntityIdCell>) {
  return renderWithProviders(
    <MemoryRouter>
      <EntityIdCell {...props} />
    </MemoryRouter>
  );
}

/**
 * `userEvent.setup()` internally installs its own working clipboard stub
 * (`writeToClipboard: true` by default), which would silently replace any
 * mock installed beforehand. Mock `navigator.clipboard.writeText` AFTER
 * calling `userEvent.setup()` so ours takes effect for the assertion.
 */
function mockClipboardWriteText(impl: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: impl },
    configurable: true,
    writable: true,
  });
}

describe('EntityIdCell', () => {
  it('renders a payment link to /payments?id={entityId} with the full id and truncated display text', () => {
    const entityId = 'aaaaaaaa-1111-2222-3333-444444444444';
    renderCell({ entityType: 'payment', entityId });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', `/payments?id=${entityId}`);
    expect(link).toHaveTextContent(entityId.slice(0, 8));
  });

  it('renders a tab entityType linking to /payments?id={entityId} (D-03: payment and tab share the target)', () => {
    const entityId = 'bbbbbbbb-1111-2222-3333-444444444444';
    renderCell({ entityType: 'tab', entityId });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', `/payments?id=${entityId}`);
  });

  it('renders a staff link to /staff?id={entityId} with the staff aria-label pattern', () => {
    const entityId = 'cccccccc-1111-2222-3333-444444444444';
    renderCell({ entityType: 'staff', entityId });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', `/staff?id=${entityId}`);
    expect(link).toHaveAccessibleName(expect.stringContaining(entityId.slice(0, 8)));
  });

  it('renders plain copy-only mono text (no link) for a non-allowlisted entityType', () => {
    const entityId = 'dddddddd-1111-2222-3333-444444444444';
    renderCell({ entityType: 'settings', entityId });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(entityId.slice(0, 8))).toBeInTheDocument();
  });

  it('renders plain copy-only mono text (no link) for another non-allowlisted entityType (order_item)', () => {
    const entityId = 'eeeeeeee-1111-2222-3333-444444444444';
    renderCell({ entityType: 'order_item', entityId });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(entityId.slice(0, 8))).toBeInTheDocument();
  });

  it('renders an em dash placeholder and no copy button when entityId is undefined', () => {
    renderCell({ entityType: 'payment', entityId: undefined });
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('always renders a copy button that copies the FULL entityId (not the truncated display text) on click', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboardWriteText(writeText);
    const entityId = 'ffffffff-1111-2222-3333-444444444444';
    renderCell({ entityType: 'caja_session', entityId });
    await user.click(screen.getByRole('button'));
    expect(writeText).toHaveBeenCalledWith(entityId);
  });

  it('shows a success toast when clipboard write resolves', async () => {
    const { toast } = await import('sonner');
    const user = userEvent.setup();
    mockClipboardWriteText(vi.fn().mockResolvedValue(undefined));
    const entityId = 'aaaaaaaa-5555-6666-7777-888888888888';
    renderCell({ entityType: 'payment', entityId });
    await user.click(screen.getByRole('button'));
    expect(toast.success).toHaveBeenCalled();
  });

  it('shows an error toast (never a thrown/unhandled rejection) when clipboard write rejects', async () => {
    const { toast } = await import('sonner');
    const user = userEvent.setup();
    mockClipboardWriteText(vi.fn().mockRejectedValue(new Error('denied')));
    const entityId = 'bbbbbbbb-5555-6666-7777-888888888888';
    renderCell({ entityType: 'payment', entityId });
    await user.click(screen.getByRole('button'));
    expect(toast.error).toHaveBeenCalled();
  });
});
