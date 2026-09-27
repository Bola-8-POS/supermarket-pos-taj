import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePermissions } from '@entities/staff/model/usePermissions';
import type * as FeaturesModule from '@shared/lib/license/features';
import { AuditRoute } from './audit-route';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

const featureState = { enabled: true };
vi.mock('@shared/lib/license/features', async importOriginal => {
  const actual = await importOriginal<typeof FeaturesModule>();
  return {
    ...actual,
    useFeature: () => ({
      enabled: featureState.enabled,
      locked: !featureState.enabled,
      requestUpgrade: vi.fn(),
    }),
  };
});

const mockUsePermissions = vi.mocked(usePermissions);

function renderAuditRoute() {
  render(
    <MemoryRouter initialEntries={['/audit']}>
      <Routes>
        <Route path="/home" element={<div>Home page</div>} />
        <Route
          path="/audit"
          element={
            <AuditRoute>
              <div>Audit content</div>
            </AuditRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('AuditRoute', () => {
  beforeEach(() => {
    featureState.enabled = true;
  });

  it('renders children when the staff member has view_audit_log', () => {
    mockUsePermissions.mockReturnValue({ can: () => true });

    renderAuditRoute();

    expect(screen.getByText('Audit content')).toBeInTheDocument();
    expect(screen.queryByText('Home page')).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('redirects to /home and toasts when the staff member lacks view_audit_log', () => {
    mockUsePermissions.mockReturnValue({ can: () => false });

    renderAuditRoute();

    expect(screen.getByText('Home page')).toBeInTheDocument();
    expect(screen.queryByText('Audit content')).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith(
      'This page is restricted to managers and admins.'
    );
  });

  it('renders the feature-locked page when RBAC allows but the license lacks audit_log', () => {
    mockUsePermissions.mockReturnValue({ can: () => true });
    featureState.enabled = false;

    renderAuditRoute();

    const lockedPage = screen.getByTestId('feature-locked-page');
    expect(lockedPage).toHaveAttribute('data-feature', 'audit_log');
    expect(screen.queryByText('Audit content')).not.toBeInTheDocument();
    expect(screen.queryByText('Home page')).not.toBeInTheDocument();
  });
});
