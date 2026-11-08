/**
 * Unit tests for PrintJobStatusBadge (Phase 19, Plan 19-06) — Test 8: renders
 * the correct translated label and icon for each of the six
 * PrintJobStatusSchema values.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PrintJobStatus } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';

import { PrintJobStatusBadge } from './PrintJobStatusBadge';

const cases: { status: PrintJobStatus; label: string; iconClass: string }[] = [
  { status: 'accepted', label: 'Queued', iconClass: 'lucide-clock' },
  { status: 'submitted_to_os', label: 'Sent to printer', iconClass: 'lucide-clock' },
  { status: 'os_reported_printed', label: 'Printed', iconClass: 'lucide-circle-check' },
  { status: 'failed', label: 'Failed', iconClass: 'lucide-circle-x' },
  { status: 'unknown', label: 'Needs confirmation', iconClass: 'lucide-triangle-alert' },
  { status: 'cancelled', label: 'Cancelled', iconClass: 'lucide-ban' },
];

describe('PrintJobStatusBadge', () => {
  it.each(cases)('renders the correct label and icon for status=$status', ({ status, label, iconClass }) => {
    const { container } = renderWithProviders(<PrintJobStatusBadge status={status} onReprint={vi.fn()} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector(`svg.${iconClass}`)).toBeInTheDocument();
  });

  it('never uses a destructive/danger color for the unknown status', () => {
    const { container } = renderWithProviders(<PrintJobStatusBadge status="unknown" onReprint={vi.fn()} />);
    const badge = container.querySelector('[role="status"]');
    expect(badge?.className).not.toMatch(/bg-destructive|pos-danger/);
    expect(badge?.className).toMatch(/warning/);
  });

  it('uses font-medium (not the shadcn Badge default font-semibold)', () => {
    const { container } = renderWithProviders(<PrintJobStatusBadge status="accepted" onReprint={vi.fn()} />);
    const badge = container.querySelector('[role="status"]');
    expect(badge?.className).toMatch(/font-medium/);
  });
});
